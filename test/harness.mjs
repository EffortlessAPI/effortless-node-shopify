// A real Express app with the seed registered (after express.json(), like the generated API),
// plus a stand-in for Shopify: token endpoint, Admin GraphQL, throttling, pagination.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import pg from 'pg';
import { registerShopify } from '../server/index.js';

export const SECRET = 'shpss_test_secret';
export const SHOP = 'demo-store.myshopify.com';
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const iso = (n) => `2026-10-0${n}T10:00:00Z`;

export async function stubShopify() {
  const state = {
    tokenRequests: [], queries: [], throttleOnce: true, token: 'tok_1',
    products: [1, 2, 3].map((i) => ({ id: `gid://shopify/Product/${i}`, title: `Product ${i}`, handle: `p-${i}`, status: i === 3 ? 'DRAFT' : 'ACTIVE', vendor: 'Acme', productType: 'Mug', totalInventory: 10 * i, updatedAt: iso(i), priceRangeV2: { minVariantPrice: { amount: '5.00', currencyCode: 'USD' }, maxVariantPrice: { amount: '9.50', currencyCode: 'USD' } } })),
    customers: [1, 2, 3].map((i) => ({ id: `gid://shopify/Customer/${i}`, email: `c${i}@example.com`, firstName: 'C', lastName: String(i), numberOfOrders: String(i), amountSpent: { amount: String(10 * i), currencyCode: 'USD' }, state: 'ENABLED', updatedAt: iso(i) })),
    orders: [
      { id: 'gid://shopify/Order/101', name: '#1001', email: 'c1@example.com', processedAt: iso(1), updatedAt: iso(1), displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED', totalPriceSet: { shopMoney: { amount: '20.00', currencyCode: 'USD' } }, customer: { id: 'gid://shopify/Customer/1' } },
      { id: 'gid://shopify/Order/102', name: '#1002', email: 'c2@example.com', processedAt: iso(2), updatedAt: iso(2), displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED', totalPriceSet: { shopMoney: { amount: '35.50', currencyCode: 'USD' } }, customer: { id: 'gid://shopify/Customer/2' } },
      { id: 'gid://shopify/Order/103', name: '#1003', email: 'guest@example.com', processedAt: iso(3), updatedAt: iso(3), displayFinancialStatus: 'PENDING', displayFulfillmentStatus: 'UNFULFILLED', totalPriceSet: { shopMoney: { amount: '7.00', currencyCode: 'USD' } }, customer: null },
      { id: 'gid://shopify/Order/104', name: '#1004', email: 'ghost@example.com', processedAt: iso(4), updatedAt: iso(4), displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED', totalPriceSet: { shopMoney: { amount: '12.00', currencyCode: 'USD' } }, customer: { id: 'gid://shopify/Customer/999' } },
    ],
    subscriptions: [], nodeCalls: 0,
  };
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const out = (code, o, h = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
    if (req.url === '/admin/oauth/access_token') {
      const body = (req.headers['content-type'] || '').includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
      state.tokenRequests.push(body);
      if (body.grant_type === 'client_credentials' && body.client_secret !== SECRET) return out(400, { error: 'invalid_client' });
      if (body.code && body.code !== 'good-code') return out(400, { error: 'bad_code' });
      return out(200, { access_token: state.token, scope: 'read_products,read_customers,read_orders', expires_in: 86399 });
    }
    if (req.url.startsWith('/admin/api/2026-07/graphql.json')) {
      if (req.headers['x-shopify-access-token'] !== state.token) return out(401, { errors: 'Invalid API key or access token' });
      const { query, variables } = JSON.parse(raw);
      state.queries.push({ query, variables });
      if (state.throttleOnce && /customers\(/.test(query)) { state.throttleOnce = false; return out(200, { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }); }
      if (/webhookSubscriptionCreate/.test(query)) {
        state.subscriptions.push(variables.topic);
        return out(200, { data: { webhookSubscriptionCreate: { webhookSubscription: { id: 'gid://shopify/WebhookSubscription/1' }, userErrors: variables.topic === 'ORDERS_DELETE' ? [{ field: ['topic'], message: 'Address for this topic has already been taken' }] : [] } } });
      }
      if (/node\(id/.test(query)) {
        state.nodeCalls++;
        const all = [...state.products, ...state.customers, ...state.orders];
        return out(200, { data: { node: all.find((n) => n.id === variables.id) || null } });
      }
      const key = ['products', 'customers', 'orders'].find((k) => new RegExp(`${k}\\(`).test(query));
      const since = (variables.query || '').match(/'([^']+)'/)?.[1];
      let rows = state[key].filter((n) => !since || n.updatedAt >= since);
      const start = variables.after ? Number(variables.after) : 0;
      const page = rows.slice(start, start + variables.first);
      const more = start + variables.first < rows.length;
      return out(200, { data: { [key]: { pageInfo: { hasNextPage: more, endCursor: String(start + variables.first) }, nodes: page } } });
    }
    out(404, { error: 'not_found' });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, state, close: () => { server.close(); server.closeAllConnections?.(); } };
}

export async function bootApp({ dbUrl, shopify, env = {}, config = {}, authorize, middleware, pageSize = 2 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shseed-'));
  fs.writeFileSync(path.join(dir, 'shopify.config.json'), JSON.stringify({ shop: SHOP, pageSize, appUrl: 'https://app.example.com', ...config }));
  const pool = new pg.Pool({ connectionString: dbUrl, max: 4 });
  const app = express();
  app.use(express.json());                     // like the generated API: this eats a webhook body unless the route goes first
  if (middleware) app.use(middleware);
  const silent = { log() {}, error() {}, warn() {} };
  const seed = registerShopify(app, { pool, dir, baseUrl: shopify?.url, sleep: async () => {}, authorize, log: silent,
    env: { SHOPIFY_CLIENT_ID: 'cid', SHOPIFY_CLIENT_SECRET: SECRET, ...env } });
  const server = http.createServer(app);
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  await seed.ready;
  return { base, seed, pool, dir, close: async () => { seed.stop(); server.close(); server.closeAllConnections?.(); await pool.end(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

export const sign = (body, secret = SECRET) => crypto.createHmac('sha256', secret).update(body).digest('base64');

export async function webhook(app, topic, payload, { id = crypto.randomUUID(), secret = SECRET, shop = SHOP, body } = {}) {
  const raw = body ?? JSON.stringify(payload);
  const res = await fetch(`${app.base}/shopify/webhooks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Topic': topic, 'X-Shopify-Shop-Domain': shop, 'X-Shopify-Webhook-Id': id, 'X-Shopify-Hmac-SHA256': sign(raw, secret) },
    body: raw,
  });
  await app.seed.idle();
  return res.status;
}
