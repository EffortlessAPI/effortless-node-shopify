-- What rulebook-to-postgres generates for rulebook/shopify.fragment.json (columns, types, the foreign key).
CREATE TABLE shopify_customers (
  shopify_customer_id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT, orders_count INTEGER,
  total_spent NUMERIC, currency_code TEXT, state TEXT, shopify_updated_at TIMESTAMPTZ);
CREATE TABLE shopify_orders (
  shopify_order_id TEXT PRIMARY KEY, order_name TEXT, shopify_customer TEXT REFERENCES shopify_customers (shopify_customer_id),
  email TEXT, financial_status TEXT, fulfillment_status TEXT, total_price NUMERIC, currency_code TEXT,
  processed_at TIMESTAMPTZ, shopify_updated_at TIMESTAMPTZ);
CREATE TABLE shopify_products (
  shopify_product_id TEXT PRIMARY KEY, title TEXT, handle TEXT, status TEXT, vendor TEXT, product_type TEXT,
  total_inventory INTEGER, price_min NUMERIC, price_max NUMERIC, currency_code TEXT, shopify_updated_at TIMESTAMPTZ);
