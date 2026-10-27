// Copies Shopify products, customers and orders into the rulebook's tables (shopify_products,
// shopify_customers, shopify_orders): a sync that asks only for what changed, and a one-resource
// fetch the webhooks use. Customers go before orders, because an order points at its customer.

const tail = (gid) => (gid ? String(gid).split('/').pop() : null);
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const money = (m) => ({ amount: num(m?.amount), currency: m?.currencyCode ?? null });

const FIELDS = {
  products: `id title handle status vendor productType totalInventory updatedAt
             priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } }`,
  customers: `id email firstName lastName numberOfOrders amountSpent { amount currencyCode } state updatedAt`,
  orders: `id name email processedAt updatedAt displayFinancialStatus displayFulfillmentStatus
           totalPriceSet { shopMoney { amount currencyCode } } customer { id }`,
};

// cols: column -> value; expr: column -> SQL for the placeholder when it is not just "$n".
export const RESOURCES = {
  customers: {
    gql: 'Customer', table: 'shopify_customers', pk: 'shopify_customer_id', sortAfter: 0,
    map: (n) => ({
      shopify_customer_id: tail(n.id), email: n.email, first_name: n.firstName, last_name: n.lastName,
      orders_count: num(n.numberOfOrders) ?? 0, total_spent: money(n.amountSpent).amount ?? 0,
      currency_code: money(n.amountSpent).currency, state: n.state, shopify_updated_at: n.updatedAt,
    }),
  },
  products: {
    gql: 'Product', table: 'shopify_products', pk: 'shopify_product_id',
    map: (n) => ({
      shopify_product_id: tail(n.id), title: n.title, handle: n.handle, status: n.status, vendor: n.vendor,
      product_type: n.productType, total_inventory: n.totalInventory,
      price_min: money(n.priceRangeV2?.minVariantPrice).amount, price_max: money(n.priceRangeV2?.maxVariantPrice).amount,
      currency_code: money(n.priceRangeV2?.minVariantPrice).currency, shopify_updated_at: n.updatedAt,
    }),
  },
  orders: {
    gql: 'Order', table: 'shopify_orders', pk: 'shopify_order_id',
    map: (n) => ({
      shopify_order_id: tail(n.id), order_name: n.name, shopify_customer: tail(n.customer?.id), email: n.email,
      financial_status: n.displayFinancialStatus, fulfillment_status: n.displayFulfillmentStatus,
      total_price: money(n.totalPriceSet?.shopMoney).amount ?? 0, currency_code: money(n.totalPriceSet?.shopMoney).currency,
      processed_at: n.processedAt, shopify_updated_at: n.updatedAt,
    }),
    // a guest checkout, or a customer this database does not hold (yet), stays empty instead of breaking the foreign key
    expr: (i) => ({ shopify_customer: `(SELECT shopify_customer_id FROM shopify_customers WHERE shopify_customer_id = $${i})` }),
  },
};
export const ORDER = ['customers', 'products', 'orders'];

export function upsertSql(r, row) {
  const cols = Object.keys(row);
  const ex = r.expr ? r.expr(cols.indexOf('shopify_customer') + 1) : {};
  const values = cols.map((c, i) => ex[c] || `$${i + 1}`);
  const sets = cols.filter((c) => c !== r.pk).map((c) => `${c} = EXCLUDED.${c}`);
  return {
    text: `INSERT INTO ${r.table} (${cols.join(', ')}) VALUES (${values.join(', ')})
           ON CONFLICT (${r.pk}) DO UPDATE SET ${sets.join(', ')}`,
    values: cols.map((c) => row[c]),
  };
}

export function makeSync({ db, client, cfg, log = console }) {
  let running = null;

  async function upsertNodes(key, nodes) {
    const r = RESOURCES[key];
    for (const n of nodes) { const q = upsertSql(r, r.map(n)); await db(q.text, q.values); }
  }

  async function fetchOne(key, id) {
    const r = RESOURCES[key];
    const data = await client.graphql(`query($id: ID!) { node(id: $id) { ... on ${r.gql} { ${FIELDS[key]} } } }`, { id: `gid://shopify/${r.gql}/${id}` });
    return data.node && data.node.id ? data.node : null;
  }

  async function refreshOne(key, id) {
    const node = await fetchOne(key, id);
    if (node) await upsertNodes(key, [node]); else await removeOne(key, id);
  }

  async function removeOne(key, id) {
    const r = RESOURCES[key];
    if (key === 'customers') await db('UPDATE shopify_orders SET shopify_customer = NULL WHERE shopify_customer = $1', [String(id)]);
    await db(`DELETE FROM ${r.table} WHERE ${r.pk} = $1`, [String(id)]);
  }

  async function syncOne(key, { full }) {
    const r = RESOURCES[key];
    const state = (await db('SELECT last_updated_at FROM shopify.sync_state WHERE resource = $1', [key])).rows[0];
    const since = !full && state?.last_updated_at ? new Date(state.last_updated_at).toISOString() : null;
    const run = (await db(`INSERT INTO shopify.sync_runs (resource) VALUES ($1) RETURNING id`, [key])).rows[0].id;
    let rows = 0; let maxUpdated = since;
    try {
      const query = `query($first: Int!, $after: String, $query: String) {
        ${key}(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
          pageInfo { hasNextPage endCursor } nodes { ${FIELDS[key]} } } }`;
      await client.paginate(query, key, { first: cfg.pageSize, query: since ? `updated_at:>='${since}'` : null }, async (nodes) => {
        await upsertNodes(key, nodes); rows += nodes.length;
        for (const n of nodes) if (n.updatedAt && (!maxUpdated || n.updatedAt > maxUpdated)) maxUpdated = n.updatedAt;
      });
      await db(`INSERT INTO shopify.sync_state (resource, last_updated_at, last_run_at) VALUES ($1, $2, now())
                ON CONFLICT (resource) DO UPDATE SET last_updated_at = COALESCE(EXCLUDED.last_updated_at, shopify.sync_state.last_updated_at), last_run_at = now()`, [key, maxUpdated]);
      await db(`UPDATE shopify.sync_runs SET status = 'ok', rows = $2, finished_at = now() WHERE id = $1`, [run, rows]);
      return { resource: key, ok: true, rows };
    } catch (e) {
      await db(`UPDATE shopify.sync_runs SET status = 'failed', rows = $2, message = $3, finished_at = now() WHERE id = $1`, [run, rows, e.message.slice(0, 500)]);
      log.error?.(`  shopify: sync ${key} failed: ${e.message}`);
      return { resource: key, ok: false, rows, error: e.message };
    }
  }

  async function run(keys = ORDER, { full = false } = {}) {
    if (running) throw Object.assign(new Error('a sync is already running'), { status: 409 });
    const wanted = ORDER.filter((k) => keys.includes(k));
    running = (async () => { const out = []; for (const k of wanted) out.push(await syncOne(k, { full })); return out; })();
    try { return await running; } finally { running = null; }
  }

  return { run, refreshOne, removeOne, fetchOne, isRunning: () => !!running };
}
