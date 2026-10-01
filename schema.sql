-- =========================================================
-- Multi-Store Inventory Synchronization Bridge — Schema
-- =========================================================

CREATE TABLE IF NOT EXISTS products (
    id                  SERIAL PRIMARY KEY,
    name                VARCHAR(255)    NOT NULL,
    sku                 VARCHAR(64)     NOT NULL UNIQUE,

    -- Central source of truth. This is what all channels sync FROM.
    central_quantity    INTEGER         NOT NULL DEFAULT 0
                         CHECK (central_quantity >= 0),

    -- Per-channel mirrored quantities (what each storefront currently
    -- displays/believes it has, updated after each sync).
    shopify_quantity    INTEGER         NOT NULL DEFAULT 0
                         CHECK (shopify_quantity >= 0),
    amazon_quantity     INTEGER         NOT NULL DEFAULT 0
                         CHECK (amazon_quantity >= 0),
    instore_quantity    INTEGER         NOT NULL DEFAULT 0
                         CHECK (instore_quantity >= 0),

    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT now()
);

-- Keep updated_at fresh automatically on every row change.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_products_updated_at ON products;
CREATE TRIGGER trg_products_updated_at
    BEFORE UPDATE ON products
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- Audit log of every sale event processed by the bridge — useful for
-- debugging race conditions, replaying history, and proving that
-- deductions were applied exactly once.
CREATE TABLE IF NOT EXISTS sale_events (
    id                  BIGSERIAL PRIMARY KEY,
    product_id          INTEGER         NOT NULL REFERENCES products(id),
    channel             VARCHAR(20)     NOT NULL
                         CHECK (channel IN ('shopify', 'amazon', 'instore')),
    quantity_deducted   INTEGER         NOT NULL DEFAULT 1,
    resulting_central_quantity INTEGER  NOT NULL,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sale_events_product_id ON sale_events(product_id);
CREATE INDEX IF NOT EXISTS idx_sale_events_created_at ON sale_events(created_at);
