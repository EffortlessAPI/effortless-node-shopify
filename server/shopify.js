// A small Shopify Admin GraphQL client: gets a token the way the auth mode says, sends queries,
// waits out throttling, and pages through connections.
const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

export function shopifyClient(cfg, { fetchImpl = globalThis.fetch, shops, sleep = sleepDefault, baseUrl } = {}) {
  let cached = null;   // { token, until } for client_credentials
  const root = () => baseUrl || `https://${cfg.shop}`;   // baseUrl: a test seam, never set in production

  async function token() {
    if (cfg.authMode === 'token') return cfg.staticToken;
    if (cfg.authMode === 'oauth') {
      const row = await shops.get(cfg.shop);
      if (!row?.access_token) throw Object.assign(new Error(`not installed: open /shopify/install?shop=${cfg.shop}`), { status: 409 });
      return row.access_token;
    }
    if (cached && cached.until > Date.now() + 60_000) return cached.token;
    // client credentials: only for a store in the same Shopify organization as the app; the token lasts ~24h
    const res = await fetchImpl(`${root()}/admin/oauth/access_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.clientSecret }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw Object.assign(new Error(`shopify token request failed: ${data.error_description || data.error || res.status}`), { status: 502 });
    cached = { token: data.access_token, until: Date.now() + (data.expires_in || 86399) * 1000, scope: data.scope };
    return cached.token;
  }

  const endpoint = () => `${root()}/admin/api/${cfg.apiVersion}/graphql.json`;

  async function graphql(query, variables = {}) {
    for (let attempt = 1; ; attempt++) {
      const res = await fetchImpl(endpoint(), {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await token() },
        body: JSON.stringify({ query, variables }),
      });
      if (res.status === 401 && cfg.authMode === 'client_credentials' && attempt === 1) { cached = null; continue; }
      if ((res.status === 429 || res.status >= 500) && attempt < 5) { await sleep(Number(res.headers.get('retry-after') || attempt) * 1000); continue; }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(`shopify ${res.status}: ${JSON.stringify(body.errors || body).slice(0, 300)}`), { status: 502 });
      const throttled = (body.errors || []).some((e) => e.extensions?.code === 'THROTTLED');
      if (throttled && attempt < 6) { await sleep(attempt * 1000); continue; }
      if (body.errors?.length) throw Object.assign(new Error(`shopify: ${body.errors.map((e) => e.message).join('; ').slice(0, 300)}`), { status: 502 });
      return body.data;
    }
  }

  // Calls `onPage(nodes)` for each page of a connection (`field`), following endCursor.
  async function paginate(query, field, vars, onPage) {
    let after = null; let total = 0;
    for (;;) {
      const data = await graphql(query, { ...vars, after });
      const conn = data[field];
      await onPage(conn.nodes); total += conn.nodes.length;
      if (!conn.pageInfo.hasNextPage) return total;
      after = conn.pageInfo.endCursor;
    }
  }

  return { graphql, paginate, token, scopes: () => cached?.scope ?? null, invalidate: () => { cached = null; } };
}
