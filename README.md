# Shopify Connector (`effortless-node-shopify`)

An Effortless **add-in seed** (kind `child`), mounted at `node-shopify/`. Requires the
`rulebook-backend` add-in. Drop it into a project and the store's products, customers and orders
are rulebook tables: queryable, extendable with derived fields, behind the same generated API.

## What you get

- `rulebook/`: `ShopifyProducts`, `ShopifyCustomers`, `ShopifyOrders` (+ derived fields), merged with `scripts/merge-rulebook.mjs`.
- `server/`: `registerShopify(app, { pool })` for the generated Express API. Zero runtime dependencies.
  - sign-in three ways: client credentials (own organization), OAuth install, static token
  - incremental Admin GraphQL sync: pagination, throttling, only what changed
  - webhooks: signature over the raw body, one action per delivery, the three privacy topics handled
  - the access token and the webhook ledger live in a private `shopify` schema
- `ui/`: `<shopify-admin>`: status, Sync now, Subscribe to webhooks, recent runs.
- `INTEGRATE.md`: the wiring, written for Claude to follow.

## Questions

| Key | Default | Used for |
|---|---|---|
| `shopifyDomain` | blank | `shopify.config.json`: the store |
| `shopifyClientId` | blank | `shopify.config.json` |
| `shopifyClientSecret` | blank, **secret, persisted** | read from the environment at run time (`SHOPIFY_CLIENT_SECRET`) |
| `shopifyAuthMode` | `client_credentials` | how the app signs in |
| `shopifyScopes` | `read_products,read_customers,read_orders` | OAuth scopes |
| `shopifyApiVersion` | `2026-07` | Admin API version |
| `shopifyAppUrl` | blank | webhook callback and OAuth redirect |

## How it is used

```bash
effortless cloneSeed effortlessapi/effortless-node-shopify node-shopify
rm -rf node-shopify/.git
# then follow node-shopify/INTEGRATE.md
```

Works with or without the `effortless-magic-links` seed: with it, the admin API is for its admins and
the token is unreachable to signed-in people; without it, the admin API is open outside beta/production
and closed inside them.
