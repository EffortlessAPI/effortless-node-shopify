// effortless-node-shopify: registerShopify(app, { pool })
//
// Drop-in for the generated Express API (call it from api/custom.js). It:
//   1. creates the private "shopify" schema (token, webhook ledger, sync bookkeeping),
//   2. serves /shopify/install + /shopify/callback (OAuth), /shopify/webhooks (signed), /api/shopify/* (admin),
//   3. copies Shopify products, customers and orders into the rulebook tables, on demand, and as webhooks arrive.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, problems } from './config.js';
import { shopifyClient } from './shopify.js';
import { makeSync } from './sync.js';
import { mountRoutes, isAdmin } from './routes.js';

export const SEED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function registerShopify(app, { pool, dir = SEED_DIR, env = process.env, fetchImpl = globalThis.fetch, baseUrl, authorize, sleep, log = console } = {}) {
  if (!pool) throw new Error('registerShopify needs { pool }');
  const cfg = loadConfig(dir, env);
  // This connector is a system actor: it must not run as the signed-in person (that role cannot
  // see schema shopify, by design). The magic-links seed leaves the unscoped functions at pool.__raw.
  const db = (text, values) => (pool.__raw ? pool.__raw.query(text, values) : pool.query(text, values));

  const shops = { get: async (shop) => (await db('SELECT * FROM shopify.shops WHERE shop = $1', [shop])).rows[0] };
  const client = shopifyClient(cfg, { fetchImpl, shops, baseUrl, sleep });
  const sync = makeSync({ db, client, cfg, log });

  const inflight = new Set();
  const track = (p) => { inflight.add(p); p.finally(() => inflight.delete(p)); };

  // Who may use the admin API. With the magic-links seed: its admins. Without any auth in front, only
  // outside beta/production, so an unfinished project never exposes the connector.
  const live = env.NODE_ENV === 'production' || ['beta', 'production', 'prod', 'live'].includes(String(env.EFFORTLESS_STAGE || '').toLowerCase());
  const authorizeReq = authorize || ((req) => (req.ml ? isAdmin(req.ml.user?.role, cfg.adminRole) : !live));

  const ready = db(fs.readFileSync(path.join(SEED_DIR, 'sql', '10-shopify.sql'), 'utf8'))
    .then(() => { log.log?.(`  shopify: ready (${cfg.authMode}${cfg.shop ? `, ${cfg.shop}` : ', no shop set'})${problems(cfg).length ? ` — missing: ${problems(cfg).join('; ')}` : ''}`); return null; })
    .catch((e) => { log.error?.(`  shopify: NOT READY: ${e.message}`); return e; });

  // Wait for the schema before any admin or webhook work; the routes themselves are cheap to register.
  app.use(['/api/shopify', '/shopify'], async (_req, res, next) => {
    const failure = await ready;
    return failure ? res.status(503).json({ error: 'shopify_not_ready', message: failure.message }) : next();
  });
  mountRoutes({ app, cfg, db, client, sync, fetchImpl, baseUrl, ready, authorize: authorizeReq, track, log });

  // The UI files, so a page can load them with no build step: /shopify/ui/shopify-ui.js, and a demo at /shopify/demo.
  const types = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8' };
  const sendUi = (res, file) => {
    const full = path.join(SEED_DIR, 'ui', file);
    if (!types[path.extname(full)] || !fs.existsSync(full)) return res.status(404).end();
    res.setHeader('Content-Type', types[path.extname(full)]); res.end(fs.readFileSync(full));
  };
  app.get('/shopify/demo', (_req, res) => sendUi(res, 'demo.html'));
  app.get('/shopify/ui/:file', (req, res) => sendUi(res, path.basename(req.params.file)));

  let timer = null;
  if (cfg.syncEveryMinutes > 0) {
    timer = setInterval(() => { if (!problems(cfg).length) sync.run().catch((e) => log.error?.(`  shopify: scheduled sync: ${e.message}`)); }, cfg.syncEveryMinutes * 60_000);
    timer.unref?.();
  }
  return { config: cfg, client, sync, ready, idle: async () => { while (inflight.size) await Promise.allSettled([...inflight]); }, stop: () => timer && clearInterval(timer) };
}
