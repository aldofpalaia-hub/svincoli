// scripts/download_negher.mjs
import fs from 'fs/promises';
import path from 'path';
import { chromium } from 'playwright';

const LEAGUE_SLUG  = process.env.LEAGUE_SLUG || 'negherleague';
const UPLOAD_URL   = process.env.UPLOAD_URL  || '';
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN || '';

if (!UPLOAD_URL || !UPLOAD_TOKEN) {
  console.error('UPLOAD_URL/UPLOAD_TOKEN mancanti nelle env.');
  process.exit(1);
}

const WORKDIR  = process.env.GITHUB_WORKSPACE || process.cwd();
const ROSE_URL = `https://leghe.fantacalcio.it/${LEAGUE_SLUG}/rose`;
const OUT_FILE = path.join(WORKDIR, 'negher rosters.xlsx');

// --- Gestione CMP (PubTech / OneTrust) --------------------------------------
async function acceptCmp(page) {
  await page.waitForTimeout(1200);
  const sel = [
    '#pubtech-cmp button:has-text("Accetta")',
    '#pubtech-cmp button:has-text("Accetta tutto")',
    '#pubtech-cmp [role="button"]:has-text("Accetta")',
    'button:has-text("Accetta")',
    'button:has-text("Ho capito")',
    'button:has-text("OK")',
    '#onetrust-accept-btn-handler'
  ].join(', ');

  try {
    const btn = page.locator(sel).first();
    if (await btn.count()) {
      await btn.click({ timeout: 5000 });
      await page.waitForFunction(() => !document.querySelector('#pubtech-cmp'), null, { timeout: 5000 });
      console.log('✓ CMP accettato');
      return;
    }
  } catch (e) {
    console.log('! CMP: click fallito, continuo lo stesso:', e.message);
  }

  // Fallback: forza display:none
  try {
    await page.addStyleTag({ content: `
      #pubtech-cmp, #onetrust-banner-sdk, .ot-sdk-container, .qc-cmp2-container {
        display:none !important; visibility:hidden !important; pointer-events:none !important;
      }
    `});
    console.log('✓ CMP nascosto via fallback');
  } catch {}
}

// --- Click su "XLSX" con più strategie --------------------------------------
async function clickAndDownload(page, locator) {
  if (!(await locator.count())) return false;
  const el = locator.first();
  try { await el.waitFor({ state: 'visible', timeout: 15000 }); } catch { return false; }
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    el.click({ timeout: 30000, force: true })
  ]);
  await download.saveAs(OUT_FILE);
  return true;
}

async function downloadNegher() {
  const browser = await chromium.launch(); // headless
  const ctx = await browser.newContext({
    storageState: 'auth.json',   // deve contenere la sessione su leghe.fantacalcio.it
    acceptDownloads: true,
  });
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1366, height: 900 });

  console.log('→ Vado su', ROSE_URL);
  await page.goto(ROSE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await acceptCmp(page);

  // Se siamo su una pagina di login, state non include la sessione per questo dominio
  const seemsLogin = await page.locator('form[action*="login"], input[type="email"], .login-facebook, button:has-text("Accedi")').first().isVisible().catch(() => false);
  if (seemsLogin) {
    throw new Error('Non sei autenticato su leghe.fantacalcio.it. Rigenera auth.json includendo questa lega.');
  }

  // 1) tentativi diretti di XLSX (testo/link)
  let ok = await clickAndDownload(page, page.locator(
    'a:has-text("XLSX"), button:has-text("XLSX"), ' +
    'a[download$=".xlsx"], a[href$=".xlsx"], a[href*="excel"], a[href*="xlsx"]'
  ));

  // 2) se esiste un menù "Esporta", aprilo e ritenta
  if (!ok) {
    const exportBtn = page.locator('button:has-text("Esporta"), [data-bs-toggle="dropdown"]:has-text("Esporta")').first();
    if (await exportBtn.count()) {
      await exportBtn.click({ timeout: 5000 }).catch(()=>{});
      await page.waitForTimeout(300);
      ok = await clickAndDownload(page, page.locator(
        '.dropdown-menu a:has-text("XLSX"), .dropdown-menu button:has-text("XLSX"), .dropdown-menu a[href*="xlsx"]'
      ));
    }
  }

  // 3) Fallback storico su id/class “excel”
  if (!ok) {
    ok = await clickAndDownload(page, page.locator('#toexcel, [id*="excel"], [class*="excel"]'));
  }

  if (!ok) throw new Error('Voce/pulsante “XLSX” non trovato su /rose (layout cambiato o permessi insufficienti).');

  console.log('✓ Salvato file:', OUT_FILE);

  // Upload
  const buf = await fs.readFile(OUT_FILE);
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'negher rosters.xlsx');

  console.log('→ Upload verso', UPLOAD_URL);
  const res = await fetch(UPLOAD_URL, { method: 'POST', headers: { Authorization: `Bearer ${UPLOAD_TOKEN}` }, body: fd });
  const text = await res.text();
  console.log(text);
  if (!res.ok) throw new Error(`Upload fallito: HTTP ${res.status}`);

  await ctx.close();
  await browser.close();
}

downloadNegher().catch(err => {
  console.error(err);
  process.exit(1);
});
