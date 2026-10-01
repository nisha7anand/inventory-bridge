import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool, initializeDatabase } from './db';
import { CHANNELS, Channel } from './types';
import {
  processSaleEvent,
  pickRandomInStockProductId,
  InsufficientStockError,
} from './saleService';
import { inventoryRouter } from './inventoryRouter';
dotenv.config();

const app = express();
app.use(cors()); // allows the Flutter app (or any browser client) to call this API
app.use(express.json());
app.use('/api/inventory', inventoryRouter);

const PORT = Number(process.env.PORT) || 3000;
const SALE_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});
app.use('/api', inventoryRouter); 
// List all products with current central + per-channel quantities.
app.get('/products', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    'SELECT * FROM products ORDER BY id ASC'
  );
  res.json(rows);
});

// Recent sale event log, most recent first.
app.get('/sale-events', async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 20, 200);
  const { rows } = await pool.query(
    `SELECT se.id, se.channel, se.quantity_deducted, se.resulting_central_quantity,
            se.created_at, p.sku, p.name
       FROM sale_events se
       JOIN products p ON p.id = se.product_id
      ORDER BY se.created_at DESC
      LIMIT $1`,
    [limit]
  );
  res.json(rows);
});

// Manually trigger a sale for a specific product/channel (useful for testing).
app.post('/sale', async (req: Request, res: Response) => {
  const { productId, channel } = req.body as { productId?: number; channel?: Channel };

  if (!productId || !channel || !CHANNELS.includes(channel)) {
    return res.status(400).json({
      error: `Body must include productId (number) and channel (one of ${CHANNELS.join(', ')})`,
    });
  }

  try {
    const result = await processSaleEvent(productId, channel);
    res.json(result);
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      return res.status(409).json({ error: err.message });
    }
    console.error('[POST /sale] error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------
// Mock sale simulator — fires every 30 seconds from a random channel
// against a random in-stock product.
// ---------------------------------------------------------------------

function randomChannel(): Channel {
  return CHANNELS[Math.floor(Math.random() * CHANNELS.length)];
}

async function simulateRandomSale(): Promise<void> {
  try {
    const productId = await pickRandomInStockProductId();
    if (productId === null) {
      console.log('[simulator] All products sold out — nothing to deduct.');
      return;
    }

    const channel = randomChannel();
    const result = await processSaleEvent(productId, channel);

    console.log(
      `[simulator] ${channel.toUpperCase()} sold 1x "${result.sku}" ` +
      `→ central_quantity ${result.centralQuantityBefore} → ${result.centralQuantityAfter}`
    );
  } catch (err) {
    // A race between the "pick random product" read and another concurrent
    // sale draining it to zero is handled gracefully — just skip this tick.
    if (err instanceof InsufficientStockError) {
      console.log(`[simulator] Skipped tick: ${err.message}`);
      return;
    }
    console.error('[simulator] Unexpected error:', err);
  }
}

function startSaleSimulator(): NodeJS.Timeout {
  console.log(`[simulator] Starting — a random sale will fire every ${SALE_INTERVAL_MS / 1000}s.`);
  return setInterval(simulateRandomSale, SALE_INTERVAL_MS);
}

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------

async function main() {
  await initializeDatabase();

  const server = app.listen(PORT, () => {
    console.log(`[server] Inventory bridge listening on http://localhost:${PORT}`);
  });

  const simulatorHandle = startSaleSimulator();

  const shutdown = async () => {
    console.log('\n[server] Shutting down...');
    clearInterval(simulatorHandle);
    server.close();
    await pool.end();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[server] Fatal error during startup:', err);
  process.exit(1);
});
