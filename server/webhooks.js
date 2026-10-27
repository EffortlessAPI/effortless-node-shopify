// Shopify webhooks: verify the signature over the RAW body, acknowledge at once (Shopify gives
// five seconds), act once per delivery, then do the work.
import crypto from 'node:crypto';
import { SHOP_RE } from './config.js';

const BY_TOPIC = {
  'products/create': ['products', 'refresh'], 'products/update': ['products', 'refresh'], 'products/delete': ['products', 'remove'],
  'customers/create': ['customers', 'refresh'], 'customers/update': ['customers', 'refresh'], 'customers/delete': ['customers', 'remove'],
  'orders/create': ['orders', 'refresh'], 'orders/updated': ['orders', 'refresh'], 'orders/delete': ['orders', 'remove'],
};
export const TOPICS = Object.keys(BY_TOPIC);
export const TOPIC_ENUM = (t) => t.toUpperCase().replace('/', '_');

export function validSignature(rawBody, header, secret) {
  if (!secret || !header) return false;
  const want = crypto.createHmac('sha256', secret).update(rawBody).digest();
  let got; try { got = Buffer.from(header, 'base64'); } catch { return false; }
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

async function readRaw(req, limit = 5_000_000) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw Object.assign(new Error('payload too large'), { status: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
}

export function makeWebhookHandler({ cfg, db, sync, log = console, track }) {
  async function act(topic, payload) {
    const hit = BY_TOPIC[topic];
    if (hit) {
      const [key, how] = hit; const id = payload.id;
      if (id == null) return;
      return how === 'remove' ? sync.removeOne(key, id) : sync.refreshOne(key, id);
    }
    if (topic === 'app/uninstalled') return db('DELETE FROM shopify.shops WHERE shop = $1', [cfg.shop]);
    if (topic === 'customers/redact') {
      for (const oid of payload.orders_to_redact || []) await sync.removeOne('orders', oid);
      if (payload.customer?.id != null) await sync.removeOne('customers', payload.customer.id);
      return;
    }
    if (topic === 'shop/redact') {
      for (const t of ['shopify_orders', 'shopify_customers', 'shopify_products']) await db(`DELETE FROM ${t}`);
      await db('DELETE FROM shopify.shops WHERE shop = $1', [cfg.shop]);
      return;
    }
    // customers/data_request: kept in shopify.webhook_events for the merchant to answer
  }

  return async function handler(req, res) {
    try {
      const raw = await readRaw(req);
      if (!validSignature(raw, req.headers['x-shopify-hmac-sha256'], cfg.clientSecret)) return res.status(401).end();
      const shop = String(req.headers['x-shopify-shop-domain'] || '').toLowerCase();
      const topic = String(req.headers['x-shopify-topic'] || '');
      const id = String(req.headers['x-shopify-webhook-id'] || '');
      if (!id || !SHOP_RE.test(shop) || (cfg.shop && shop !== cfg.shop)) return res.status(200).end();   // not ours: do not make Shopify retry
      let payload; try { payload = JSON.parse(raw.toString('utf8') || '{}'); } catch { return res.status(400).end(); }

      const first = await db(`INSERT INTO shopify.webhook_events (webhook_id, topic, shop, payload) VALUES ($1, $2, $3, $4)
                              ON CONFLICT (webhook_id) DO NOTHING RETURNING webhook_id`, [id, topic, shop, topic === 'customers/data_request' ? JSON.stringify(payload) : null]);   // personal data is kept only where a request must be answered
      res.status(200).end();
      if (!first.rowCount) return;                               // a repeat delivery: already acted on
      track((async () => {
        try { await act(topic, payload); await db('UPDATE shopify.webhook_events SET processed_at = now() WHERE webhook_id = $1', [id]); }
        catch (e) { log.error?.(`  shopify: webhook ${topic} failed: ${e.message}`); await db('UPDATE shopify.webhook_events SET error = $2 WHERE webhook_id = $1', [id, e.message.slice(0, 500)]); }
      })());
    } catch (e) { if (!res.headersSent) res.status(e.status || 500).end(); }
  };
}
