/**
 * The Knack client book, read straight from the lookup app's committed data
 * files. Cached in memory; the files only change on a data refresh + deploy,
 * so a short TTL is purely to pick up a redeploy without a restart.
 */
import fs from 'fs';
import path from 'path';
import { config } from './config.js';

let cache = { at: 0, data: null };
const TTL_MS = Number(process.env.LOOKUP_CACHE_MINUTES || 15) * 60000;

const norm = (s = '') => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function readJson(file) {
  const p = path.join(config.lookupDataDir, file);
  if (!fs.existsSync(p)) throw new Error(`Lookup data missing: ${file}. Run the Knack refresh and redeploy.`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function knackIndex() {
  if (cache.data && Date.now() - cache.at < TTL_MS) return cache.data;

  const products = readJson('products.json');
  const websites = readJson('websites.json');
  const live = readJson('live_products.json');

  const liveByClient = new Map();
  for (const r of live.records || []) {
    if (!liveByClient.has(r.client)) liveByClient.set(r.client, []);
    liveByClient.get(r.client).push(r);
  }

  const sitesByName = new Map();
  for (const w of websites.records || []) {
    const key = norm(w.name);
    if (key && !sitesByName.has(key)) sitesByName.set(key, w);
  }

  const clients = new Map();
  for (const r of products.records || []) {
    if (!r.client) continue;
    let c = clients.get(r.client);
    if (!c) {
      c = { name: r.client, ios: new Set(), products: new Set(), years: new Set(), sales: new Map(), partner: r.partner || '', dash: '', records: [] };
      clients.set(r.client, c);
    }
    if (r.io) c.ios.add(r.io);
    if (r.product) c.products.add(r.product);
    const year = String(r.start || '').slice(-4);
    if (/^\d{4}$/.test(year)) c.years.add(year);
    if (r.sales) c.sales.set(r.sales, (c.sales.get(r.sales) || 0) + 1);
    if (r.dash && !c.dash) c.dash = r.dash;
    c.records.push(r);
  }

  const rows = [...clients.values()].map((c) => {
    const liveRecs = liveByClient.get(c.name) || [];
    const site = sitesByName.get(norm(c.name)) || null;
    const salesTop = [...c.sales.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    return {
      name: c.name,
      key: norm(c.name),
      ioCount: c.ios.size,
      products: [...c.products].sort(),
      years: [...c.years].sort(),
      sales: salesTop,
      partner: c.partner,
      dash: c.dash,
      liveCount: liveRecs.length,
      liveMonthly: liveRecs.reduce((n, r) => n + (Number(r.monthly) || 0), 0),
      website: site
        ? { domain: site.domain || site.liveUrl || '', url: site.liveUrl || site.s1url || '', platform: site.platform || '', status: site.status || '' }
        : null,
      records: c.records,
      live: liveRecs,
    };
  });

  const data = {
    generatedAt: new Date().toISOString(),
    counts: {
      clients: rows.length,
      liveProducts: live.liveCount ?? (live.records || []).length,
      liveMonthly: live.totalMonthly ?? 0,
      activeSites: (websites.records || []).filter((w) => w.active).length,
    },
    rows,
  };
  cache = { at: Date.now(), data };
  return data;
}
