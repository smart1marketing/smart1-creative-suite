#!/usr/bin/env node
/** Refresh build/data/products.json from Knack object_135. Run server-side only. */
const fs=require('fs'),path=require('path');
const API=process.env.REACT_APP_KNACK_API_KEY,APP=process.env.REACT_APP_KNACK_APP_ID;
if(!API||!APP){console.error('Set REACT_APP_KNACK_API_KEY and REACT_APP_KNACK_APP_ID');process.exit(1);}
const IMG=['field_2409','field_2427','field_3422','field_3425','field_3426','field_3427'];
const IMG_EXT=['jpg','jpeg','png','gif','webp','bmp','svg'];
const strip=v=>typeof v==='string'?v.replace(/<[^>]+>/g,'').trim():'';
const money=v=>{const n=parseFloat(String(v||'').replace(/[^0-9.]/g,''));return isNaN(n)?0:n;};
const href=v=>{const m=/href="([^"]+)"/i.exec(v||'');return m?m[1]:(String(v||'').startsWith('http')?v.trim():'');};
const mkey=d=>{const m=/(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(d||'');return m?(+m[3])*100+(+m[1]):0;};
const ts=d=>{const m=/(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(d||'');return m?(+m[3])*10000+(+m[1])*100+(+m[2]):0;};
const firstUrl=(...vs)=>{for(const v of vs){if(typeof v==='string'&&v.trim()){const u=href(v);if(u)return u.trim();}}return '';};
function kind(u){if(!u)return 'none';let h='',p='';try{const x=new URL(u);h=x.host.toLowerCase();p=x.pathname.toLowerCase();}catch{}const e=p.includes('.')?p.split('.').pop():'';if(IMG_EXT.includes(e))return 'image';if(e==='pdf'||u.toLowerCase().includes('.pdf'))return 'pdf';if(h.includes('drive.google')||h.includes('docs.google'))return 'gdrive';if(h.includes('dropbox'))return 'dropbox';return 'file';}
function creativeUrl(r){for(const k of IMG){const u=firstUrl(r[k],r[k+'_raw']);if(u)return u;}return '';}
(async()=>{
  const now=new Date();const THIS=now.getFullYear()*100+(now.getMonth()+1);
  const lm=new Date(now.getFullYear(),now.getMonth()-1,1);const LAST=lm.getFullYear()*100+(lm.getMonth()+1);
  let page=1,recs=[];
  while(true){
    const res=await fetch(`https://api.knack.com/v1/objects/object_135/records?rows_per_page=1000&page=${page}`,
      {headers:{'X-Knack-REST-API-Key':API,'X-Knack-Application-Id':APP,'Content-Type':'application/json'}});
    if(!res.ok)throw new Error('Knack '+res.status);
    const data=await res.json();recs=recs.concat(data.records||[]);
    if(page>=(data.total_pages||1))break;page++;
  }
  const clientDash={};
  for(const r of recs){const c=(r.field_2308||'').trim();const d=firstUrl(r.field_2978,r.field_2820,r.field_2976);if(c&&d&&!clientDash[c])clientDash[c]=d;}
  const out=recs.map(r=>{const c=(r.field_2308||'').trim();const u=creativeUrl(r);const start=r.field_2299||'',end=r.field_2313||'';const sk=mkey(start),ek=mkey(end);
    return {id:r.id,client:c,io:(r.field_2469||'').trim(),product:(r.field_2775||r.field_2327||'').trim(),
      campaign:(r.field_2309||'').trim(),sales:(r.field_2655||strip(r.field_2496)||'').trim(),partner:(r.field_2307||'').trim(),
      status:(r.field_2300||'').trim(),monthly:money(r.field_2338),total:money(r.field_2339),
      start:start.trim(),end:end.trim(),ts:ts(start),url:u,kind:kind(u),dash:clientDash[c]||'',
      lastM:(sk&&ek&&sk<=LAST&&LAST<=ek)?1:0,thisM:(sk&&ek&&sk<=THIS&&THIS<=ek)?1:0};});
  out.sort((a,b)=>b.ts-a.ts);
  fs.writeFileSync(path.join(__dirname,'build','data','products.json'),JSON.stringify({recordCount:out.length,thisMonth:THIS,lastMonth:LAST,records:out}));
  console.log(`Wrote ${out.length} products (this=${THIS}, last=${LAST})`);
})().catch(e=>{console.error(e);process.exit(1);});
