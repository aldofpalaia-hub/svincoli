// scripts/save_state.mjs
import { chromium } from 'playwright';

const LOGIN_URL  = 'https://leghe.fantacalcio.it/login';
const LEAGUE_SLUG = process.env.LEAGUE_SLUG || 'negherleague';
const ROSE_URL   = `https://leghe.fantacalcio.it/${LEAGUE_SLUG}/rose`;

(async () => {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();

  await page.goto(LOGIN_URL);
  console.log('\n1) Accetta il banner cookie, fai LOGIN manuale.');
  console.log('2) Quando sei dentro (meglio se apri la pagina rose), torna qui e premi INVIO.\n');

  process.stdin.once('data', async () => {
    try {
      await page.goto(ROSE_URL, { waitUntil: 'domcontentloaded' });
    } catch {}
    await ctx.storageState({ path: 'auth.json' });
    console.log('✓ Stato salvato in auth.json');
    await browser.close();
    process.exit(0);
  });
})();
