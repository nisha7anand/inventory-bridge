import { pool } from './db';
import { Channel } from './types';

export class InsufficientStockError extends Error {
  constructor(sku: string) {
    super(`Insufficient stock to fulfil sale for SKU "${sku}"`);
    this.name = 'InsufficientStockError';
  }
}

export interface SaleResult {
  productId: number;
  sku: string;
  channel: Channel;
  centralQuantityBefore: number;
  centralQuantityAfter: number;
}

/**
 * Processes a single-unit sale event from a channel against a product.
 *
 * Concurrency safety:
 *  - Wrapped in a DB transaction.
 *  - Uses `SELECT ... FOR UPDATE` to take a row-level lock on the product,
 *    so two simultaneous sale events for the same product can never both
 *    read the same stale quantity and both succeed when only one unit
 *    is actually left (classic race condition / overselling bug).
 *  - Central quantity has a CHECK (>= 0) constraint as a hard backstop.
 *  - Every deduction is written to sale_events for auditability.
 */
export async function processSaleEvent(
  productId: number,
  channel: Channel
): Promise<SaleResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT id, sku, central_quantity FROM products WHERE id = $1 FOR UPDATE',
      [productId]
    );

    if (rows.length === 0) {
      throw new Error(`Product ${productId} not found`);
    }

    const product = rows[0];
    const centralBefore: number = product.central_quantity;

    if (centralBefore < 1) {
      await client.query('ROLLBACK');
      throw new InsufficientStockError(product.sku);
    }

    const centralAfter = centralBefore - 1;

    // All three channel columns are kept mirrored to the new central
    // total — that's what "synced" inventory actually means. If only the
    // originating channel's number moved, the other channels would keep
    // displaying stale (higher) stock until they happened to sell too.
    await client.query(
      `UPDATE products
         SET central_quantity = GREATEST(central_quantity - 1, 0),
             shopify_quantity = GREATEST(central_quantity - 1, 0),
             amazon_quantity  = GREATEST(central_quantity - 1, 0),
             instore_quantity = GREATEST(central_quantity - 1, 0)
       WHERE id = $1`,
      [productId]
    );

    await client.query(
      `INSERT INTO sale_events (product_id, channel, quantity_deducted, resulting_central_quantity)
       VALUES ($1, $2, 1, $3)`,
      [productId, channel, centralAfter]
    );

    await client.query('COMMIT');

    return {
      productId,
      sku: product.sku,
      channel,
      centralQuantityBefore: centralBefore,
      centralQuantityAfter: centralAfter,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Picks a random in-stock product id, or null if everything is sold out. */
export async function pickRandomInStockProductId(): Promise<number | null> {
  const { rows } = await pool.query(
    'SELECT id FROM products WHERE central_quantity > 0 ORDER BY random() LIMIT 1'
  );
  return rows.length > 0 ? rows[0].id : null;
}