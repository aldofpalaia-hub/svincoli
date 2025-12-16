import fs from 'fs/promises';
import path from 'path';
import { chromium } from 'playwright';

await import('dotenv/config').catch(() => {
  // in CI la .env non serve; evita crash se dotenv non è installato
});
const LEAGUE_SLUG  = process.env.LEAGUE_SLUG || 'negherleague';
const UPLOAD_URL   = process.env.UPLOAD_URL  || '';
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN|| '';
const EMAIL        = process.env.LEGHE_EMAIL || '';
const PASSWORD     = process.env.LEGHE_PASSWORD || '';
const LOGIN_URLS = [
  'https://leghe.fantacalcio.it/login',
  'https://leghe.fantacalcio.it/login/gestione-lega/info-lega',
  'https://www.fantacalcio.it/login',
];

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

async function clickOpenLogin(scope) {
  const candidates = [
    'button:has-text("Login")','button:has-text("Accedi")',
    'a:has-text("Login")','a:has-text("Accedi")'
  ];
  for (const sel of candidates) {
    const el = scope.locator(sel);
    if (await el.count()) { try { await el.first().click({ timeout: 1500 }); return true; } catch {} }
  }
  return false;
}

async function fillLoginInScope(scope) {
  const userSels = [
    'input[name="username"]','input#username','input[name="login"]',
    'input[name="email"]','input#email',
    'input[placeholder*="Nome Utente" i]','input[placeholder*="Username" i]','input[placeholder*="email" i]',
    'input[type="email"]','input[type="text"]'
  ];
  const passSels = [
    'input[name="password"]','input#password','input[type="password"]',
    'input[placeholder*="password" i]'
  ];
  for (const uSel of userSels) {
    const u = scope.locator(uSel).first();
    if (await u.count()) {
      try { await u.fill(EMAIL, { timeout: 8000 }); } catch {}
      for (const pSel of passSels) {
        const p = scope.locator(pSel).first();
        if (await p.count()) {
          try { await p.fill(PASSWORD, { timeout: 8000 }); } catch {}
          const submit = scope.locator('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Accedi")').first();
          try {
            if (await submit.count()) await submit.click({ timeout: 2000 }); else await p.press('Enter');
          } catch {}
          return true;
        }
      }
    }
  }
  return false;
}

async function fullLogin(page) {
  if (!EMAIL || !PASSWORD) return false;
  for (const url of LOGIN_URLS) {
    try {
      log('Tentativo login su', url);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await acceptCookies(page);
      await clickOpenLogin(page);
      let ok = await fillLoginInScope(page);
      if (!ok) {
        for (const fr of page.frames()) {
          try {
            await acceptCookies(fr);
            await clickOpenLogin(fr);
            ok = await fillLoginInScope(fr);
            if (ok) break;
          } catch {}
        }
      }
      if (ok) {
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(()=>{});
        return true;
      }
    } catch (e) {
      log('Login fallito su', url, '-', e?.message || e);
    }
  }
  return false;
}

async function ensureDownload(page) {
  const selectors = [
    'a:has-text("XLSX")', 'button:has-text("XLSX")',
    'a:has-text("Excel")', 'button:has-text("Excel")',
    'a[href$=".xlsx"]', 'a[href*=".xlsx"]', 'a[download*=".xlsx"]',
    'a[href*="xlsx"]', 'button:has-text("Esporta")', 'button:has-text("Download")',
  ];

  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.count()) {
      try { await loc.scrollIntoViewIfNeeded(); } catch {}
      await loc.waitFor({ timeout: 25_000, state: 'visible' });
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30_000 }),
        loc.click()
      ]);
      return download;
    }
  }

  await page.screenshot({ path: 'debug_no_xlsx.png', fullPage: true }).catch(()=>{});
  throw new Error('Bottone/link XLSX non trovato (screenshot: debug_no_xlsx.png)');
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
    const stillLogin = await page.locator('input[type="password"]').first().count();
    if (stillLogin) {
      log('Ancora su pagina di login, provo flusso completo...');
      const logged = await fullLogin(page);
      if (!logged) throw new Error('Login fallito: controlla LEGHE_EMAIL/LEGHE_PASSWORD o auth.json');
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
