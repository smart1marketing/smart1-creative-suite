#!/usr/bin/env node
/**
 * Refresh build/data/live_products.json from Knack (object_135, status = Live).
 * Run locally or in a GitHub Action — NOT from the browser (Knack blocks
 * cross-origin browser calls and the API key must stay server-side).
 *
 *   REACT_APP_KNACK_API_KEY=...  REACT_APP_KNACK_APP_ID=...  node export-live-products.js
 */
const fs = require('fs');
const path = require('path');
const API = process.env.REACT_APP_KNACK_API_KEY;
const APP = process.env.REACT_APP_KNACK_APP_ID;
if (!API || !APP) { console.error('Set REACT_APP_KNACK_API_KEY and REACT_APP_KNACK_APP_ID'); process.exit(1); }

const money = v => { const n = parseFloat(String(v||'').replace(/[^0-9.]/g,'')); return isNaN(n)?0:n; };
const ts = d => { const m=/(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(d||''); return m?(+m[3])*10000+(+m[1])*100+(+m[2]):0; };

(async () => {
  let page = 1, out = [];
  while (true) {
    const url = `https://api.knack.com/v1/objects/object_135/records?rows_per_page=1000&page=${page}`
      + `&filters=${encodeURIComponent(JSON.stringify({match:'and',rules:[{field:'field_2300',operator:'is',value:'Live'}]}))}`;
    const res = await fetch(url, { headers: {
      'X-Knack-REST-API-Key': API, 'X-Knack-Application-Id': APP, 'Content-Type':'application/json' }});
    if (!res.ok) throw new Error('Knack ' + res.status);
    const data = await res.json();
    const recs = data.records || [];
    recs.forEach(r => out.push({
      id: r.id, client:(r.field_2308||'').trim(), io:(r.field_2469||'').trim(),
      product:(r.field_2775||r.field_2327||'').trim(),
      monthly: money(r.field_2338), total: money(r.field_2339),
      cpm:(r.field_2331||'').trim(), impressions:(r.field_2330||'').trim(),
      start:(r.field_2313||'').trim(), end:(r.field_2305||'').trim(), ts: ts(r.field_2313),
    }));
    if (page >= (data.total_pages || 1)) break;
    page++;
  }
  out.sort((a,b)=>b.ts-a.ts);
  const tm = out.reduce((s,r)=>s+r.monthly,0), tt = out.reduce((s,r)=>s+r.total,0);
  const payload = { liveCount: out.length,
    clientCount: new Set(out.map(r=>r.client).filter(Boolean)).size,
    ioCount: new Set(out.map(r=>r.io).filter(Boolean)).size,
    totalMonthly: Math.round(tm*100)/100, totalContract: Math.round(tt*100)/100, records: out };
  const dest = path.join(__dirname, 'build', 'data', 'live_products.json');
  fs.writeFileSync(dest, JSON.stringify(payload));
  console.log(`Wrote ${out.length} live products → ${dest}`);
})().catch(e => { console.error(e); process.exit(1); });
