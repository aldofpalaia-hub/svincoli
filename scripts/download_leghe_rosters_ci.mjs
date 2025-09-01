// scripts/download_leghe_rosters_ci.mjs
// CI headless: apre /login, accetta il CMP, fa login con i secrets,
// va su /negherleague/rose, clicca "XLSX", rinomina in "negher rosters.xlsx",
// e invia il file via HTTP a UPLOAD_URL (con UPLOAD_TOKEN).

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { chromium } from 'playwright';

const EMAIL        = process.env.LEGHE_EMAIL || '';
const PASSWORD     = process.env.LEGHE_PASSWORD || '';
const UPLOAD_URL   = process.env.UPLOAD_URL || '';
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN || '';

const LOGIN_URL = 'https://leghe.fantacalcio.it/login';
const HOME_URL  = 'https://leghe.fantacalcio.it/negherleague';
const ROSE_URL  = 'https://leghe.fantacalcio.it/negherleague/rose';

const CACHE_DIR = path.resolve('cache');
const DEBUG_DIR = path.resolve('debug');
const OUT_CACHE = path.join(CACHE_DIR, 'rose_leghe.xlsx');
const OUT_FINAL = path.resolve('negher rosters.xlsx');

const NAV_TIMEOUT = 120_000;
const log = (...a) => console.log(new Date().toISOString(), '-', ...a);

async function ensure(dir) { await fs.mkdir(dir, { recursive: true }); }
async function ensureFor(file) { await fs.mkdir(path.dirname(file), { recursive: true }); }

async function saveDebug(page, name = 'last') {
  try {
    await ensure(DEBUG_DIR);
    await page.screenshot({ path: path.join(DEBUG_DIR, `${name}.png`), fullPage: true });
    await fs.writeFile(path.join(DEBUG_DIR, `${name}.html`), await page.content(), 'utf8');
  } catch {}
}

async function safeGoto(page, url) {
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }); }
  catch (e) { log('goto warn:', e?.message || e); }
  await page.waitForTimeout(500);
}

/* ---------------- CMP/COOKIE ---------------- */

async function acceptCookiesOne(ctx) {
  const sels = [
    'button[mode="accept-all"]',                // Pubtech webcomponent
    '[data-pt-variant="acceptAll"] button',
    'button:has-text("Accept All")',
    'button:has-text("Accetta")',
    'button:has-text("Ho capito")',
    'button:has-text("OK")',
    'button:has-text("Chiudi")'
  ];
  for (const s of sels) {
    const btn = ctx.locator(s).first();
    try {
      if (await btn.count() && await btn.isVisible()) {
        await btn.click({ timeout: 1500 });
        return true;
      }
    } catch {}
  }
  return false;
}

async function acceptCookies(page) {
  // prova ad aprire esplicitamente la UI del CMP
  await page.evaluate(() => { try { window.__tcfapi && window.__tcfapi('displayConsentUi', 2, ()=>{}); } catch(e){} });
  await page.waitForTimeout(900);

  let did = await acceptCookiesOne(page);
  for (const f of page.frames()) {
    try { did = (await acceptCookiesOne(f)) || did; } catch {}
  }

  // ultimo tentativo nel DOM principale (shadowless)
  await page.evaluate(() => {
    try {
      const root = document.querySelector('#pubtech-cmp');
      const el = root && (root.querySelector('button[mode="accept-all"]') ||
                          root.querySelector('[data-pt-variant="acceptAll"] button'));
      el && el.click();
    } catch {}
  });

  if (did) await page.waitForTimeout(400);
}

/* ---------------- LOGIN ---------------- */

async function forceLogin(page) {
  if (!EMAIL || !PASSWORD) throw new Error('Mancano LEGHE_EMAIL/LEGHE_PASSWORD negli env/secrets.');
  await safeGoto(page, LOGIN_URL);
  await acceptCookies(page);

  // form dentro la pagina o in iframe
  let ctx = page;
  if (!(await page.locator('input[name="password"]').count())) {
    for (const f of page.frames()) {
      if (await f.locator('input[name="password"]').count()) { ctx = f; break; }
    }
  }

  const user = ctx.locator('input[name="username"], input[name="email"]').first();
  const pass = ctx.locator('input[name="password"]').first();
  if (!(await user.count()) || !(await pass.count())) {
    log('Form login non trovato (forse già loggato).');
    return;
  }

  await user.fill(EMAIL, { timeout: 15000 });
  await pass.fill(PASSWORD, { timeout: 15000 });

  const submit = ctx.locator('#buttonLogin, button[type="submit"], input[type="submit"], button:has-text("Accedi"), button:has-text("Login")').first();
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(()=>{}),
    submit.click().catch(() => pass.press('Enter'))
  ]);

  await acceptCookies(page);
}

/* ---------------- VERIFICA LOGIN ---------------- */

async function ensureLogged(page) {
  // il sito mette "guest" sul body quando non autenticato
  const guest = await page.evaluate(() => document.body.classList.contains('guest'));
  if (guest) {
    await saveDebug(page, 'still_guest');
    throw new Error('Non autenticato (body.guest presente).');
  }
}

/* ---------------- DOWNLOAD XLSX ---------------- */

async function openDownloadMenus(page) {
  const toggles = [
    'button:has-text("Scarica")', 'a:has-text("Scarica")',
    'button:has-text("Esporta")', 'a:has-text("Esporta")',
    '.dropdown-toggle'
  ];
  for (const sel of toggles) {
    const el = page.locator(sel).first();
    try { if (await el.count() && await el.isVisible()) { await el.click({ timeout: 1000 }); await page.waitForTimeout(200); } } catch {}
  }
}

async function downloadXlsx(page, outPath) {
  await openDownloadMenus(page);

  const sels = [
    'a:has-text("XLSX")', 'button:has-text("XLSX")',
    'a:has-text("Scarica XLSX")', 'button:has-text("Scarica XLSX")',
    'a:has-text("Excel")', 'button:has-text("Excel")',
    'a[href$=".xlsx"]', 'a[href*=".xlsx"]', 'a[download$=".xlsx"]', 'a[download*=".xlsx"]'
  ];

  for (let pass = 0; pass < 2; pass++) {
    if (pass === 1) { await page.keyboard.press('End'); await page.waitForTimeout(600); await openDownloadMenus(page); }
    for (const sel of sels) {
      const cand = page.locator(sel).first();
      try {
        if (await cand.count()) {
          await cand.waitFor({ state: 'visible', timeout: 5000 });
          if (await cand.isVisible()) {
            const [dl] = await Promise.all([
              page.waitForEvent('download', { timeout: NAV_TIMEOUT }),
              cand.click()
            ]);
            await ensureFor(outPath);
            try { await fs.unlink(outPath); } catch {}
            await dl.saveAs(outPath);
            log(`Scaricato (XLSX): ${outPath}`);
            return;
          }
        }
      } catch {}
    }
  }

  await saveDebug(page, 'no_xlsx');
  throw new Error('Bottone/Link XLSX non trovato sulla pagina.');
}

/* ---------------- UPLOAD VIA HTTP ---------------- */

async function httpUpload(filePath) {
  if (!UPLOAD_URL || !UPLOAD_TOKEN) {
    log('HTTP upload disabilitato: manca UPLOAD_URL/UPLOAD_TOKEN.');
    return;
  }
  const buf = await fs.readFile(filePath);
  const form = new FormData();
  form.append('token', UPLOAD_TOKEN);
  form.append('file', new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }), 'negher rosters.xlsx');

  const res = await fetch(UPLOAD_URL, { method: 'POST', body: form });
  const txt = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0,200)}`);
  log(`HTTP upload OK: ${txt.slice(0,200)}...`);
}

/* ---------------- MAIN ---------------- */

(async () => {
  await ensure(CACHE_DIR);
  await ensure(DEBUG_DIR);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  const ctx = await browser.newContext({
    acceptDownloads: true,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) PlaywrightCI Safari/537.36'
  });

  // filtra roba pesante/tracker
  await ctx.route('**/*', route => {
    const u = route.request().url();
    if (/doubleclick|googletagmanager|google-analytics|facebook|hotjar|optimizely|segment|datadog/i.test(u)) return route.abort();
    if (/\.(mp4|webm|m3u8)$/i.test(u)) return route.abort();
    return route.continue();
  });

  const page = await ctx.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);

  try {
    // 1) Login
    await forceLogin(page);

    // 2) Vai in lega e verifica sessione
    await safeGoto(page, HOME_URL);
    await acceptCookies(page);
    await ensureLogged(page);

    // 3) Vai su ROSE e scarica
    await safeGoto(page, ROSE_URL);
    await acceptCookies(page);
    await saveDebug(page, 'rose');

    await downloadXlsx(page, OUT_CACHE);

    try { await fs.unlink(OUT_FINAL); } catch {}
    await fs.rename(OUT_CACHE, OUT_FINAL);
    log(`OK: rinominato in ${OUT_FINAL}`);

    // 4) Upload
    await httpUpload(OUT_FINAL);
  } catch (e) {
    await saveDebug(page, 'error');
    console.error('Errore downloader:', e?.message || e);
    process.exit(2);
  } finally {
    await browser.close();
  }
})();
