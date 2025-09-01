// scripts/download_leghe_rosters_ci.mjs
// CI headless: apre /login, fa login con secrets, chiude CMP, va su /rose, scarica XLSX e lo invia via HTTP.

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { chromium } from 'playwright';

const EMAIL = process.env.LEGHE_EMAIL || '';
const PASS  = process.env.LEGHE_PASSWORD || '';
const UPLOAD_URL   = process.env.UPLOAD_URL || '';
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN || '';

const LOGIN_URL = 'https://leghe.fantacalcio.it/login';
const HOME_URL  = 'https://leghe.fantacalcio.it/negherleague';
const ROSE_URL  = 'https://leghe.fantacalcio.it/negherleague/rose';

const CACHE_DIR = path.resolve('cache');
const OUT_CACHE = path.join(CACHE_DIR, 'rose_leghe.xlsx');
const OUT_FINAL = path.resolve('negher rosters.xlsx');
const DEBUG_DIR = path.resolve('debug');

const NAV_TIMEOUT = 120_000;
const log = (...a)=>console.log(new Date().toISOString(), '-', ...a);

async function ensure(p){ await fs.mkdir(p, { recursive:true }); }
async function saveDebug(page, name='last'){
  try{
    await ensure(DEBUG_DIR);
    await page.screenshot({ path: path.join(DEBUG_DIR, `${name}.png`), fullPage:true });
    await fs.writeFile(path.join(DEBUG_DIR, `${name}.html`), await page.content(), 'utf8');
  }catch{}
}
async function safeGoto(page,url){
  try{ await page.goto(url,{waitUntil:'domcontentloaded', timeout:NAV_TIMEOUT}); }catch(e){ log('goto warn:', e?.message||e); }
  await page.waitForTimeout(500);
}

// cookie/privacy banner killer (anche in iframe)
async function clickConsentIn(ctx){
  const sels = [
    'button:has-text("Salva Impostazioni")',
    'button:has-text("Accetta")','button:has-text("Accetto")','button:has-text("Consenti")',
    'button:has-text("Ho capito")','button:has-text("OK")','button:has-text("Chiudi")',
    '.pt-huU button:has-text("Salva Impostazioni")','.pt-huU button:has-text("Accetta")'
  ];
  for (const s of sels){
    const el = ctx.locator(s).first();
    try{ if (await el.count() && await el.isVisible()){ await el.click({timeout:1200}); return true; } }catch{}
  }
  return false;
}
async function dismissBannersDeep(page){
  for (let i=0;i<5;i++){
    let did = (await clickConsentIn(page));
    for (const f of page.frames()){ try{ did = (await clickConsentIn(f)) || did; }catch{} }
    if (!did) break;
    await page.waitForTimeout(300);
  }
}

async function login(page){
  await safeGoto(page, LOGIN_URL);
  await dismissBannersDeep(page);

  let ctx = page;
  if (!(await page.locator('input[type="password"], input[name="password"]').count())){
    for (const f of page.frames()){
      if (await f.locator('input[type="password"], input[name="password"]').count()){ ctx=f; break; }
    }
  }
  const email = ctx.locator('input[type="email"], input[name="email"], input[name="username"]').first();
  const pass  = ctx.locator('input[type="password"], input[name="password"]').first();

  if (!(await email.count()) || !(await pass.count())) {
    log('Form login non trovato: forse già loggato.');
    return;
  }
  if (!EMAIL || !PASS) throw new Error('Mancano LEGHE_EMAIL/LEGHE_PASSWORD negli env/secrets.');

  await email.fill(EMAIL, { timeout: NAV_TIMEOUT });
  await pass.fill(PASS,   { timeout: NAV_TIMEOUT });
  const submit = ctx.locator([
    'button[type="submit"]','input[type="submit"]',
    'button:has-text("Accedi")','button:has-text("Login")','button:has-text("Entra")'
  ].join(',')).first();
  try{ await submit.click({ timeout:1500 }); }catch{ await pass.press('Enter'); }
  await page.waitForTimeout(1500);
}

async function ensureLogged(page){
  const isGuest = await page.evaluate(() => document.body.classList.contains('guest'));
  if (isGuest){
    await saveDebug(page,'still_guest');
    throw new Error('Non autenticato (body.guest presente).');
  }
}

async function openDownloadMenus(page){
  const toggles=['button:has-text("Scarica")','a:has-text("Scarica")','button:has-text("Esporta")','a:has-text("Esporta")','.dropdown-toggle'];
  for (const sel of toggles){
    const el = page.locator(sel).first();
    try{ if (await el.count() && await el.isVisible()){ await el.click({timeout:1000}); await page.waitForTimeout(200);} }catch{}
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
            try{ await fs.unlink(outPath); }catch{}
            await dl.saveAs(outPath);
            log(`Scaricato (XLSX): ${outPath}`);
            return;
          }
        }
      }catch{}
    }
  }
  await saveDebug(page,'no_xlsx');
  throw new Error('Bottone/Link XLSX non trovato sulla pagina.');
}

async function httpUpload(filePath){
  if (!UPLOAD_URL || !UPLOAD_TOKEN){ log('HTTP upload disabilitato: manca UPLOAD_URL/UPLOAD_TOKEN.'); return; }
  const buf = await fs.readFile(filePath);
  const form = new FormData();
  form.append('token', UPLOAD_TOKEN);
  form.append('file', new Blob([buf], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'negher rosters.xlsx');
  const res = await fetch(UPLOAD_URL, { method:'POST', body: form });
  const txt = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0,200)}`);
  log(`HTTP upload OK: ${txt.slice(0,200)}...`);
}

(async()=>{
  await ensure(CACHE_DIR); await ensure(DEBUG_DIR);
  const browser = await chromium.launch({ headless:true, args:['--no-sandbox'] });
  const ctx = await browser.newContext({ acceptDownloads:true, userAgent:'Mozilla/5.0 PlaywrightCI' });

  await ctx.route('**/*', route => {
    const u = route.request().url();
    if (/doubleclick|facebook|hotjar|optimizely|segment|datadog/i.test(u)) return route.abort();
    if (/\.(mp4|webm|m3u8)$/i.test(u)) return route.abort();
    return route.continue();
  });

  const page = await ctx.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);

  try{
    await login(page);
    await safeGoto(page, HOME_URL);
    await dismissBannersDeep(page);
    await ensureLogged(page);

    await safeGoto(page, ROSE_URL);
    await dismissBannersDeep(page);
    await saveDebug(page,'rose');

    await downloadXlsx(page, OUT_CACHE);
    try{ await fs.unlink(OUT_FINAL); }catch{}
    await fs.rename(OUT_CACHE, OUT_FINAL);
    log(`OK: rinominato in ${OUT_FINAL}`);

    await httpUpload(OUT_FINAL);
  }catch(e){
    await saveDebug(page,'error');
    console.error('Errore downloader:', e?.message || e);
    process.exit(2);
  }finally{
    await browser.close();
  }
})();
