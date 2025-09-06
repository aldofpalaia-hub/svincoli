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

const ROSE_URL = `https://leghe.fantacalcio.it/${LEAGUE_SLUG}/rose`;

// chiude/accetta CMP PubTech e simili
async function acceptCmp(page) {
  // aspetta che il DOM si stabilizzi un attimo
  await page.waitForTimeout(1200);

  // prova a cliccare i vari pulsanti "Accetta"
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
      // attendi che l’overlay sparisca
      await page.waitForFunction(() => !document.querySelector('#pubtech-cmp'), null, { timeout: 5000 });
      console.log('✓ CMP accettato');
      return;
    }
  } catch (e) {
    console.log('! CMP: click fallito, continuo lo stesso:', e.message);
  }

  // fallback hard: nascondi l’overlay se ancora presente
  try {
    await page.evaluate(() => {
      const el = document.querySelector('#pubtech-cmp');
      if (el) el.style.display = 'none';
    });
    console.log('✓ CMP nascosto via fallback');
  } catch { /* ignore */ }
}

(async () => {
  const browser = await chromium.launch(); // headless
  const ctx = await browser.newContext({
    storageState: 'auth.json',
    acceptDownloads: true,
  });
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1366, height: 900 });

  console.log('→ Vado su', ROSE_URL);
  await page.goto(ROSE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 });

  // chiudi banner
  await acceptCmp(page);

  // selezione più precisa del bottone di export
  const xlsx = page.locator('#toexcel').first();

  // assicurati che esista e sia visibile
  await xlsx.waitFor({ timeout: 15000 });

  console.log('→ Clic su XLSX e attendo il download…');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    // se qualcosa ancora copre, forza il click
    xlsx.click({ timeout: 30000, force: true })
  ]);

  const out = path.resolve('negher rosters.xlsx');
  await download.saveAs(out);
  console.log('✓ Salvato file:', out);

  // Upload a Aruba
  const buf = await fs.readFile(out);
  const fd = new FormData();
  fd.append(
    'file',
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    'negher rosters.xlsx'
  );

  console.log('→ Upload verso', UPLOAD_URL);
  const res = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPLOAD_TOKEN}` },
    body: fd,
  });

  const text = await res.text();
  console.log(text);
  if (!res.ok) throw new Error(`Upload fallito: HTTP ${res.status}`);

  await browser.close();
})();
