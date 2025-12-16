import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { chromium } from 'playwright';

const LEAGUE_SLUG  = process.env.LEAGUE_SLUG || 'negherleague';
const UPLOAD_URL   = process.env.UPLOAD_URL  || '';
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN|| '';
const EMAIL        = process.env.LEGHE_EMAIL || '';
const PASSWORD     = process.env.LEGHE_PASSWORD || '';

const ROSE_URL = `https://leghe.fantacalcio.it/${LEAGUE_SLUG}/rose`;
const STORAGE  = 'auth.json';
const NAV_TIMEOUT = 40_000;
const FETCH_TIMEOUT = 30_000;
const log = (...a) => console.log('[rosters]', ...a);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function acceptCookies(scope) {
  const btn = scope.locator('#onetrust-accept-btn-handler, button#onetrust-accept-btn-handler');
  if (await btn.count()) { try { await btn.first().click({ timeout: 1500 }); } catch {} }
  const alt = scope.locator('button:has-text("Accetta"), button:has-text("Accetto"), button:has-text("Accept")');
  if (await alt.count()) { try { await alt.first().click({ timeout: 1200 }); } catch {} }
}

async function maybeLogin(page) {
  if (!EMAIL || !PASSWORD) return false;
  const candidates = [
    'input[name="username"]','input#username','input[name="login"]','input[name="email"]',
    'input[placeholder*="Nome Utente" i]','input[placeholder*="Username" i]','input[type="email"]','input[type="text"]'
  ];
  const passSel = 'input[type="password"], input[name="password"]';

  let ctx = page;
  for (const fr of page.frames()) {
    try { if (await fr.locator(passSel).count()) { ctx = fr; break; } } catch {}
  }

  const user = ctx.locator(candidates.join(',')).first();
  const pass = ctx.locator(passSel).first();
  if (!(await pass.count()) || !(await user.count())) return false;

  try { await user.fill(EMAIL, { timeout: 8000 }); } catch {}
  try { await pass.fill(PASSWORD, { timeout: 8000 }); } catch {}
  try {
    const submit = ctx.locator('button[type="submit"], input[type="submit"], button:has-text("Accedi"), button:has-text("Login")').first();
    if (await submit.count()) await submit.click({ timeout: 2000 }); else await pass.press('Enter');
  } catch {}
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(()=>{});
  await sleep(500);
  return true;
}

async function ensureDownload(page) {
  const xlsx = page.locator('a:has-text("XLSX"), button:has-text("XLSX"), a[href$=".xlsx"]');
  await xlsx.first().waitFor({ timeout: 25000 });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    xlsx.first().click()
  ]);
  return download;
}

async function main() {
  if (!UPLOAD_URL || !UPLOAD_TOKEN) {
    throw new Error('Mancano UPLOAD_URL/UPLOAD_TOKEN per l\'upload.');
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    storageState: (await fs.stat(STORAGE).catch(()=>null)) ? STORAGE : undefined,
    acceptDownloads: true,
  });
  const page = await ctx.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);

  try {
    log('Apro pagina rose:', ROSE_URL);
    await page.goto(ROSE_URL, { waitUntil: 'domcontentloaded' });
    await acceptCookies(page);
    if (/login/i.test(page.url())) {
      log('Sembra login, provo a compilare le credenziali...');
      await maybeLogin(page);
      await page.goto(ROSE_URL, { waitUntil: 'domcontentloaded' });
      await acceptCookies(page);
    }

    log('Cerco bottone XLSX e scarico...');
    const download = await ensureDownload(page);
    const out = path.resolve('negher rosters.xlsx');
    await download.saveAs(out);

    const stat = await fs.stat(out);
    if (stat.size < 10_000) {
      throw new Error('XLSX scaricato troppo piccolo: probabile login scaduto.');
    }

    const buf = await fs.readFile(out);
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'negher rosters.xlsx');

    const res = await fetchWithTimeout(UPLOAD_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPLOAD_TOKEN}` },
      body: fd
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`Upload fallito (${res.status}): ${body}`);

    log('Upload OK:', body.trim());
    await ctx.storageState({ path: STORAGE }).catch(()=>{});
  } finally {
    await ctx.close().catch(()=>{});
    await browser.close().catch(()=>{});
  }
}

main().catch(async (err) => {
  console.error('ERRORE downloader:', err?.message || err);
  process.exit(1);
});
