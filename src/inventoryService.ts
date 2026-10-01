import { pool } from './db';
import {
  Channel,
  CHANNEL_COLUMN,
  Product,
  InventoryHistoryEvent,
  ChannelBroadcastResult,
} from './types';

export class ProductNotFoundError extends Error {
  constructor(sku: string) {
    super(`No product found with SKU "${sku}"`);
    this.name = 'ProductNotFoundError';
  }
}

export class InsufficientStockError extends Error {
  constructor(sku: string, requested: number, available: number) {
    super(
      `Insufficient stock for SKU "${sku}": requested ${requested}, only ${available} available`
    );
    this.name = 'InsufficientStockError';
  }
}

export interface SyncResult {
  product: Product;
  historyEvent: InventoryHistoryEvent;
  broadcasts: ChannelBroadcastResult[];
}

/**
 * Syncs an inventory sale by SKU: safely decrements central_quantity and
 * the originating channel's mirrored quantity, logs a history event, and
 * simulates broadcasting the new stock level out to the other channels.
 *
 * Safety:
 *  - Runs inside a single DB transaction.
 *  - Locks the product row with `SELECT ... FOR UPDATE` so concurrent
 *    sync requests for the same SKU can't both read a stale quantity
 *    and both succeed when stock is insufficient for both.
 *  - Validates quantitySold and rejects the sync (with ROLLBACK) if
 *    stock would go negative — the DB's CHECK constraint is a backstop,
 *    but we fail fast here with a clear error instead.
 */
export async function syncInventory(
  sku: string,
  quantitySold: number,
  sourceChannel: Channel
): Promise<SyncResult> {
  if (!Number.isInteger(quantitySold) || quantitySold <= 0) {
    throw new RangeError('quantitySold must be a positive integer');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT * FROM products WHERE sku = $1 FOR UPDATE',
      [sku]
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      throw new ProductNotFoundError(sku);
    }

    const before = rows[0] as Product;

    if (before.central_quantity < quantitySold) {
      await client.query('ROLLBACK');
      throw new InsufficientStockError(sku, quantitySold, before.central_quantity);
    }

    // Every channel column is kept mirrored to the new central total —
    // that IS what "synced" means. Previously only the source channel's
    // column was decremented, which let central drift below the other
    // channels' displayed stock (they'd still show the OLD, higher number
    // until something sold there too). This update writes the same new
    // quantity into central AND all three channel columns in one go.
    const updateResult = await client.query(
      `UPDATE products
         SET central_quantity = GREATEST(central_quantity - $2, 0),
             shopify_quantity = GREATEST(central_quantity - $2, 0),
             amazon_quantity  = GREATEST(central_quantity - $2, 0),
             instore_quantity = GREATEST(central_quantity - $2, 0)
       WHERE id = $1
       RETURNING *`,
      [before.id, quantitySold]
    );
    const updated = updateResult.rows[0] as Product;

    const historyResult = await client.query(
      `INSERT INTO sale_events (product_id, channel, quantity_deducted, resulting_central_quantity)
       VALUES ($1, $2, $3, $4)
       RETURNING id, product_id, channel, quantity_deducted, resulting_central_quantity, created_at`,
      [before.id, sourceChannel, quantitySold, updated.central_quantity]
    );
    const historyRow = historyResult.rows[0];

    await client.query('COMMIT');

    const historyEvent: InventoryHistoryEvent = {
      id: historyRow.id,
      productId: historyRow.product_id,
      sku: updated.sku,
      channel: historyRow.channel,
      quantityDeducted: historyRow.quantity_deducted,
      resultingCentralQuantity: historyRow.resulting_central_quantity,
      createdAt: historyRow.created_at,
    };

    // Simulated broadcast: in a real system this is where you'd call out
    // to the Shopify/Amazon/POS APIs to push the new stock level. Here we
    // just log it, "broadcasting" to every channel EXCEPT the one the
    // sale originated from (that channel already knows — it just sold it).
    const broadcasts = broadcastUpdatedStock(updated, sourceChannel);

    return { product: updated, historyEvent, broadcasts };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Simulates pushing the new central stock level out to every channel
 * other than the one that originated the sale. Logs each broadcast and
 * returns a structured result per channel.
 */
function broadcastUpdatedStock(
  product: Product,
  sourceChannel: Channel
): ChannelBroadcastResult[] {
  const targets = (Object.keys(CHANNEL_COLUMN) as Channel[]).filter(
    (c) => c !== sourceChannel
  );

  return targets.map((channel) => {
    console.log(
      `[broadcast] -> ${channel.toUpperCase()}: SKU "${product.sku}" ` +
      `updated to ${product.central_quantity} units (synced from ${sourceChannel}).`
    );
    return {
      channel,
      broadcastQuantity: product.central_quantity,
      status: 'broadcasted' as const,
    };
  });
}