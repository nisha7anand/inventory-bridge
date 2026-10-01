import { Router, Request, Response } from 'express';
import { pool } from './db';
import { CHANNELS, Product, InventorySyncRequest, InventorySyncResponse, ApiErrorResponse } from './types';
import {
  syncInventory,
  ProductNotFoundError,
  InsufficientStockError,
} from './inventoryService';

export const inventoryRouter = Router();

/**
 * GET /api/products
 * Fetch all current inventory levels (central + per-channel).
 */
inventoryRouter.get('/products', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query<Product>(
      'SELECT * FROM products ORDER BY id ASC'
    );
    res.json({ success: true, products: rows });
  } catch (err) {
    console.error('[GET /api/products] error:', err);
    const body: ApiErrorResponse = { success: false, error: 'Internal server error' };
    res.status(500).json(body);
  }
});

/**
 * POST /api/inventory/sync
 * Body: { sku: string, quantitySold: number, sourceChannel: Channel }
 *
 * Decrements central stock for the given SKU inside a SQL transaction,
 * logs a history event, and simulates broadcasting the updated stock
 * level back out to the other sales channels.
 */
inventoryRouter.post('/inventory/sync', async (req: Request, res: Response) => {
  const { sku, quantitySold, sourceChannel } = req.body as Partial<InventorySyncRequest>;

  if (!sku || typeof sku !== 'string') {
    const body: ApiErrorResponse = { success: false, error: '"sku" is required and must be a string' };
    return res.status(400).json(body);
  }
  if (typeof quantitySold !== 'number' || !Number.isInteger(quantitySold) || quantitySold <= 0) {
    const body: ApiErrorResponse = {
      success: false,
      error: '"quantitySold" is required and must be a positive integer',
    };
    return res.status(400).json(body);
  }
  if (!sourceChannel || !CHANNELS.includes(sourceChannel)) {
    const body: ApiErrorResponse = {
      success: false,
      error: `"sourceChannel" is required and must be one of: ${CHANNELS.join(', ')}`,
    };
    return res.status(400).json(body);
  }

  try {
    const result = await syncInventory(sku, quantitySold, sourceChannel);

    const responseBody: InventorySyncResponse = {
      success: true,
      product: result.product,
      historyEvent: result.historyEvent,
      broadcasts: result.broadcasts,
    };
    res.json(responseBody);
  } catch (err) {
    if (err instanceof ProductNotFoundError) {
      const body: ApiErrorResponse = { success: false, error: err.message };
      return res.status(404).json(body);
    }
    if (err instanceof InsufficientStockError) {
      const body: ApiErrorResponse = { success: false, error: err.message };
      return res.status(409).json(body);
    }
    if (err instanceof RangeError) {
      const body: ApiErrorResponse = { success: false, error: err.message };
      return res.status(400).json(body);
    }

    console.error('[POST /api/inventory/sync] error:', err);
    const body: ApiErrorResponse = { success: false, error: 'Internal server error' };
    res.status(500).json(body);
  }
});