import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { chromium } from 'playwright';

const EMAIL        = process.env.LEGHE_EMAIL || '';
const PASSWORD     = process.env.LEGHE_PASSWORD || '';
const LEAGUE_SLUG  = process.env.LEAGUE_SLUG  || 'negherleague';
const UPLOAD_URL   = process.env.UPLOAD_URL   || '';
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN || '';
const HEADFUL      = !!process.env.HEADFUL;

if (!EMAIL || !PASSWORD || !UPLOAD_URL || !UPLOAD_TOKEN) {
  console.error('ENV mancanti: LEGHE_EMAIL, LEGHE_PASSWORD, UPLOAD_URL, UPLOAD_TOKEN');
  process.exit(2);
}

const LOGIN_URLS = [
  'https://leghe.fantacalcio.it/login',
  'https://leghe.fantacalcio.it/login/gestione-lega/info-lega',
  'https://www.fantacalcio.it/login',
];
const ROSE_URL  = `https://leghe.fantacalcio.it/${LEAGUE_SLUG}/rose`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function acceptCookiesAggressive(scope) {
  // OneTrust classico
  const btn = scope.locator('#onetrust-accept-btn-handler, button#onetrust-accept-btn-handler');
  if (await btn.count()) {
    try { await btn.first().click({ timeout: 2000 }); } catch {}
    // se non clicca, forza via JS
    try {
      await scope.evaluate(() => {
        const b = document.querySelector('#onetrust-accept-btn-handler');
        if (b) b.click();
        const ban = document.getElementById('onetrust-banner-sdk');
        if (ban) ban.style.display = 'none';
      });
    } catch {}
  }
  // fallback generico
  const alt = scope.locator('button:has-text("Accetta"), button:has-text("Accetto"), button:has-text("Accept")');
  if (await alt.count()) { try { await alt.first().click({ timeout: 1500 }); } catch {} }
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

async function fillLoginInFrame(fr, user, pass) {
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
    const u = fr.locator(uSel).first();
    if (await u.count()) {
      await u.scrollIntoViewIfNeeded().catch(()=>{});
      await u.waitFor({ state: 'visible', timeout: 8000 }).catch(()=>{});
      try { await u.fill(user, { timeout: 8000 }); } catch {}
      for (const pSel of passSels) {
        const p = fr.locator(pSel).first();
        if (await p.count()) {
          await p.scrollIntoViewIfNeeded().catch(()=>{});
          await p.waitFor({ state: 'visible', timeout: 8000 }).catch(()=>{});
          try { await p.fill(pass, { timeout: 8000 }); } catch {}
          const submitted = await (async () => {
            const submit = fr.locator('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Accedi")').first();
            if (await submit.count()) { try { await submit.click({ timeout: 2000 }); return true; } catch {} }
            try { await p.press('Enter'); return true; } catch {}
            return false;
          })();
          if (submitted) return true;
        }
      }
    }
  }
  return false;
}

async function doLogin(page) {
  for (const url of LOGIN_URLS) {
    try {
      console.log('> Apro login:', url);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await acceptCookiesAggressive(page);
      await clickOpenLogin(page);

      // prova in pagina
      let ok = await fillLoginInFrame(page, EMAIL, PASSWORD);
      // prova negli iframe eventuali
      if (!ok) {
        for (const fr of page.frames()) {
          try {
            await acceptCookiesAggressive(fr);
            await clickOpenLogin(fr);
            ok = await fillLoginInFrame(fr, EMAIL, PASSWORD);
            if (ok) break;
          } catch {}
        }
      }
      if (ok) {
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(()=>{});
        return true;
      }
    } catch (e) {
      console.warn('Tentativo login fallito su', url, '-', e?.message || e);
    }
  }
  return false;
}

async function main() {
  const browser = await chromium.launch({
    headless: !HEADFUL,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({
    userAgent: 'NegherLeague CI/1.0 (+playwright chromium)',
    acceptDownloads: true,
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await ctx.newPage();

  const logged = await doLogin(page);
  if (!logged) {
    await page.screenshot({ path: 'debug_login.png', fullPage: true }).catch(()=>{});
    console.error('Impossibile compilare/inviare il form di login. Vedi debug_login.png');
    process.exit(10);
  }

  console.log('> Vai a rose:', ROSE_URL);
  await page.goto(ROSE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await acceptCookiesAggressive(page);

  console.log('> Download XLSX…');
  const xlsxLocator = page.locator('a:has-text("XLSX"), button:has-text("XLSX"), a[href*="Excel"], a[href$=".xlsx"], a[href*="/xlsx"]');
  await xlsxLocator.first().waitFor({ timeout: 25000 });

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 25000 }),
    xlsxLocator.first().click()
  ]);

  const outName = 'negher rosters.xlsx';
  const outPath = path.resolve(outName);
  await download.saveAs(outPath);

  const stat = await fs.stat(outPath);
  if (stat.size < 10000) {
    await page.screenshot({ path: 'debug_after_download.png', fullPage: true }).catch(()=>{});
    throw new Error('XLSX troppo piccolo: possibile errore di export/login.');
  }

  console.log('> Upload ad Aruba…');
  const buf = await fs.readFile(outPath);
  const fd = new FormData();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  fd.append('file', blob, outName);

  const res = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPLOAD_TOKEN}` },
    body: fd
  });

  const text = await res.text();
  if (!res.ok || !/^OK /.test(text)) {
    console.error('Upload fallito. Status:', res.status, 'Body:', text);
    process.exit(3);
  }
  console.log(text);

  await browser.close();
  console.log('> Fatto!');
}

main().catch(async (err) => {
  console.error('ERRORE downloader:', err?.message || err);
  process.exit(1);
});
