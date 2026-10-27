// Configuration: shopify.config.json (public values, written by the seed's questions) overridden by
// environment variables. Secrets (client secret, access token) are environment only, never a file.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = {
  shop: '',                      // my-store.myshopify.com
  apiVersion: '2026-07',
  authMode: 'client_credentials', // client_credentials | oauth | token
  scopes: 'read_products,read_customers,read_orders',
  appUrl: '',                    // the public https URL of this app: webhook callback and OAuth redirect
  adminRole: 'admin',
  syncEveryMinutes: 0,           // 0 = only when asked and when webhooks arrive
  pageSize: 100,
};
const MODES = new Set(['client_credentials', 'oauth', 'token']);
const unanswered = (v) => typeof v === 'string' && /\$[A-Za-z][A-Za-z0-9-]*\$/.test(v);
export const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function loadConfig(dir, env = process.env) {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(dir, 'shopify.config.json'), 'utf8')); } catch { /* none */ }
  const cfg = { ...DEFAULTS };
  for (const [k, v] of Object.entries(file)) if (k in DEFAULTS && v !== undefined && !unanswered(v)) cfg[k] = v;
  const e = (k, name) => { if (env[name]) cfg[k] = env[name]; };
  e('shop', 'SHOPIFY_SHOP'); e('apiVersion', 'SHOPIFY_API_VERSION'); e('authMode', 'SHOPIFY_AUTH_MODE');
  e('scopes', 'SHOPIFY_SCOPES'); e('appUrl', 'SHOPIFY_APP_URL');
  cfg.syncEveryMinutes = Number(cfg.syncEveryMinutes) || 0;
  cfg.pageSize = Math.min(250, Math.max(1, Number(cfg.pageSize) || 100));
  cfg.appUrl = String(cfg.appUrl || '').replace(/\/+$/, '');
  cfg.shop = String(cfg.shop || '').toLowerCase().trim();
  // secrets: environment only (a persisted seed secret arrives as SEED_SECRET_<key>)
  cfg.clientId = env.SHOPIFY_CLIENT_ID || env.SEED_SECRET_shopifyClientId || file.clientId || '';
  cfg.clientSecret = env.SHOPIFY_CLIENT_SECRET || env.SEED_SECRET_shopifyClientSecret || '';
  cfg.staticToken = env.SHOPIFY_ACCESS_TOKEN || env.SEED_SECRET_shopifyAccessToken || '';
  if (!MODES.has(cfg.authMode)) throw new Error(`shopify: authMode must be one of ${[...MODES].join(', ')}, got "${cfg.authMode}"`);
  if (!/^\d{4}-\d{2}$/.test(cfg.apiVersion)) throw new Error(`shopify: apiVersion must look like 2026-07, got "${cfg.apiVersion}"`);
  if (cfg.shop && !SHOP_RE.test(cfg.shop)) throw new Error(`shopify: shop must be <name>.myshopify.com, got "${cfg.shop}"`);
  return cfg;
}

// What is missing before this seed can talk to Shopify. Empty means ready.
export function problems(cfg) {
  const out = [];
  if (!cfg.shop) out.push('shop is not set (SHOPIFY_SHOP or shopify.config.json)');
  if (cfg.authMode === 'client_credentials' && !(cfg.clientId && cfg.clientSecret)) out.push('client_credentials needs SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET');
  if (cfg.authMode === 'token' && !cfg.staticToken) out.push('token mode needs SHOPIFY_ACCESS_TOKEN');
  if (cfg.authMode === 'oauth' && !(cfg.clientId && cfg.clientSecret && cfg.appUrl)) out.push('oauth needs SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET and SHOPIFY_APP_URL');
  return out;
}
