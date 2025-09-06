import fs from 'fs/promises';
import path from 'path';
import { chromium } from 'playwright';

const LEAGUE_SLUG   = process.env.LEAGUE_SLUG || 'negherleague';
const UPLOAD_URL    = process.env.UPLOAD_URL  || '';
const UPLOAD_TOKEN  = process.env.UPLOAD_TOKEN || '';

const UPLOAD_SUBDIR_ROSTERS = process.env.UPLOAD_SUBDIR_ROSTERS || 'svincoli';
const UPLOAD_SUBDIR_SAUDI   = process.env.UPLOAD_SUBDIR_SAUDI   || 'svincoli/classic';

if (!UPLOAD_URL || !UPLOAD_TOKEN) {
  console.error('UPLOAD_URL/UPLOAD_TOKEN mancanti nelle env.');
  process.exit(1);
}

const ROSE_URL_NEGHER = `https://leghe.fantacalcio.it/${LEAGUE_SLUG}/rose`;
const ROSE_URL_SAUDI  = 'https://leghe.fantacalcio.it/-saudi-league-/rose';

// chiude/accetta CMP PubTech e simili
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
  const btn = page.locator(sel).first();
  try {
    if (await btn.count()) {
      await btn.click({ timeout: 5000 });
      await page.waitForFunction(() => !document.querySelector('#pubtech-cmp'), null, { timeout: 5000 });
      console.log('✓ CMP accettato');
      return;
    }
  } catch (e) {
    console.log('! CMP: click fallito, continuo lo stesso:', e.message);
  }
  try {
    await page.evaluate(() => {
      const el = document.querySelector('#pubtech-cmp');
      if (el) el.style.display = 'none';
    });
    console.log('✓ CMP nascosto via fallback');
  } catch { /* ignore */ }
}

async function goAndDownload(page, url, finalFilename) {
  console.log('→ Vado su', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 });
  await acceptCmp(page);

  const xlsx = page.locator('#toexcel').first();
  await xlsx.waitFor({ timeout: 15000 });

  console.log('→ Clic su XLSX e attendo il download…');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    xlsx.click({ timeout: 30000, force: true })
  ]);

  const out = path.resolve(finalFilename);
  await download.saveAs(out);
  console.log('✓ Salvato file:', out);
  return out;
}

async function uploadToAruba(localPath, remoteName, subdir) {
  const buf = await fs.readFile(localPath);
  const fd = new FormData();
  fd.append(
    'file',
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    remoteName
  );
  // Se il tuo endpoint supporta indicare una cartella, la passo come campo form.
  // (Se non servisse, l’endpoint ignorerà semplicemente questo campo.)
  fd.append('subdir', subdir);

  console.log(`→ Upload verso ${UPLOAD_URL} (subdir: ${subdir})`);
  const res = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPLOAD_TOKEN}` },
    body: fd,
  });

  const text = await res.text();
  console.log(text);
  if (!res.ok) throw new Error(`Upload fallito: HTTP ${res.status}`);
}

(async () => {
  const browser = await chromium.launch(); // headless
  const ctx = await browser.newContext({
    storageState: 'auth.json',
    acceptDownloads: true,
  });
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1366, height: 900 });

  // 1) NEGHER LEAGUE → negher rosters.xlsx → /svincoli
  const negherLocal = await goAndDownload(page, ROSE_URL_NEGHER, 'negher rosters.xlsx');
  await uploadToAruba(negherLocal, 'negher rosters.xlsx', UPLOAD_SUBDIR_ROSTERS);

  // 2) SAUDI LEAGUE → Rose_-saudi-league-.xlsx → /svincoli/classic
  const saudiLocal = await goAndDownload(page, ROSE_URL_SAUDI, 'Rose_-saudi-league-.xlsx');
  await uploadToAruba(saudiLocal, 'Rose_-saudi-league-.xlsx', UPLOAD_SUBDIR_SAUDI);

  await browser.close();
  console.log('✓ Tutto completato');
})();
