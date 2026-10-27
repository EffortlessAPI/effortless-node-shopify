// <shopify-admin>: connection status, sync and webhook buttons for the connected store.
//
//   <script type="module" src="/shopify/ui/shopify-ui.js"></script>
//   <shopify-admin></shopify-admin>
//
// Attribute `api` = where /api/shopify lives (default: same origin). Restyle with --sh-* properties.
// Put it in the app's admin area; the API only answers admins.
const CSS = `
shopify-admin { --sh-accent:#008060; --sh-ink:#1d1d1f; --sh-muted:#6b6b72; --sh-line:#e2e2e6; --sh-bg:#fff; display:block; max-width:760px; margin:0 auto; padding:16px; box-sizing:border-box; font:15px/1.45 system-ui,sans-serif; color:var(--sh-ink); }
shopify-admin section { border:1px solid var(--sh-line); border-radius:12px; padding:16px; margin:16px 0; background:var(--sh-bg); }
shopify-admin h3 { margin:0 0 8px; font-size:16px; }
shopify-admin .sh-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin:8px 0; }
shopify-admin .sh-stat { border:1px solid var(--sh-line); border-radius:8px; padding:10px; } shopify-admin .sh-stat b { display:block; font-size:22px; }
shopify-admin .sh-note { color:var(--sh-muted); font-size:13px; } shopify-admin .sh-err { color:#b00020; margin-top:8px; }
shopify-admin button { padding:9px 14px; font:inherit; font-weight:600; border:0; border-radius:8px; background:var(--sh-accent); color:#fff; cursor:pointer; margin:8px 8px 0 0; }
shopify-admin button.sh-quiet { background:transparent; color:var(--sh-ink); border:1px solid var(--sh-line); } shopify-admin button[disabled] { opacity:.5; }
shopify-admin table { width:100%; border-collapse:collapse; font-size:13px; } shopify-admin td, shopify-admin th { text-align:left; padding:6px 4px; border-top:1px solid var(--sh-line); }
shopify-admin code { background:#f0f0f3; padding:1px 5px; border-radius:4px; word-break:break-all; }
@media (max-width:560px) { shopify-admin .sh-grid { grid-template-columns:1fr; } }
`;
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class ShopifyAdmin extends HTMLElement {
  connectedCallback() {
    if (!document.getElementById('sh-css')) { const s = document.createElement('style'); s.id = 'sh-css'; s.textContent = CSS; document.head.appendChild(s); }
    this.api = this.getAttribute('api') || '';
    this.load();
  }
  async call(method, path, body) {
    const res = await fetch(`${this.api}/api/shopify${path}`, { method, credentials: 'include', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data });
    return data;
  }
  async load(msg = '') {
    try {
      const [s, r] = await Promise.all([this.call('GET', '/status'), this.call('GET', '/runs')]);
      this.s = s; this.runs = r.runs; this.render(msg);
    } catch (e) { this.innerHTML = `<section><h3>Shopify</h3><div class="sh-err">${esc(e.message === 'admin_only' ? 'Admins only.' : e.message)}</div></section>`; }
  }
  render(msg) {
    const s = this.s; const ready = !s.problems.length && s.installed !== false;
    this.innerHTML = `
    <section><h3>Shopify store</h3>
      <div><b>${esc(s.shop || 'No store set')}</b> · API ${esc(s.apiVersion)} · ${esc(s.authMode.replace('_', ' '))}</div>
      ${s.problems.map((p) => `<div class="sh-err">${esc(p)}</div>`).join('')}
      ${s.installed === false ? `<a href="${esc(this.api + s.installUrl)}"><button>Connect to Shopify</button></a>` : ''}
      <div class="sh-grid">${['products', 'customers', 'orders'].map((k) => `<div class="sh-stat"><b>${s.counts[k] ?? '–'}</b>${k}</div>`).join('')}</div>
      <button data-sync ${ready && !s.syncing ? '' : 'disabled'}>${s.syncing ? 'Syncing…' : 'Sync now'}</button>
      <button class="sh-quiet" data-full ${ready && !s.syncing ? '' : 'disabled'}>Full re-sync</button>
      <div class="sh-err" data-msg>${esc(msg)}</div></section>
    <section><h3>Webhooks</h3>
      <div class="sh-note">Shopify tells this app when a product, customer or order changes, so the tables stay current between syncs.</div>
      <div>Callback: <code>${esc(s.webhookUrl || 'set SHOPIFY_APP_URL to the public https address of this app')}</code></div>
      <button data-hooks ${ready && s.webhookUrl ? '' : 'disabled'}>Subscribe to webhooks</button>
      <div class="sh-note">The three privacy webhooks (customer data request, customer erasure, shop erasure) are set in the app's configuration in the Shopify Dev Dashboard, pointing at the same callback.</div></section>
    <section><h3>Recent syncs</h3>${this.runs.length ? `<table><tr><th>When</th><th>What</th><th>Rows</th><th>Result</th></tr>${this.runs.slice(0, 10).map((r) => `<tr><td>${esc(new Date(r.started_at).toLocaleString())}</td><td>${esc(r.resource)}</td><td>${r.rows}</td><td>${esc(r.status)}${r.message ? ` · ${esc(r.message)}` : ''}</td></tr>`).join('')}</table>` : '<div class="sh-note">None yet.</div>'}</section>`;
    const run = (fn) => async () => { try { await fn(); } catch (e) { this.querySelector('[data-msg]').textContent = e.message; } };
    this.querySelector('[data-sync]')?.addEventListener('click', run(async () => { await this.call('POST', '/sync'); this.load('Synced.'); }));
    this.querySelector('[data-full]')?.addEventListener('click', run(async () => { await this.call('POST', '/sync', { full: true }); this.load('Full re-sync done.'); }));
    this.querySelector('[data-hooks]')?.addEventListener('click', run(async () => { const r = await this.call('POST', '/webhooks/register'); this.load(r.results.every((x) => x.ok) ? 'Subscribed.' : 'Some topics failed: ' + r.results.filter((x) => !x.ok).map((x) => x.topic).join(', ')); }));
  }
}
if (!customElements.get('shopify-admin')) customElements.define('shopify-admin', ShopifyAdmin);
