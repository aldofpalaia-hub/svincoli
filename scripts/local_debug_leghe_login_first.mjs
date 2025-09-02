// scripts/local_debug_leghe_login_first.mjs
// Debug locale: APRE /login per primo, login (manuale o con credenziali), poi /rose, clic XLSX.
// Browser visibile + salvataggi debug.

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { chromium } from 'playwright';

const EMAIL = process.env.LEGHE_EMAIL || '';
const PASS  = process.env.LEGHE_PASSWORD || '';

const LOGIN_URL = 'https://leghe.fantacalcio.it/login';
const HOME_URL  = 'https://leghe.fantacalcio.it/negherleague';
const ROSE_URL  = 'https://leghe.fantacalcio.it/negherleague/rose';

const OUT_CACHE = path.resolve('cache/rose_leghe.xlsx');
const OUT_FINAL = path.resolve('negher rosters.xlsx');
const DEBUG_DIR = path.resolve('debug');

const HEADLESS = false;   // vedi il browser
const SLOWMO   = 120;     // un po' di rallenty per capire cosa fa
const NAV_TIMEOUT = 120_000;

const log = (...a)=>console.log(new Date().toISOString(), '-', ...a);

async function ensureDirFor(p){ await fs.mkdir(path.dirname(p), { recursive:true }); }
async function saveDebug(page,name='last'){
  try{
    await fs.mkdir(DEBUG_DIR,{recursive:true});
    await page.screenshot({ path: path.join(DEBUG_DIR, `${name}.png`), fullPage:true });
    await fs.writeFile(path.join(DEBUG_DIR, `${name}.html`), await page.content(), 'utf8');
    const links = await page.$$eval('a,button', els => els.map(e=>({
      tag:e.tagName.toLowerCase(), txt:(e.innerText||'').trim(), href:e.getAttribute('href')||'', dl:e.getAttribute('download')||''
    })));
    await fs.writeFile(path.join(DEBUG_DIR, `${name}_links.json`), JSON.stringify(links,null,2));
  }catch{}
}
function waitEnter(msg='Premi INVIO per continuare…'){
  console.log('\n👉', msg);
  return new Promise(r=>{ process.stdin.resume(); process.stdin.once('data',()=>{ process.stdin.pause(); r(); }); });
}
async function safeGoto(page,url){
  try{ await page.goto(url,{waitUntil:'domcontentloaded', timeout:NAV_TIMEOUT}); }catch(e){ log('goto warn:', e?.message||e); }
  await page.waitForTimeout(700);
}

// ——— cookie/privacy banner killer (anche in iframe) ———
async function clickConsentIn(ctx){
  const sels = [
    'button:has-text("Salva Impostazioni")',
    'button:has-text("Accetta")','button:has-text("Accetto")','button:has-text("Consenti")',
    'button:has-text("Ho capito")','button:has-text("OK")','button:has-text("Chiudi")',
    '.pt-huU button:has-text("Salva Impostazioni")',
    '.pt-huU button:has-text("Accetta")'
  ];
  for (const s of sels){
    const el = ctx.locator(s).first();
    try{ if (await el.count() && await el.isVisible()){ await el.click({timeout:1200}); return true; } }catch{}
  }
  return false;
}
async function dismissBannersDeep(page){
  let did=false;
  for (let i=0;i<5;i++){
    did = (await clickConsentIn(page)) || did;
    for (const f of page.frames()){ try{ did = (await clickConsentIn(f)) || did; }catch{} }
    if (!did) break;
    await page.waitForTimeout(500);
  }
  return did;
}

// ——— LOGIN (forzato aprendo /login come prima pagina) ———
async function loginFlow(page){
  await safeGoto(page, LOGIN_URL);
  await dismissBannersDeep(page);
  await saveDebug(page, 'login_page');

  if (process.env.MANUAL_LOGIN === '1'){
    await waitEnter('Completa il login NELLA FINESTRA (utente+password) e poi premi INVIO qui.');
    return;
  }

  // prova con credenziali .env
  let ctx = page;
  if (!(await page.locator('input[type="password"], input[name="password"]').count())){
    for (const f of page.frames()){
      if (await f.locator('input[type="password"], input[name="password"]').count()){ ctx=f; break; }
    }
  }

  const email = ctx.locator('input[type="email"], input[name="email"], input[name="username"]').first();
  const pass  = ctx.locator('input[type="password"], input[name="password"]').first();

  if (!(await email.count()) || !(await pass.count())){
    log('Form login non trovato (forse già loggato).');
    return;
  }

  if (!EMAIL || !PASS){
    log('Mancano LEGHE_EMAIL/LEGHE_PASSWORD — usa MANUAL_LOGIN=1 e fai login a mano.');
    await waitEnter('Fai login a mano e premi INVIO quando sei dentro.');
    return;
  }

  await email.fill(EMAIL, { timeout: NAV_TIMEOUT });
  await pass.fill(PASS,   { timeout: NAV_TIMEOUT });

  const submit = ctx.locator([
    'button[type="submit"]','input[type="submit"]',
    'button:has-text("Accedi")','button:has-text("Login")','button:has-text("Entra")'
  ].join(',')).first();
  try{ await submit.click({ timeout: 1500 }); }catch{ await pass.press('Enter'); }
  await page.waitForTimeout(1500);
}

// ——— Verifica che NON sia guest (barra “ACCEDI” assente) ———
async function ensureLogged(page){
  // vero check: la pagina guest ha <body class="guest">
  const isGuest = await page.evaluate(() => document.body.classList.contains('guest'));
  if (isGuest) {
    await saveDebug(page, 'still_guest');
    throw new Error('Non autenticato (body.guest presente). Completa il login o controlla le credenziali.');
  }

  // opzionale: ulteriore conferma — esiste un menu utente/log out?
  const hasUserMenu = await page.locator('a[href*="logout"], [class*="user"], [data-user]').first().count().catch(()=>0);
  if (!hasUserMenu) {
    // non bloccare, ma lascia un log (alcune skin non espongono logout)
    log('Nota: non ho trovato un chiaro user-menu, ma non sei in modalità guest.');
  }
}


// ——— Clic XLSX ———
async function openDownloadMenus(page){
  const toggles=['button:has-text("Scarica")','a:has-text("Scarica")','button:has-text("Esporta")','a:has-text("Esporta")','.dropdown-toggle'];
  for (const sel of toggles){
    const el = page.locator(sel).first();
    try{ if (await el.count() && await el.isVisible()){ await el.click({timeout:1000}); await page.waitForTimeout(250);} }catch{}
  }
}
async function downloadXlsx(page, outPath){
  await openDownloadMenus(page);
  const selectors = [
    'a:has-text("XLSX")','button:has-text("XLSX")',
    'a:has-text("Scarica XLSX")','button:has-text("Scarica XLSX")',
    'a:has-text("Excel")','button:has-text("Excel")',
    'a[href$=".xlsx"]','a[href*=".xlsx"]','a[download$=".xlsx"]','a[download*=".xlsx"]'
  ];
  for (let pass=0; pass<2; pass++){
    if (pass===1){ await page.keyboard.press('End'); await page.waitForTimeout(600); await openDownloadMenus(page); }
    for (const sel of selectors){
      const cand = page.locator(sel).first();
      try{
        if (await cand.count()){
          await cand.waitFor({state:'visible', timeout:5000});
          if (await cand.isVisible()){
            const [dl] = await Promise.all([ page.waitForEvent('download', {timeout:NAV_TIMEOUT}), cand.click() ]);
            await ensureDirFor(outPath);
            try{ await fs.unlink(outPath); }catch{}
            await dl.saveAs(outPath);
            log(`Scaricato (XLSX): ${outPath}`);
            return outPath;
          }
        }
      }catch{}
    }
  }
  await saveDebug(page, 'no_xlsx');
  throw new Error('Bottone/Link XLSX non trovato sulla pagina.');
}

// ——— MAIN ———
(async()=>{
  await ensureDirFor(OUT_CACHE); await ensureDirFor(OUT_FINAL);

  const browser = await chromium.launch({ headless: HEADLESS, slowMo: SLOWMO });
  const ctx = await browser.newContext({ acceptDownloads:true });
  await ctx.route('**/*', route => {
    const u = route.request().url();
    if (/\.(mp4|webm|m3u8)$/i.test(u)) return route.abort();
    if (/doubleclick|facebook|hotjar|optimizely|segment|datadog/i.test(u)) return route.abort();
    return route.continue();
  });
  const page = await ctx.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);

  try{
    // 1) LOGIN PRIMA DI TUTTO
    await loginFlow(page);

    // 2) Vai in home lega, chiudi banner e verifica login
    await safeGoto(page, HOME_URL);
    await dismissBannersDeep(page);
    await ensureLogged(page);

    // 3) Vai su ROSE e scarica
    await safeGoto(page, ROSE_URL);
    await dismissBannersDeep(page);
    await saveDebug(page,'rose');

    await downloadXlsx(page, OUT_CACHE);
    try{ await fs.unlink(OUT_FINAL); }catch{}
    await fs.rename(OUT_CACHE, OUT_FINAL);
    log(`OK: rinominato in ${OUT_FINAL}`);
  }catch(e){
    log('ERRORE:', e?.message || e);
    await saveDebug(page,'error');
  }finally{
    await browser.close();
  }
})();
