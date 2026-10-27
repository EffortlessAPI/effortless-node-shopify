import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pgAvailable, freshDb, read } from './helpers.mjs';
import { bootApp, stubShopify, webhook, sign, SECRET, SHOP } from './harness.mjs';
import { loadConfig, problems } from '../server/config.js';
import { oauthHmacValid } from '../server/routes.js';

let db; let skip = false; let sh;
before(async () => {
  if (!(await pgAvailable())) { skip = 'no Postgres at SH_TEST_PG'; return; }
  db = await freshDb('shopify'); await db.pool.query(read('test/fixture.sql'));
});
after(async () => { sh?.close(); if (db) await db.drop(); });
beforeEach(async () => {
  sh?.close(); sh = await stubShopify();
  if (db) await db.pool.query(`DROP SCHEMA IF EXISTS shopify CASCADE; TRUNCATE shopify_orders, shopify_customers, shopify_products`);
});

const one = async (sql, v) => (await db.pool.query(sql, v)).rows;
const app = (o = {}) => bootApp({ dbUrl: db.url, shopify: sh, ...o });
const get = async (a, p, headers = {}) => { const r = await fetch(a.base + p, { headers, redirect: 'manual' }); return { status: r.status, body: await r.json().catch(() => null), headers: r.headers }; };
const post = async (a, p, body) => { const r = await fetch(a.base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json().catch(() => null) }; };

test('config: what is missing is named, and bad values are refused', () => {
  const cfg = loadConfig('/nonexistent', {});
  assert.deepEqual(problems(cfg), ['shop is not set (SHOPIFY_SHOP or shopify.config.json)', 'client_credentials needs SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET']);
  assert.equal(cfg.apiVersion, '2026-07');
  assert.throws(() => loadConfig('/x', { SHOPIFY_SHOP: 'evil.com' }), /myshopify\.com/);
  assert.throws(() => loadConfig('/x', { SHOPIFY_AUTH_MODE: 'password' }), /authMode/);
  assert.throws(() => loadConfig('/x', { SHOPIFY_API_VERSION: 'latest' }), /apiVersion/);
  assert.equal(loadConfig('/x', { SHOPIFY_SHOP: SHOP, SHOPIFY_AUTH_MODE: 'token', SHOPIFY_ACCESS_TOKEN: 't' }).staticToken, 't');
});

test('full sync pages through everything, waits out throttling, and keeps the foreign key honest', { skip }, async () => {
  const a = await app();
  try {
    const r = await post(a, '/api/shopify/sync');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.results.map((x) => [x.resource, x.ok, x.rows]), [['customers', true, 3], ['products', true, 3], ['orders', true, 4]]);
    assert.equal(sh.state.tokenRequests.length, 1, 'one token, cached for the day');
    assert.equal(sh.state.tokenRequests[0].grant_type, 'client_credentials');
    assert.equal((await one('SELECT count(*)::int n FROM shopify_products'))[0].n, 3);
    const p = (await one(`SELECT * FROM shopify_products WHERE shopify_product_id = '3'`))[0];
    assert.deepEqual([p.title, p.status, p.total_inventory, Number(p.price_min), Number(p.price_max), p.currency_code], ['Product 3', 'DRAFT', 30, 5, 9.5, 'USD']);
    const c = (await one(`SELECT * FROM shopify_customers WHERE shopify_customer_id = '2'`))[0];
    assert.deepEqual([c.email, c.orders_count, Number(c.total_spent)], ['c2@example.com', 2, 20]);
    const o = await one('SELECT shopify_order_id, shopify_customer, order_name, Number(total_price) tp FROM shopify_orders ORDER BY 1'.replace('Number(total_price)', 'total_price::float'));
    assert.deepEqual(o.map((x) => [x.shopify_order_id, x.shopify_customer]), [['101', '1'], ['102', '2'], ['103', null], ['104', null]]);
    assert.equal(sh.state.queries.filter((q) => /products\(/.test(q.query)).length, 2, 'three products at two a page');
  } finally { await a.close(); }
});

test('the next sync asks only for what changed since the last one', { skip }, async () => {
  const a = await app();
  try {
    await post(a, '/api/shopify/sync');
    sh.state.products[0].title = 'Renamed'; sh.state.products[0].updatedAt = '2026-10-09T09:00:00Z';
    sh.state.queries.length = 0;
    const r = await post(a, '/api/shopify/sync', { resources: ['products'] });
    // ">=" on purpose: the newest row we already hold is asked for again, so a change in the same second is never missed
    assert.deepEqual(r.body.results.map((x) => [x.resource, x.rows]), [['products', 2]]);
    assert.match(sh.state.queries[0].variables.query, /updated_at:>='2026-10-03T10:00:00.000Z'/);
    assert.equal((await one(`SELECT title FROM shopify_products WHERE shopify_product_id='1'`))[0].title, 'Renamed');
    assert.equal((await post(a, '/api/shopify/sync', { resources: ['products'], full: true })).body.results[0].rows, 3);
    const runs = await get(a, '/api/shopify/runs');
    assert.ok(runs.body.runs.length >= 5 && runs.body.runs.every((x) => x.status === 'ok'));
  } finally { await a.close(); }
});

test('a failed resource is recorded, not thrown away, and the others still run', { skip }, async () => {
  const a = await app();
  try {
    sh.state.token = 'rotated-elsewhere';              // our cached token is now wrong; a 401 re-requests once, then the stub issues the new one
    const r = await post(a, '/api/shopify/sync');
    assert.equal(r.body.results.every((x) => x.ok), true);
    sh.close(); sh = await stubShopify();               // a store that is gone entirely
    const b = await bootApp({ dbUrl: db.url, shopify: { url: 'http://127.0.0.1:9' } });
    const f = await post(b, '/api/shopify/sync');
    assert.equal(f.body.results.every((x) => !x.ok), true);
    const runs = await one(`SELECT status, message FROM shopify.sync_runs WHERE status='failed'`);
    assert.ok(runs.length >= 1 && runs[0].message);
    await b.close();
  } finally { await a.close(); }
});

test('webhooks: the signature is checked over the raw bytes even though express.json() ran first', { skip }, async () => {
  const a = await app();
  try {
    await post(a, '/api/shopify/sync');
    sh.state.products[1].title = 'Changed by webhook'; sh.state.products[1].updatedAt = '2026-10-20T00:00:00Z';
    // odd spacing: a re-serialised JSON body would not match this signature
    const body = '{ "id" : 2 ,"title":"x" }';
    assert.equal(await webhook(a, 'products/update', null, { body, secret: 'wrong' }), 401);
    assert.equal(sh.state.nodeCalls, 0);
    assert.equal(await webhook(a, 'products/update', null, { body }), 200);
    assert.equal((await one(`SELECT title FROM shopify_products WHERE shopify_product_id='2'`))[0].title, 'Changed by webhook');
  } finally { await a.close(); }
});

test('webhooks: a repeated delivery is acted on once; a deleted product goes; a stranger store is ignored', { skip }, async () => {
  const a = await app();
  try {
    await post(a, '/api/shopify/sync');
    const before = sh.state.nodeCalls;
    assert.equal(await webhook(a, 'products/update', { id: 1 }, { id: 'same-id' }), 200);
    assert.equal(await webhook(a, 'products/update', { id: 1 }, { id: 'same-id' }), 200);
    assert.equal(sh.state.nodeCalls - before, 1);
    assert.equal(await webhook(a, 'products/delete', { id: 3 }), 200);
    assert.equal((await one('SELECT count(*)::int n FROM shopify_products'))[0].n, 2);
    assert.equal(await webhook(a, 'products/delete', { id: 1 }, { shop: 'other-store.myshopify.com' }), 200);
    assert.equal((await one('SELECT count(*)::int n FROM shopify_products'))[0].n, 2, 'another store cannot delete ours');
    const ev = await one(`SELECT payload FROM shopify.webhook_events WHERE webhook_id = 'same-id'`);
    assert.equal(ev[0].payload, null, 'personal data is not kept in the ledger');
  } finally { await a.close(); }
});

test('compliance webhooks: customers/redact erases the customer and detaches their orders; shop/redact empties the tables', { skip }, async () => {
  const a = await app();
  try {
    await post(a, '/api/shopify/sync');
    assert.equal(await webhook(a, 'customers/redact', { customer: { id: 1 }, orders_to_redact: [102] }), 200);
    assert.equal((await one(`SELECT count(*)::int n FROM shopify_customers WHERE shopify_customer_id='1'`))[0].n, 0);
    assert.equal((await one(`SELECT count(*)::int n FROM shopify_orders WHERE shopify_order_id='102'`))[0].n, 0);
    assert.equal((await one(`SELECT shopify_customer FROM shopify_orders WHERE shopify_order_id='101'`))[0].shopify_customer, null);
    assert.equal(await webhook(a, 'customers/data_request', { customer: { id: 2 } }), 200);
    assert.ok((await one(`SELECT payload FROM shopify.webhook_events WHERE topic='customers/data_request'`))[0].payload);
    assert.equal(await webhook(a, 'shop/redact', { shop_id: 1 }), 200);
    for (const t of ['shopify_orders', 'shopify_customers', 'shopify_products']) assert.equal((await one(`SELECT count(*)::int n FROM ${t}`))[0].n, 0);
  } finally { await a.close(); }
});

test('the admin API answers only to an authorized caller; with nothing in front, never in production', { skip }, async () => {
  const dev = await app();
  const prod = await app({ env: { NODE_ENV: 'production' } });
  const asMember = await app({ env: { NODE_ENV: 'production' }, middleware: (req, _res, next) => { req.ml = { user: { role: 'member' } }; next(); } });
  const asAdmin = await app({ env: { NODE_ENV: 'production' }, middleware: (req, _res, next) => { req.ml = { user: { role: 'admin' } }; next(); } });
  try {
    assert.equal((await get(dev, '/api/shopify/status')).status, 200);
    assert.equal((await get(prod, '/api/shopify/status')).status, 403);
    assert.equal((await post(prod, '/api/shopify/sync')).status, 403);
    assert.equal((await get(asMember, '/api/shopify/status')).status, 403);
    const s = await get(asAdmin, '/api/shopify/status');
    assert.equal(s.status, 200);
    assert.deepEqual([s.body.shop, s.body.authMode, s.body.problems, s.body.webhookUrl], [SHOP, 'client_credentials', [], 'https://app.example.com/shopify/webhooks']);
    assert.equal(JSON.stringify(s.body).includes(SECRET), false, 'status never shows a secret');
  } finally { await Promise.all([dev, prod, asMember, asAdmin].map((x) => x.close())); }
});

test('webhook registration subscribes every topic and treats "already taken" as done', { skip }, async () => {
  const a = await app();
  try {
    const r = await post(a, '/api/shopify/webhooks/register');
    assert.equal(r.status, 200);
    assert.equal(sh.state.subscriptions.length, 9);
    assert.ok(sh.state.subscriptions.includes('PRODUCTS_UPDATE') && sh.state.subscriptions.includes('ORDERS_DELETE'));
    assert.equal(r.body.results.every((x) => x.ok), true);
    assert.match(r.body.note, /Dev Dashboard/);
  } finally { await a.close(); }
  const http = await bootApp({ dbUrl: db.url, shopify: sh, config: { appUrl: 'http://insecure.example.com' } });
  try { assert.equal((await post(http, '/api/shopify/webhooks/register')).status, 409); } finally { await http.close(); }
});

test('oauth: install redirects with a state; the callback checks the signature and the state, then keeps the token', { skip }, async () => {
  const a = await app({ config: { authMode: 'oauth' } });
  try {
    assert.equal((await post(a, '/api/shopify/sync')).status, 409, 'not installed yet');
    const inst = await get(a, `/shopify/install?shop=${SHOP}`);
    assert.equal(inst.status, 302);
    const loc = new URL(inst.headers.get('location'));
    assert.equal(loc.host, SHOP); assert.equal(loc.searchParams.get('scope'), 'read_products,read_customers,read_orders');
    assert.equal(loc.searchParams.get('redirect_uri'), 'https://app.example.com/shopify/callback');
    const state = loc.searchParams.get('state');
    assert.equal(inst.headers.get('set-cookie').includes(`shopify_state=${state}`), true);
    assert.equal((await get(a, '/shopify/install?shop=evil.example.com')).status, 400);

    const signed = (q) => { const sorted = Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join('&'); return new URLSearchParams({ ...q, hmac: crypto.createHmac('sha256', SECRET).update(sorted).digest('hex') }).toString(); };
    const cb = (q, cookie) => get(a, `/shopify/callback?${signed(q)}`, cookie ? { Cookie: `shopify_state=${cookie}` } : {});
    assert.equal((await get(a, `/shopify/callback?shop=${SHOP}&code=good-code&state=${state}&hmac=00`, { Cookie: `shopify_state=${state}` })).status, 401);
    assert.equal((await cb({ shop: SHOP, code: 'good-code', state }, 'someone-elses-state')).status, 401);
    assert.equal((await cb({ shop: 'evil.myshopify.com', code: 'good-code', state }, state)).status, 400);
    assert.equal((await cb({ shop: SHOP, code: 'bad-code', state }, state)).status, 502);
    assert.equal((await cb({ shop: SHOP, code: 'good-code', state }, state)).status, 302);
    assert.equal((await one('SELECT access_token, auth_mode FROM shopify.shops'))[0].access_token, 'tok_1');
    assert.equal((await post(a, '/api/shopify/sync', { resources: ['products'] })).body.results[0].rows, 3);
    assert.equal(oauthHmacValid({ shop: SHOP, hmac: 'zz' }, SECRET), false);
    assert.equal((await post(a, '/api/shopify/sync')).status, 200);
    assert.equal(await webhook(a, 'app/uninstalled', {}), 200);
    assert.equal((await one('SELECT count(*)::int n FROM shopify.shops'))[0].n, 0, 'uninstall forgets the token');
  } finally { await a.close(); }
});

test('token mode sends the given token; nothing is requested', { skip }, async () => {
  sh.state.token = 'shpat_given';
  const a = await app({ config: { authMode: 'token' }, env: { SHOPIFY_ACCESS_TOKEN: 'shpat_given' } });
  try {
    assert.equal((await post(a, '/api/shopify/sync', { resources: ['products'] })).body.results[0].rows, 3);
    assert.equal(sh.state.tokenRequests.length, 0);
  } finally { await a.close(); }
});

test('an unanswered seed question (still a $token$) falls back to the default', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shcfg-'));
  fs.writeFileSync(path.join(dir, 'shopify.config.json'), JSON.stringify({ shop: '$shopifyDomain$', apiVersion: '$shopifyApiVersion$', authMode: '$shopifyAuthMode$', scopes: 'read_products' }));
  const cfg = loadConfig(dir, {});
  assert.deepEqual([cfg.shop, cfg.apiVersion, cfg.authMode, cfg.scopes], ['', '2026-07', 'client_credentials', 'read_products']);
});
