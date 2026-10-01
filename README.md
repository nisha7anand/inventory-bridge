# Inventory Sync Bridge (Mock)

Simulates a central inventory database bridging Shopify, Amazon, and an
in-person store counter.

## Setup

```bash
npm install
cp .env.example .env   # edit with your local Postgres credentials
createdb inventory_bridge
npm run dev             # or: npm run build && npm start
```

On boot the server runs `schema.sql` automatically, then seeds 5 mock
products (only if the table is empty).

## What it does

- Every **30 seconds**, a background job picks a random in-stock product
  and a random channel (`shopify`, `amazon`, or `instore`), then deducts
  1 unit from `central_quantity` and mirrors that deduction onto the
  originating channel's own quantity column.
- Every deduction goes through `processSaleEvent()` in `src/saleService.ts`,
  which wraps the read + update in a transaction using
  `SELECT ... FOR UPDATE` to lock the product row. This prevents two
  simultaneous sales from both reading the same stock count and both
  succeeding when only one unit remains (overselling).
- Every sale is logged to the `sale_events` table for a full audit trail.

## Endpoints

| Method | Path            | Description                              |
|--------|-----------------|-------------------------------------------|
| GET    | `/health`       | Health check                              |
| GET    | `/products`     | List all products + quantities            |
| GET    | `/sale-events`  | Recent sale log (`?limit=`)               |
| POST   | `/sale`         | Manually trigger a sale: `{ productId, channel }` |

## Files

- `schema.sql` — `products` + `sale_events` tables
- `src/db.ts` — connection pool, schema init, mock product seeding
- `src/saleService.ts` — concurrency-safe sale deduction logic
- `src/server.ts` — Express app + 30s random sale simulator
- `src/types.ts` — shared types
