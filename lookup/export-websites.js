#!/usr/bin/env node
/** Refresh build/data/websites.json from Knack object_153. Server-side only. */
const fs=require('fs'),path=require('path');
const API=process.env.REACT_APP_KNACK_API_KEY,APP=process.env.REACT_APP_KNACK_APP_ID;
if(!API||!APP){console.error('Set REACT_APP_KNACK_API_KEY and REACT_APP_KNACK_APP_ID');process.exit(1);}
const strip=v=>typeof v==='string'?v.replace(/<[^>]+>/g,'').trim():(v==null?'':v);
const money=v=>{const n=parseFloat(String(v||'').replace(/[^0-9.]/g,''));return isNaN(n)?0:n;};
const MULT={monthly:1,quarterly:1/3,'semi-annually':1/6,annually:1/12,'':1};
const plat=p=>{const s=(p||'').trim().toLowerCase();if(s==='smart1sites')return 'Smart1Sites';if(s==='wordpress')return 'WordPress';return (p||'').trim();};
(async()=>{
  let page=1,recs=[];
  while(true){
    const res=await fetch(`https://api.knack.com/v1/objects/object_153/records?rows_per_page=1000&page=${page}`,
      {headers:{'X-Knack-REST-API-Key':API,'X-Knack-Application-Id':APP,'Content-Type':'application/json'}});
    if(!res.ok)throw new Error('Knack '+res.status);
    const data=await res.json();recs=recs.concat(data.records||[]);
    if(page>=(data.total_pages||1))break;page++;
  }
  const out=recs.map(r=>{
    const status=(strip(r.field_3193)||'').replace(/^./,c=>c.toUpperCase());
    const hm=money(r.field_3050),freq=(strip(r.field_3157)||'').toLowerCase();
    return {id:r.id,name:strip(r.field_3112),domain:strip(r.field_2925),liveUrl:strip(r.field_3111),
      s1url:strip(r.field_2962),platform:plat(strip(r.field_2927)),status,active:status.toLowerCase()==='active',
      partner:strip(r.field_3113),manager:strip(r.field_2932),hm,hmFreq:strip(r.field_3157),
      hmMonthly:Math.round(hm*(MULT[freq]??1)*100)/100,registrar:strip(r.field_2926),domainCost:money(r.field_3064),
      domainPurchased:strip(r.field_2964)==='Yes',ga:strip(r.field_2929),gtm:strip(r.field_2930),
      created:strip(r.field_2933),notes:strip(r.field_3068)};
  });
  fs.writeFileSync(path.join(__dirname,'build','data','websites.json'),JSON.stringify({recordCount:out.length,records:out}));
  console.log(`Wrote ${out.length} websites`);
})().catch(e=>{console.error(e);process.exit(1);});
