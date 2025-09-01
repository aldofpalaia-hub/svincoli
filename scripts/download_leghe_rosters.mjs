// scripts/download_leghe_rosters.mjs
// 1) Scarica dal bottone "XLSX"
// 2) Rinomina in "negher rosters.xlsx"
// 3) Upload: HTTP (token) -> FTPS (Aruba) -> SFTP (opzionale)

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import ftp from 'basic-ftp';
import Client from 'ssh2-sftp-client';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const EMAIL    = process.env.LEGHE_EMAIL || '';
const PASSWORD = process.env.LEGHE_PASSWORD || '';

const STORAGE   = path.join(__dirname, '..', 'cache', 'auth-state.json');
const OUT_CACHE = path.join(__dirname, '..', 'cache', 'rose_leghe.xlsx');
const OUT_FINAL = path.join(__dirname, '..', 'negher rosters.xlsx');
const LOGIN_URL = 'https://leghe.fantacalcio.it/login';
const ROSE_URL  = 'https://leghe.fantacalcio.it/negherleague/rose';

const HEADLESS = (process.env.HEADLESS ?? 'false') === 'true'; // metti HEADLESS=true nel .env per headless
const NAV_TIMEOUT = 120_000;

const log  = (...a) => console.log(new Date().toISOString(), '-', ...a);

// ---------- utility ----------
async function ensureDirFor(p) { await fs.mkdir(path.dirname(p), { recursive: true }); }
async function waitForEnter() {
  return new Promise(res => {
    console.log('\n👉 Completa il login nel browser, poi premi INVIO qui.');
    process.stdin.resume(); process.stdin.once('data', ()=>{process.stdin.pause(); res();});
  });
}
async function safeGoto(page, url) {
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }); }
  catch (e) { log('goto warn:', e?.message || e); }
  await page.waitForTimeout(800);
}
async function dismissBanners(page) {
  const sels = ['button:has-text("Accetta")','button:has-text("Accetto")','button:has-text("Consenti")','button:has-text("Chiudi")','[role="button"]:has-text("Accetta")'];
  for (const s of sels) {
    const el = page.locator(s).first();
    try { if (await el.count() && await el.isVisible()) await el.click({ timeout: 1200 }); } catch {}
  }
}
async function loginIfNeeded(page) {
  if (process.env.MANUAL_LOGIN === '1') return;
  if (!EMAIL || !PASSWORD) return;
  await safeGoto(page, LOGIN_URL);

  let ctx = page;
  if (!(await page.locator('input[type="password"]:visible, input[name="password"]:visible').count())) {
    for (const f of page.frames()) {
      if (await f.locator('input[type="password"]:visible, input[name="password"]:visible').count()) { ctx = f; break; }
    }
  }
  const email = ctx.locator('input[type="email"]:visible, input[name="email"]:visible, input[name="username"]:visible').first();
  const pass  = ctx.locator('input[type="password"]:visible, input[name="password"]:visible').first();
  if (!(await email.count()) || !(await pass.count())) return; // già loggato?

  await email.fill(EMAIL, { timeout: NAV_TIMEOUT });
  await pass.fill(PASSWORD, { timeout: NAV_TIMEOUT });

  const submit = ctx.locator([
    'button[type="submit"]:visible','input[type="submit"]:visible',
    'button:has-text("Accedi"):visible','button:has-text("Login"):visible','button:has-text("Entra"):visible'
  ].join(', ')).first();
  if (await submit.count()) await submit.click().catch(()=>pass.press('Enter')); else await pass.press('Enter');
  await page.waitForTimeout(1500);
}
async function downloadXlsx(page, outPath) {
  const labels = ['XLSX','Scarica XLSX','Download XLSX'];
  const selectors = [
    ...labels.flatMap(l => [`a:has-text("${l}")`, `button:has-text("${l}")`]),
    'a[href$=".xlsx"]','a[download$=".xlsx"]','a[download*=".xlsx"]'
  ];
  let link = null;
  for (const sel of selectors) {
    const cand = page.locator(sel).first();
    try { if (await cand.count()) { await cand.waitFor({ state:'visible', timeout:7000 }); if (await cand.isVisible()) { link = cand; break; } } } catch {}
  }
  if (!link) throw new Error('Bottone/Link XLSX non trovato sulla pagina.');
  const [download] = await Promise.all([ page.waitForEvent('download', { timeout: NAV_TIMEOUT }), link.click() ]);
  await ensureDirFor(outPath);
  try { await fs.unlink(outPath); } catch {}
  await download.saveAs(outPath);
  log(`Scaricato (XLSX): ${outPath}`);
  return outPath;
}

// ---------- upload: HTTP (consigliato) ----------
async function uploadViaHttp(localPath) {
  const url = process.env.UPLOAD_URL;
  const token = process.env.UPLOAD_TOKEN;
  if (!url || !token) { log('HTTP upload disabilitato: manca UPLOAD_URL/UPLOAD_TOKEN.'); return false; }

  const buf = await fs.readFile(localPath);
  const form = new FormData();
  form.append('token', token);
  form.append(
    'file',
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    'negher rosters.xlsx'
  );

  const res = await fetch(url, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  log(`HTTP upload OK: ${text.slice(0,160)}...`);
  return true;
}

// ---------- upload: FTPS (Aruba: 21 esplicito, 990 implicito) ----------
async function uploadViaFtps(localPath, override = {}) {
  const host = override.host ?? process.env.FTPS_HOST;
  const user = override.user ?? process.env.FTPS_USER;
  const pass = override.pass ?? process.env.FTPS_PASS;
  const port = parseInt(override.port ?? process.env.FTPS_PORT ?? '21', 10);

  let remotePath = (override.remote ?? process.env.FTPS_REMOTE ?? '').replace(/\\/g,'/');
  if (!remotePath && process.env.FTPS_REMOTE_DIR) {
    const dir = process.env.FTPS_REMOTE_DIR.replace(/\\/g,'/').replace(/\/+$/,'');
    remotePath = `${dir}/negher rosters.xlsx`;
  }

  if (!host || !user || !pass || !remotePath) {
    log('FTPS disabilitato: manca FTPS_HOST/USER/PASS/REMOTE.');
    return false;
  }

  const client = new ftp.Client(45_000);
  if (process.env.FTPS_DEBUG === '1') client.ftp.verbose = true;

  const connect = async () => {
    await client.access({
      host, port, user, password: pass,
      secure: port === 990 ? 'implicit' : true,
      secureOptions: { rejectUnauthorized: false },
    });
    const pwd = await client.pwd().catch(()=>'?');
    log(`FTPS connesso. PWD: ${pwd}`);
  };

  const attemptUpload = async (pathToUse) => {
    const parts = pathToUse.split('/');
    const file = parts.pop();
    const dir  = parts.filter(Boolean).join('/');
    if (dir) {
      try { await client.ensureDir(dir); }
      catch (e) {
        // fallback mkdir step-by-step
        let acc = '';
        for (const seg of dir.split('/')) {
          if (!seg) continue;
          acc = acc ? `${acc}/${seg}` : seg;
          try { await client.cd(acc); }
          catch { try { await client.send('MKD ' + acc); await client.cd(acc); } catch (e2) { throw e2; } }
        }
      }
    }
    await client.uploadFrom(localPath, pathToUse);
    log(`FTPS: caricato su ${pathToUse}`);
  };

  try {
    await connect();
    try {
      await attemptUpload(remotePath);
    } catch (e1) {
      // retry senza "/" iniziale (alcuni server vogliono path relativo)
      if (remotePath.startsWith('/')) {
        const alt = remotePath.slice(1);
        log(`Retry FTPS senza "/" iniziale: ${alt} (err: ${e1?.message || e1})`);
        await attemptUpload(alt);
      } else {
        throw e1;
      }
    }
    return true;
  } finally {
    client.close();
  }
}

// ---------- upload: SFTP (solo se hai SSH) ----------
async function uploadViaSftp(localPath) {
  const host = process.env.SFTP_HOST;
  const port = parseInt(process.env.SFTP_PORT || '22', 10);
  const username = process.env.SFTP_USER;
  const password = process.env.SFTP_PASS || undefined;
  const keyPath  = process.env.SFTP_KEY_PATH || undefined;
  const passphrase = process.env.SFTP_PASSPHRASE || undefined;

  let remotePath = process.env.SFTP_REMOTE || '';
  if (!remotePath && process.env.SFTP_REMOTE_DIR) {
    const dir = process.env.SFTP_REMOTE_DIR.replace(/\\/g,'/').replace(/\/+$/,'');
    remotePath = `${dir}/negher rosters.xlsx`;
  }
  if (!host || !username || !remotePath) {
    log('SFTP disabilitato o incompleto.');
    return false;
  }

  const cfg = { host, port, username };
  if (keyPath) { cfg.privateKey = await fs.readFile(keyPath); if (passphrase) cfg.passphrase = passphrase; }
  else if (password) { cfg.password = password; }
  else { throw new Error('SFTP: specifica SFTP_PASS o SFTP_KEY_PATH.'); }

  const sftp = new Client();
  try {
    await sftp.connect(cfg);
    const remoteDir = remotePath.replace(/\\/g,'/').split('/').slice(0,-1).join('/') || '.';
    try { await sftp.mkdir(remoteDir, true); } catch {}
    await sftp.fastPut(localPath, remotePath);
    log(`SFTP: caricato su ${remotePath}`);
    return true;
  } finally {
    try { await sftp.end(); } catch {}
  }
}

// ------------------------------- MAIN -------------------------------
(async () => {
  await ensureDirFor(STORAGE);
  const browser = await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext({
    storageState: (await fs.stat(STORAGE).catch(()=>null)) ? STORAGE : undefined,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PlaywrightDownloader',
    acceptDownloads: true,
  });

  try {
    await ctx.route('**/*', route => {
      const u = route.request().url();
      if (/googletagmanager|google-analytics|doubleclick|facebook|hotjar|optimizely|segment|sentry|datadog/i.test(u)) return route.abort();
      return route.continue();
    });

    const page = await ctx.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);

    await safeGoto(page, LOGIN_URL);
    if (process.env.MANUAL_LOGIN === '1') await waitForEnter(); else await loginIfNeeded(page);

    await safeGoto(page, ROSE_URL);
    await dismissBanners(page);

    await downloadXlsx(page, OUT_CACHE);

    // rinomina/sposta
    try { await fs.unlink(OUT_FINAL); } catch {}
    await ensureDirFor(OUT_FINAL);
    await fs.rename(OUT_CACHE, OUT_FINAL);
    log(`OK: rinominato in ${OUT_FINAL}`);

    // Upload: 1) HTTP, 2) FTPS, 3) SFTP
    let uploaded = false;
    try { uploaded = await uploadViaHttp(OUT_FINAL); } catch (e) { console.error('HTTP upload errore:', e?.message || e); }
    if (!uploaded) {
      try { uploaded = await uploadViaFtps(OUT_FINAL); } catch (e) { console.error('FTPS errore:', e?.message || e); }
    }
    if (!uploaded && (process.env.SFTP_HOST || process.env.SFTP_REMOTE || process.env.SFTP_REMOTE_DIR)) {
      try { uploaded = await uploadViaSftp(OUT_FINAL); } catch (e) { console.error('SFTP errore:', e?.message || e); }
    }
    if (!uploaded) console.error('Upload non eseguito: verifica configurazione HTTP/FTPS/SFTP.');

    await ctx.storageState({ path: STORAGE });
  } finally {
    await ctx.close().catch(()=>{});
    await browser.close().catch(()=>{});
  }
})().catch(err => { console.error('Errore downloader:', err?.message || err); process.exit(2); });
