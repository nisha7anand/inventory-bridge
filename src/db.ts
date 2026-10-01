import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

export const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT) || 5432,
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'inventory_bridge',
});

const MOCK_PRODUCTS = [
  { name: 'Classic Cotton T-Shirt', sku: 'TSHIRT-001', qty: 50 },
  { name: 'Insulated Steel Water Bottle', sku: 'BOTTLE-002', qty: 40 },
  { name: 'Wireless Ergonomic Mouse', sku: 'MOUSE-003', qty: 30 },
  { name: 'Canvas Tote Bag', sku: 'TOTE-004', qty: 60 },
  { name: 'Scented Soy Candle', sku: 'CANDLE-005', qty: 25 },
];

/**
 * Runs schema.sql against the DB, then seeds 5 mock products
 * (only if the products table is currently empty).
 */
export async function initializeDatabase(): Promise<void> {
  const schemaPath = path.join(__dirname, '..', 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');

  await pool.query(schemaSql);
  console.log('[db] Schema ensured (products, sale_events).');

  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM products');
  if (rows[0].count > 0) {
    console.log(`[db] Products table already has ${rows[0].count} rows — skipping seed.`);
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of MOCK_PRODUCTS) {
      // On initial seed, every channel mirrors the full central quantity.
      await client.query(
        `INSERT INTO products
           (name, sku, central_quantity, shopify_quantity, amazon_quantity, instore_quantity)
         VALUES ($1, $2, $3, $3, $3, $3)`,
        [p.name, p.sku, p.qty]
      );
    }
    await client.query('COMMIT');
    console.log(`[db] Seeded ${MOCK_PRODUCTS.length} mock products.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
