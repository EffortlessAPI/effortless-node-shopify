# Integrating this seed (for Claude, or anyone with fifteen minutes)

You are in `node-shopify/` inside a project that already has the **Backend API** add-in
(`backend/api` with `custom.js`, `backend/postgres`). Do these in order; each step says how to know it
worked. The store's data is copied in; Shopify stays the source of it.

## 0. Ask the person three things, then do the rest without asking

1. "What is the store's address (`something.myshopify.com`)?"
2. "Is the Shopify app owned by the same Shopify organization as the store?" Yes: use
   `client_credentials` (no install step). No, a merchant installs it: use `oauth`. A legacy custom-app
   `shpat_` token: use `token`.
3. "Do you have the app's client id and client secret?" (Shopify Dev Dashboard -> the app -> Settings.)
   If not: they create the app there, choose the scopes (default `read_products,read_customers,read_orders`),
   release a version, and install it on the store. **The secret goes in the environment, never in a file
   or in chat history you save.**

## 1. The tables (the rulebook)

```bash
node node-shopify/scripts/merge-rulebook.mjs --rulebook effortless-rulebook/effortless-rulebook.json          # dry run
# editing the rulebook is a change to the project's source of truth: say what it adds, then --write
node node-shopify/scripts/merge-rulebook.mjs --rulebook effortless-rulebook/effortless-rulebook.json --write
effortless build
```

Adds `ShopifyProducts`, `ShopifyCustomers`, `ShopifyOrders` (an order points at its customer; each table
has derived fields you can extend). Works when `select count(*) from vw_shopify_orders` runs.

## 2. The API (one edit, in the file rebuilds never overwrite)

In `backend/api/custom.js`:

```js
import { registerShopify } from '../../node-shopify/server/index.js';
import { pool } from './db.js';
// ...
export default function registerCustom(app) {
  registerShopify(app, { pool });
  // ...whatever was already here (and registerMagicLinks, if that seed is in: order does not matter)
```

Environment for the API process (see `shopify.config.json` for the public values):

| Variable | Needed for |
|---|---|
| `SHOPIFY_SHOP` | always (or `shop` in `shopify.config.json`) |
| `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | client_credentials and oauth; the secret also verifies webhooks in every mode that has one |
| `SHOPIFY_ACCESS_TOKEN` | token mode |
| `SHOPIFY_APP_URL` | oauth, and webhooks: the public **https** address of this app |
| `SHOPIFY_AUTH_MODE`, `SHOPIFY_API_VERSION`, `SHOPIFY_SCOPES` | override the config file |

Works when the API log says `shopify: ready (...)` and names anything still missing, and
`curl localhost:<port>/api/shopify/status` shows the shop with `"problems":[]`.
(Outside beta/production that route is open when nothing authenticates; in production with no auth in
front of it, it answers 403. With the magic-links seed it is for admins.)

## 3. First sync

`POST /api/shopify/sync` (or the **Sync now** button). Customers, then products, then orders, a page of
100 at a time, waiting out Shopify's throttling. Later syncs ask only for what changed
(`updated_at >= the newest row seen`). Works when the counts in `/api/shopify/status` match the store.
In `oauth` mode open `/shopify/install` once first; Shopify returns to `/shopify/callback`, and
`SHOPIFY_APP_URL/shopify/callback` must be listed as an allowed redirect URL on the app.

## 4. Webhooks (keep it current without polling)

`POST /api/shopify/webhooks/register` subscribes the nine topics to `SHOPIFY_APP_URL/shopify/webhooks`
(needs https, so after publishing, or through a tunnel in dev). The three **privacy** topics
(`customers/data_request`, `customers/redact`, `shop/redact`) are configured on the app in the Dev
Dashboard, same callback URL; this seed handles them: redaction erases the rows, a data request is kept in
`shopify.webhook_events` for the merchant to answer. Works when changing a product title in Shopify
changes it here within seconds.

## 5. The app

Load `/shopify/ui/shopify-ui.js` and put `<shopify-admin></shopify-admin>` in the admin area (proxy
`/shopify` and `/api` to the API in dev). Read the tables like any other: `vw_shopify_products` etc.,
through the generated routes, row-level security included when the magic-links seed is installed.

## What not to do

- Don't use the editor's **Save changes** while Shopify data is in these tables: it merges database edits
  back into `effortless-rulebook.json`, which would copy the store's customers into your repo. Keep the
  tables' `data` empty in the rulebook; they are filled at run time.
- Don't edit these rows by hand: the next sync overwrites them. Change things in Shopify, or add derived
  fields to the tables.
- Don't read the token: it lives in schema `shopify` (table `shopify.shops`), which the magic-links
  request role has no access to. Keep it that way: never `GRANT` on that schema.
- Don't move the webhook route or add a body parser in front of it: it is registered ahead of
  `express.json()` on purpose (a signature covers the exact bytes; re-serialised JSON never matches).
- One store per project. A second store is a second project.

## Limits worth knowing

- Orders older than 60 days need the `read_all_orders` scope, which Shopify grants by request.
- Customer and order data for a *public* app needs Shopify's protected customer data approval.
- The Admin API version (`2026-07` here) is supported for about a year; bump `apiVersion` in
  `shopify.config.json` and run the tests. Shopify serves the oldest supported version if yours is retired.
- Very large stores: the sync pages through GraphQL connections; Shopify's bulk operations are not used.
- The OAuth access token is stored as plain text in the private schema. If that is not enough for you,
  use client_credentials (nothing stored beyond the process) or encrypt the column.

## Tests

`npm install && npm test` here (needs Postgres where it can create databases:
`SH_TEST_PG=postgres://user@host:port/postgres`). 11 tests against a stand-in Shopify: pagination,
throttling, incremental sync, signatures over raw bytes, duplicate deliveries, the privacy webhooks, OAuth.
