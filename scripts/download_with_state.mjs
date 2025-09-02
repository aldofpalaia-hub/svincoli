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

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    storageState: 'auth.json',
    acceptDownloads: true,
  });
  const page = await ctx.newPage();

  console.log('→ Vado su', ROSE_URL);
  await page.goto(ROSE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const xlsx = page.locator([
    'a:has-text("XLSX")',
    'button:has-text("XLSX")',
    'a[href$=".xlsx"]',
    'a:has-text("Excel")',
    'button:has-text("Excel")',
  ].join(', '));
  await xlsx.first().waitFor({ timeout: 30000 });

  console.log('→ Clic su XLSX e attendo il download…');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    xlsx.first().click()
  ]);

  const out = path.resolve('negher rosters.xlsx');
  await download.saveAs(out);
  console.log('✓ Salvato file:', out);

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
