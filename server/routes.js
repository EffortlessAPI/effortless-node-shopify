// OAuth install/callback (public, signature-checked), webhooks (public, signature-checked) and the
// admin API under /api/shopify (authorized).
import crypto from 'node:crypto';
import { SHOP_RE, problems } from './config.js';
import { makeWebhookHandler, TOPICS, TOPIC_ENUM } from './webhooks.js';

// Express runs middleware in order and the generated API parses JSON before custom.js runs, which
// destroys the exact bytes a webhook signature is computed over. Put this route in front of every
// body parser, but behind Express's own two setup layers (query, expressInit: they give `res` its
// status()/json()).
function routeFirst(app, method, path, handler) {
  app[method](path, handler);
  const router = app._router || app.router;
  const layer = router.stack.pop();
  const at = router.stack.findIndex((l) => l.name !== 'query' && l.name !== 'expressInit');
  router.stack.splice(at < 0 ? router.stack.length : at, 0, layer);
}

export function oauthHmacValid(query, secret) {
  const { hmac, ...rest } = query;
  if (!hmac || !secret) return false;
  const message = Object.keys(rest).sort().map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`).join('&');
  const want = crypto.createHmac('sha256', secret).update(message).digest('hex');
  const got = Buffer.from(String(hmac), 'hex');
  return got.length === Buffer.from(want, 'hex').length && crypto.timingSafeEqual(got, Buffer.from(want, 'hex'));
}

const cookie = (req, name) => (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1];
const isAdmin = (role, adminRole) => String(role || '').toLowerCase().split(',').map((s) => s.trim()).includes(adminRole.toLowerCase());

export function mountRoutes(ctx) {
  const { app, cfg, db, client, sync, fetchImpl, authorize, track, log } = ctx;

  const webhook = makeWebhookHandler({ cfg, db, sync, log, track });
  routeFirst(app, 'post', '/shopify/webhooks', async (req, res) => {
    if (await ctx.ready) return res.status(503).end();      // the schema is not there yet: Shopify retries
    return webhook(req, res);
  });

  // ---------------------------------------------------------------- OAuth (authMode "oauth")
  app.get('/shopify/install', (req, res) => {
    if (cfg.authMode !== 'oauth') return res.status(404).json({ error: 'not_found' });
    const shop = String(req.query.shop || cfg.shop).toLowerCase();
    if (!SHOP_RE.test(shop) || (cfg.shop && shop !== cfg.shop)) return res.status(400).json({ error: 'bad_shop' });
    if (problems(cfg).length) return res.status(503).json({ error: 'not_configured', problems: problems(cfg) });
    const state = crypto.randomBytes(16).toString('hex');
    res.setHeader('Set-Cookie', `shopify_state=${state}; Path=/shopify; HttpOnly; SameSite=Lax; Max-Age=600${cfg.appUrl.startsWith('https') ? '; Secure' : ''}`);
    const q = new URLSearchParams({ client_id: cfg.clientId, scope: cfg.scopes, redirect_uri: `${cfg.appUrl}/shopify/callback`, state });
    res.redirect(`https://${shop}/admin/oauth/authorize?${q}`);
  });

  app.get('/shopify/callback', async (req, res) => {
    try {
      if (cfg.authMode !== 'oauth') return res.status(404).json({ error: 'not_found' });
      const { shop, code, state } = req.query;
      if (!oauthHmacValid(req.query, cfg.clientSecret)) return res.status(401).json({ error: 'bad_hmac' });
      if (!state || state !== cookie(req, 'shopify_state')) return res.status(401).json({ error: 'bad_state' });
      if (!SHOP_RE.test(String(shop)) || String(shop).toLowerCase() !== cfg.shop) return res.status(400).json({ error: 'bad_shop' });
      const r = await fetchImpl(`${ctx.baseUrl || `https://${shop}`}/admin/oauth/access_token`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code }),
      });
      const t = await r.json().catch(() => ({}));
      if (!r.ok || !t.access_token) return res.status(502).json({ error: 'token_exchange_failed' });
      await db(`INSERT INTO shopify.shops (shop, access_token, scopes, auth_mode) VALUES ($1, $2, $3, 'oauth')
                ON CONFLICT (shop) DO UPDATE SET access_token = EXCLUDED.access_token, scopes = EXCLUDED.scopes, installed_at = now()`,
        [cfg.shop, t.access_token, t.scope || cfg.scopes]);
      res.redirect(cfg.appUrl + '/');
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------------------------------------------------------------- admin API
  const guard = (fn) => async (req, res) => {
    try {
      if (!authorize(req)) return res.status(403).json({ error: 'admin_only' });
      await fn(req, res);
    } catch (e) { res.status(e.status && e.status < 600 ? e.status : 500).json({ error: e.message }); }
  };

  app.get('/api/shopify/status', guard(async (_req, res) => {
    const shop = (await db('SELECT shop, scopes, auth_mode, expires_at, installed_at FROM shopify.shops WHERE shop = $1', [cfg.shop])).rows[0] || null;
    const state = (await db('SELECT resource, last_updated_at, last_run_at FROM shopify.sync_state ORDER BY resource')).rows;
    const counts = {};
    for (const [k, t] of [['products', 'shopify_products'], ['customers', 'shopify_customers'], ['orders', 'shopify_orders']]) {
      counts[k] = (await db(`SELECT count(*)::int AS n FROM ${t}`).catch(() => ({ rows: [{ n: null }] }))).rows[0].n;
    }
    res.json({
      shop: cfg.shop, apiVersion: cfg.apiVersion, authMode: cfg.authMode, scopes: cfg.scopes, appUrl: cfg.appUrl,
      problems: problems(cfg), installed: cfg.authMode === 'oauth' ? !!shop : null, syncing: sync.isRunning(),
      counts, state, installUrl: cfg.authMode === 'oauth' ? '/shopify/install' : null, webhookUrl: cfg.appUrl ? `${cfg.appUrl}/shopify/webhooks` : null,
    });
  }));

  app.get('/api/shopify/runs', guard(async (_req, res) => {
    res.json({ runs: (await db('SELECT * FROM shopify.sync_runs ORDER BY id DESC LIMIT 30')).rows });
  }));

  app.post('/api/shopify/sync', guard(async (req, res) => {
    const bad = problems(cfg); if (bad.length) return res.status(409).json({ error: 'not_configured', problems: bad });
    if (cfg.authMode === 'oauth' && !(await db('SELECT 1 FROM shopify.shops WHERE shop = $1 AND access_token IS NOT NULL', [cfg.shop])).rowCount) {
      return res.status(409).json({ error: 'not_installed', installUrl: '/shopify/install' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    res.json({ results: await sync.run(Array.isArray(body.resources) ? body.resources : undefined, { full: body.full === true }) });
  }));

  app.post('/api/shopify/webhooks/register', guard(async (_req, res) => {
    const bad = problems(cfg); if (bad.length) return res.status(409).json({ error: 'not_configured', problems: bad });
    if (!cfg.appUrl.startsWith('https://')) return res.status(409).json({ error: 'SHOPIFY_APP_URL must be the public https URL of this app' });
    const callbackUrl = `${cfg.appUrl}/shopify/webhooks`;
    const out = [];
    for (const topic of TOPICS) {
      const d = await client.graphql(`mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id } userErrors { field message } } }`,
      { topic: TOPIC_ENUM(topic), sub: { callbackUrl, format: 'JSON' } });
      const errs = d.webhookSubscriptionCreate.userErrors;
      // "address for this topic has already been taken" means it is already subscribed: fine
      out.push({ topic, ok: !errs.length || /already been taken/i.test(errs.map((e) => e.message).join()), errors: errs.map((e) => e.message) });
    }
    res.json({ callbackUrl, results: out, note: 'customers/data_request, customers/redact and shop/redact are set in the app configuration (Dev Dashboard), not through the API' });
  }));
}

export { isAdmin };
