import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const EMAIL     = process.env.LEGHE_EMAIL || '';
const PASSWORD  = process.env.LEGHE_PASSWORD || '';
const UPLOAD_URL   = process.env.UPLOAD_URL || '';
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN || '';

const OUT_CACHE = path.join(__dirname, '..', 'cache', 'rose_leghe.xlsx');
const OUT_FINAL = path.join(__dirname, '..', 'negher rosters.xlsx');
const LOGIN_URL = 'https://leghe.fantacalcio.it/login';
const ROSE_URL  = 'https://leghe.fantacalcio.it/negherleague/rose';
const NAV_TIMEOUT = 120_000;

const log = (...a) => console.log(new Date().toISOString(), '-', ...a);
async function ensureDirFor(p){ await fs.mkdir(path.dirname(p), { recursive:true }); }
async function safeGoto(page, url){
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }); } catch(e){ log('goto warn:', e?.message||e); }
  await page.waitForTimeout(500);
}
async function dismissBanners(page){
  for (const sel of ['button:has-text("Accetta")','button:has-text("Accetto")','button:has-text("Consenti")','button:has-text("Chiudi")']) {
    const el = page.locator(sel).first();
    try { if (await el.count() && await el.isVisible()) await el.click({ timeout: 1200 }); } catch {}
  }
}
async function login(page){
  if (!EMAIL || !PASSWORD) throw new Error('Mancano LEGHE_EMAIL/LEGHE_PASSWORD');
  await safeGoto(page, LOGIN_URL);
  let ctx = page;
  if (!(await page.locator('input[type="password"]:visible, input[name="password"]:visible').count())) {
    for (const f of page.frames()){
      if (await f.locator('input[type="password"]:visible, input[name="password"]:visible').count()) { ctx = f; break; }
    }
  }
  const email = ctx.locator('input[type="email"]:visible, input[name="email"]:visible, input[name="username"]:visible').first();
  const pass  = ctx.locator('input[type="password"]:visible, input[name="password"]:visible').first();
  if (!(await email.count()) || !(await pass.count())) return; // forse già loggato
  await email.fill(EMAIL, { timeout: NAV_TIMEOUT });
  await pass.fill(PASSWORD, { timeout: NAV_TIMEOUT });
  const submit = ctx.locator('button[type="submit"]:visible, input[type="submit"]:visible, button:has-text("Accedi"):visible, button:has-text("Entra"):visible').first();
  if (await submit.count()) await submit.click().catch(()=>pass.press('Enter')); else await pass.press('Enter');
  await page.waitForTimeout(1500);
}
async function downloadXlsx(page, outPath){
  const sels = [
    'a:has-text("XLSX")','button:has-text("XLSX")',
    'a:has-text("Scarica XLSX")','button:has-text("Scarica XLSX")',
    'a[href$=".xlsx"]','a[download$=".xlsx"]'
  ];
  let link = null;
  for (const sel of sels){
    const cand = page.locator(sel).first();
    try { if (await cand.count()) { await cand.waitFor({ state:'visible', timeout:7000 }); if (await cand.isVisible()) { link = cand; break; } } } catch {}
  }
  if (!link) throw new Error('Bottone/Link XLSX non trovato');
  const [download] = await Promise.all([ page.waitForEvent('download', { timeout: NAV_TIMEOUT }), link.click() ]);
  await ensureDirFor(outPath);
  try { await fs.unlink(outPath); } catch {}
  await download.saveAs(outPath);
  log(`Scaricato (XLSX): ${outPath}`);
}
async function uploadViaHttp(localPath){
  if (!UPLOAD_URL || !UPLOAD_TOKEN) throw new Error('Manca UPLOAD_URL/UPLOAD_TOKEN');
  const buf = await fs.readFile(localPath);
  const form = new FormData();
  form.append('token', UPLOAD_TOKEN);
  form.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'negher rosters.xlsx');

  const res = await fetch(UPLOAD_URL, { method:'POST', body: form });
  const text = await res.text();
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0,160)}...`);
  if (!ct.includes('application/json')) throw new Error(`Risposta non JSON (endpoint sbagliato?): ${text.slice(0,160)}...`);
  log('HTTP upload OK:', text);
}
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ acceptDownloads: true });
  try {
    await ctx.route('**/*', route => {
      const u = route.request().url();
      if (/googletagmanager|google-analytics|doubleclick|facebook|hotjar|optimizely|segment|sentry|datadog/i.test(u)) return route.abort();
      return route.continue();
    });
    const page = await ctx.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);

    await login(page);
    await safeGoto(page, ROSE_URL);
    await dismissBanners(page);
    await downloadXlsx(page, OUT_CACHE);

    try { await fs.unlink(OUT_FINAL); } catch {}
    await ensureDirFor(OUT_FINAL);
    await fs.rename(OUT_CACHE, OUT_FINAL);
    log(`OK: rinominato in ${OUT_FINAL}`);

    await uploadViaHttp(OUT_FINAL);
  } finally {
    await ctx.close().catch(()=>{});
    await browser.close().catch(()=>{});
  }
})().catch(err => { console.error('Errore downloader:', err?.message || err); process.exit(2); });
