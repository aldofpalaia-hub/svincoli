import fs from 'fs';
const src='auth.json', dst='auth_min.json';
const allow=['leghe.fantacalcio.it','.fantacalcio.it','apileague.fantacalcio.it'];
const raw=JSON.parse(fs.readFileSync(src,'utf8'));
raw.cookies=(raw.cookies||[]).filter(c=>allow.some(d=>(c.domain||'').endsWith(d)));
raw.origins=(raw.origins||[]).filter(o=>(o.origin||'').includes('https://leghe.fantacalcio.it'))
  .map(o=>({origin:o.origin, localStorage:o.localStorage||[]}));
fs.writeFileSync(dst, JSON.stringify(raw));
console.log('Auth ridotto:', fs.statSync(dst).size,'bytes');
