// scripts/download_leghe_rosters_ci.mjs
// Playwright headless: login → pagina rose → click "XLSX" → upload via HTTP token
// Requisiti: npm i playwright dotenv  &&  npx playwright install --with-deps chromium

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ====== Config da Secrets/Env ======
const EMAIL        = process.env.LEGHE_EMAIL || '';
const PASSWORD     = process.env.LEGHE_PASSWORD || '';
const UPLOAD_URL   = process.env.UPLOAD_URL || '';
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN || '';

// ====== Percorsi locali ======
const OUT_CACHE = path.join(__dirname, '..', 'cache', 'rose_leghe.xlsx');
const OUT_FINAL = path.join(__dirname, '..', 'negher rosters.xlsx');
const DEBUG_DIR = path.join(__dirname, '..', 'debug');

// ====== URL target ======
const LOGIN_URL = 'https://leghe.fantacalcio.it/login';
const ROSE_URL  = 'https://leghe.fantacalcio.it/negherleague/rose';

// ====== Timeout/network ======
const NAV_TIMEOUT = 180_000; // 180s per siti lenti
const log = (...a) => console.log(new Date().toISOString(), '-', ...a);

// ---------- Utils ----------
async function ensureDirFor(p) { await fs.mkdir(path.dirname(p), { recursive: true }); }
async function ensureDir(dir)  { await fs.mkdir(dir, { recursive: true }); }

async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  } catch (e) {
    log('goto warn:', e?.message || e);
  }
  await page.waitForTimeout(500);
}

async function dismissBanners(page) {
  const sels = [
    'button:has-text("Accetta")','button:has-text("Accetto")','button:has-text("Consenti")','button:has-text("Chiudi")',
    '[role="button"]:has-text("Accetta")'
  ];
  for (const sel of sels) {
    const el = page.locator(sel).first();
    try { if (await el.count() && await el.isVisible()) await el.click({ timeout: 1200 }); } catch {}
  }
}

async function maybeCaptcha(page) {
  // Semplice detection: se troviamo frame reCAPTCHA v2/v3, avvisiamo
  const frames = page.frames().map(f => f.url());
  if (frames.some(u => /google\.com\/recaptcha|gstatic\.com\/recaptcha/i.test(u))) {
    throw new Error('Captcha rilevato sulla pagina di login.');
  }
}

async function login(page) {
  if (!EMAIL || !PASSWORD) throw new Error('Mancano LEGHE_EMAIL/LEGHE_PASSWORD negli env/secrets.');
  await safeGoto(page, LOGIN_URL);
  await dismissBanners(page);
  await maybeCaptcha(page);

  let ctx = page;
  // Se i campi non sono nel main frame, cerca tra gli iframe
  if (!(await page.locator('input[type="password"]:visible, input[name="password"]:visible').count())) {
    for (const f of page.frames()) {
      if (await f.locator('input[type="password"]:visible, input[name="password"]:visible').count()) { ctx = f; break; }
    }
  }

  const email = ctx.locator('input[type="email"]:visible, input[name="email"]:visible, input[name="username"]:visible').first();
  const pass  = ctx.locator('input[type="password"]:visible, input[name="password"]:visible').first();

  // Se i campi non ci sono, presumiamo sessione già attiva
  if (!(await email.count()) || !(await pass.count())) {
    log('Campi login non trovati: forse già autenticato.');
    return;
  }

  await email.fill(EMAIL, { timeout: NAV_TIMEOUT });
  await pass.fill(PASSWORD, { timeout: NAV_TIMEOUT });

  const submit = ctx.locator([
    'button[type="submit"]:visible','input[type="submit"]:visible',
    'button:has-text("Accedi"):visible','button:has-text("Login"):visible','button:has-text("Entra"):visible'
  ].join(', ')).first();

  if (await submit.count()) await Promise.all([ page.waitForLoadState('domcontentloaded'), submit.click().catch(()=>pass.press('Enter')) ]);
  else await pass.press('Enter');

  await page.waitForTimeout(1200);
  await maybeCaptcha(page);
}

async function downloadXlsx(page, outPath) {
  const selectors = [
    'a:has-text("XLSX")','button:has-text("XLSX")',
    'a:has-text("Scarica XLSX")','button:has-text("Scarica XLSX")',
    'a[href$=".xlsx"]','a[download$=".xlsx"]','a[download*=".xlsx"]'
  ];
  let link = null;
  for (const sel of selectors) {
    const cand = page.locator(sel).first();
    try {
      if (await cand.count()) {
        await cand.waitFor({ state: 'visible', timeout: 7000 });
        if (await cand.isVisible()) { link = cand; break; }
      }
    } catch {}
  }
  if (!link) throw new Error('Bottone/Link XLSX non trovato sulla pagina delle rose.');

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: NAV_TIMEOUT }),
    link.click()
  ]);

  await ensureDirFor(outPath);
  try { await fs.unlink(outPath); } catch {}
  await download.saveAs(outPath);
  log(`Scaricato (XLSX): ${outPath}`);
}

async function uploadViaHttp(localPath) {
  if (!UPLOAD_URL || !UPLOAD_TOKEN) throw new Error('Manca UPLOAD_URL/UPLOAD_TOKEN (secrets).');
  const buf = await fs.readFile(localPath);

  const form = new FormData();
  form.append('token', UPLOAD_TOKEN);
  form.append(
    'file',
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    'negher rosters.xlsx'
  );

  const res = await fetch(UPLOAD_URL, { method: 'POST', body: form });
  const text = await res.text();
  const ct = (res.headers.get('content-type') || '').toLowerCase();

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0,160)}...`);
  if (!ct.includes('application/json')) throw new Error(`Risposta non JSON dall'endpoint (URL sbagliato?): ${text.slice(0,160)}...`);
  log('HTTP upload OK:', text);
}

// ---------- MAIN ----------
(async () => {
  await ensureDir(DEBUG_DIR);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  // Contesto con fingerprint "più umano"
  const ctx = await browser.newContext({
    acceptDownloads: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
    viewport: { width: 1440, height: 900 },
  });

  // Nascondi navigator.webdriver
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // Evita tracker che rallentano
  await ctx.route('**/*', route => {
    const u = route.request().url();
    if (/googletagmanager|google-analytics|doubleclick|facebook|hotjar|optimizely|segment|sentry|datadog/i.test(u)) return route.abort();
    return route.continue();
  });

  const page = await ctx.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);

  try {
    await login(page);
    await safeGoto(page, ROSE_URL);
    await dismissBanners(page);

    await downloadXlsx(page, OUT_CACHE);

    // rinomina/sposta
    try { await fs.unlink(OUT_FINAL); } catch {}
    await ensureDirFor(OUT_FINAL);
    await fs.rename(OUT_CACHE, OUT_FINAL);
    log(`OK: rinominato in ${OUT_FINAL}`);

    await uploadViaHttp(OUT_FINAL);
  } catch (err) {
    // Dump debug per capire i fallimenti su CI
    log('Errore downloader:', err?.message || err);
    try {
      const shot = path.join(DEBUG_DIR, 'last.png');
      const html = path.join(DEBUG_DIR, 'last.html');
      await page.screenshot({ path: shot, fullPage: true }).catch(()=>{});
      const content = await page.content().catch(()=>null);
      if (content) await fs.writeFile(html, content);
      log('Salvati artefatti di debug in', DEBUG_DIR);
    } catch {}
    process.exit(2);
  } finally {
    await ctx.close().catch(()=>{});
    await browser.close().catch(()=>{});
  }
})();
