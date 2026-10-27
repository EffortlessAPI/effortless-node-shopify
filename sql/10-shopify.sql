-- 10-shopify.sql  (effortless-node-shopify)
--
-- Everything the seed keeps that must NOT be a rulebook table lives in its own schema, "shopify":
-- the access token, the webhook ledger and the sync bookkeeping. The magic-links seed grants its
-- request role access to schema public only, so no signed-in person can read a Shopify token
-- through a generated route. Idempotent: safe on every boot.

CREATE SCHEMA IF NOT EXISTS shopify;
REVOKE ALL ON SCHEMA shopify FROM PUBLIC;

CREATE TABLE IF NOT EXISTS shopify.shops (
  shop         text PRIMARY KEY,                -- my-store.myshopify.com
  access_token text,
  scopes       text,
  auth_mode    text NOT NULL,
  expires_at   timestamptz,
  installed_at timestamptz NOT NULL DEFAULT now()
);

-- One row per webhook delivery (X-Shopify-Webhook-Id): Shopify retries and may repeat, we act once.
CREATE TABLE IF NOT EXISTS shopify.webhook_events (
  webhook_id   text PRIMARY KEY,
  topic        text NOT NULL,
  shop         text,
  payload      jsonb,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error        text
);

-- How far each resource has been copied. The next sync asks Shopify only for what changed after it.
CREATE TABLE IF NOT EXISTS shopify.sync_state (
  resource        text PRIMARY KEY,
  last_updated_at timestamptz,
  last_run_at     timestamptz
);

CREATE TABLE IF NOT EXISTS shopify.sync_runs (
  id          bigserial PRIMARY KEY,
  resource    text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text NOT NULL DEFAULT 'running',   -- running | ok | failed
  rows        integer NOT NULL DEFAULT 0,
  message     text
);
