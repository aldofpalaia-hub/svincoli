// scripts/scrape_leghe_rosters.mjs
// Requisiti: npm i playwright dotenv && npx playwright install chromium
// Config .env: LEGHE_EMAIL=...  LEGHE_PASSWORD=...  OUT=cache/rosters.json

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EMAIL = process.env.LEGHE_EMAIL;
const PASSWORD = process.env.LEGHE_PASSWORD;
const OUT = process.env.OUT || 'cache/rosters.json';
const STORAGE = path.join(__dirname, '..', 'cache', 'auth-state.json');

const LOGIN_URL  = 'https://leghe.fantacalcio.it/login';
const TARGET_URL = 'https://leghe.fantacalcio.it/negherleague/rose';

// Finestra visibile per debug / primo login
const headless = false;
// Timeout navigazione più alto
const NAV_TIMEOUT = 90000;

// ---------------- Utils ----------------
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
function cleanNumber(s) {
  const t = String(s ?? '').replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, '');
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}
async function ensureDir(p) {
  await fs.mkdir(path.dirname(p), { recursive: true });
}
function waitForEnter() {
  return new Promise((resolve) => {
    console.log('\n👉 Completa il login nella finestra, poi torna qui e premi INVIO...');
    process.stdin.resume();
    process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
  });
}
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let last = 0;
      const timer = setInterval(() => {
        const sh = document.scrollingElement.scrollHeight;
        window.scrollBy(0, 700);
        if (sh === last) { clearInterval(timer); resolve(); }
        last = sh;
      }, 200);
    });
  });
}
async function expandAccordions(page) {
  // Cookie banner (best effort)
  const cookieSelectors = [
    '#onetrust-accept-btn-handler',
    'button:has-text("Accetta e chiudi")',
    'button:has-text("Accetta tutti")',
    'button:has-text("Accetta")',
    'button:has-text("OK")',
    'button:has-text("Ho capito")',
  ];
  for (const s of cookieSelectors) {
    const btn = page.locator(s).first();
    if (await btn.count()) {
      try { if (await btn.isVisible()) await btn.click(); } catch {}
    }
  }
  // Espandi collapse/accordion/tab
  const selectors = [
    '[data-bs-toggle="collapse"]',
    '[data-toggle="collapse"]',
    '.accordion-button',
    '.collapse-toggle',
    '.card-header button',
    'button:has-text("Mostra")',
    'button:has-text("Espandi")',
    'button:has-text("Rosa")',
    'a:has-text("Mostra")',
    'a:has-text("Espandi")',
    'a:has-text("Rosa")',
  ];
  for (const s of selectors) {
    const btns = page.locator(s);
    const n = await btns.count();
    for (let i = 0; i < n; i++) {
      const b = btns.nth(i);
      try { if (await b.isVisible()) await b.click({ delay: 40 }); } catch {}
    }
  }
  const tabs = page.locator('[role="tab"], [data-bs-toggle="tab"]');
  const tcount = await tabs.count();
  for (let i = 0; i < tcount; i++) {
    const t = tabs.nth(i);
    try { if (await t.isVisible()) await t.click({ delay: 40 }); } catch {}
  }
}
async function loginIfNeeded(page) {
  if (process.env.MANUAL_LOGIN === '1') return; // gestito a mano
  if (!EMAIL || !PASSWORD) return;

  await safeGoto(page, LOGIN_URL);

  // Trova form anche in iframe
  let ctx = page;
  const passTop = await page.locator('input[type="password"]:visible, input[name="password"]:visible').count();
  if (!passTop) {
    for (const f of page.frames()) {
      const c = await f.locator('input[type="password"]:visible, input[name="password"]:visible').count();
      if (c) { ctx = f; break; }
    }
  }

  const email = ctx.locator('input[type="email"]:visible, input[name="email"]:visible, input[name="username"]:visible').first();
  const pass  = ctx.locator('input[type="password"]:visible, input[name="password"]:visible').first();

  if (!(await email.count()) || !(await pass.count())) return; // già loggato?

  await email.waitFor({ state: 'visible', timeout: NAV_TIMEOUT });
  await email.fill(EMAIL, { timeout: NAV_TIMEOUT });
  await pass.fill(PASSWORD, { timeout: NAV_TIMEOUT });

  const submit = ctx.locator([
    'button[type="submit"]:visible',
    'input[type="submit"]:visible',
    'button:has-text("Accedi"):visible',
    'button:has-text("Login"):visible',
    'button:has-text("Entra"):visible',
  ].join(', ')).first();

  if (await submit.count()) {
    await submit.click().catch(() => pass.press('Enter'));
    // non usiamo networkidle: lasciamo 2s per il redirect
    await page.waitForTimeout(2000);
  } else {
    await pass.press('Enter');
    await page.waitForTimeout(2000);
  }
}
async function extractRostersFlexible(page) {
  return await page.evaluate(() => {
    const rosters = {};
    const TROLE = /^(p|d|c|a|por|dif|cen|att)/i;
    const isNum = (s) => /\d/.test((s || '').replace(/\./g, '').replace(',', '.'));
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const text = (el) => norm(el?.textContent || '');
    const add = (team, row) => {
      const t = team || 'Senza nome';
      if (!rosters[t]) rosters[t] = [];
      if (row.player) rosters[t].push(row);
    };
    function nearestTeamName(from) {
      let el = from;
      for (let i = 0; i < 8 && el; i++) {
        const h = el.querySelector?.('h1,h2,h3,h4,.team-name,.squadra-nome,.panel-title,.card-title,.title');
        if (h) return text(h);
        el = el.parentElement;
      }
      let p = from.previousElementSibling;
      for (let i = 0; i < 8 && p; i++) {
        if (/H[1-4]/.test(p.tagName) || p.matches?.('.team-name,.squadra-nome,.panel-title,.card-title,.title')) return text(p);
        p = p.previousElementSibling;
      }
      return '';
    }

    // 1) TABELLE (anche senza thead)
    const tables = Array.from(document.querySelectorAll('table'));
    for (const t of tables) {
      const teamName = nearestTeamName(t);
      const rows = Array.from(t.querySelectorAll('tbody tr')).filter(r => r.querySelector('td'));
      if (!rows.length) continue;

      let idx = { ruolo: -1, nome: -1, sq: -1, costo: -1 };
      for (const tr of rows) {
        const tds = Array.from(tr.querySelectorAll('td'));
        if (!tds.length) continue;
        const vals = tds.map(td => text(td));
        idx.ruolo = vals.findIndex(v => TROLE.test(v) && v.length <= 10);
        for (let i = vals.length - 1; i >= 0; i--) { if (isNum(vals[i])) { idx.costo = i; break; } }
        let maxLen = -1, maxIdx = -1;
        vals.forEach((v, i) => { if (v.length > maxLen) { maxLen = v.length; maxIdx = i; } });
        idx.nome = maxIdx;
        for (let i = 0; i < vals.length; i++) { if (i !== idx.ruolo && i !== idx.nome && i !== idx.costo) { idx.sq = i; break; } }
        break;
      }
      for (const tr of rows) {
        const tds = Array.from(tr.querySelectorAll('td'));
        const get = (i) => (i >= 0 && i < tds.length) ? text(tds[i]) : '';
        const ruolo = get(idx.ruolo);
        const nome  = get(idx.nome);
        const sq    = get(idx.sq);
        const costo = get(idx.costo);
        if (nome) add(teamName, { ruolo, player: nome, squadra: sq, costo });
      }
    }

    // 2) LISTE/DIV
    const containers = Array.from(document.querySelectorAll(
      '.players, .rosa, .rose, .player-list, ul, ol, .grid, .list-group'
    )).filter(c => c.querySelector('li, .player, .row, .list-group-item'));
    for (const c of containers) {
      const teamName = nearestTeamName(c);
      const items = Array.from(c.querySelectorAll('li, .player, .row, .list-group-item'));
      for (const it of items) {
        const txt = text(it);
        const m = txt.match(/^\s*(P|D|C|A)\s+([A-ZÀ-ù][\wÀ-ù'.-]+(?:\s+[A-ZÀ-ù][\wÀ-ù'.-]+)*)\s*(?:\(([^)]+)\))?.*?(\d+)\s*$/i);
        if (m) { add(teamName, { ruolo: m[1], player: m[2], squadra: m[3] || '', costo: m[4] }); continue; }
        const nums = txt.match(/(\d+)(?!.*\d)/);
        const costo = nums ? nums[1] : '';
        const parts = txt.split(/[\s•|·\-–—]+/).filter(Boolean).sort((a, b) => b.length - a.length);
        const nome = parts[0] || '';
        if (nome && nome.length > 2) { add(teamName, { ruolo: '', player: nome, squadra: '', costo }); }
      }
    }
    return rosters;
  });
}
async function collectTeamLinks(page) {
  const links = await page.evaluate(() => {
    const out = new Set();
    const abs = (u) => new URL(u, location.origin).href;
    const A = Array.from(document.querySelectorAll('a[href]'));
    for (const a of A) {
      const href = a.getAttribute('href') || '';
      const txt = (a.textContent || '').toLowerCase();
      if (href.includes('/rosa') || /rosa/i.test(txt)) out.add(abs(href));
      if (href.includes('/rose/')) out.add(abs(href));
    }
    return Array.from(out);
  });
  return links.filter(u => u.includes('/negherleague/'));
}

// Navigazione resiliente (niente networkidle)
async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  } catch (e) {
    console.warn('goto warning:', e?.message || e);
  }
  // un piccolo respiro per caricamenti JS
  await page.waitForTimeout(800);
}

// ---------------- Main ----------------
(async () => {
  await ensureDir(STORAGE);
  await ensureDir(path.join(__dirname, '..', OUT));

  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext({
    storageState: (await fs.stat(STORAGE).catch(() => null)) ? STORAGE : undefined,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PlaywrightScraper'
  });

  // Blocca tracker per stabilizzare il caricamento
  await ctx.route('**/*', route => {
    const u = route.request().url();
    if (/googletagmanager|google-analytics|doubleclick|facebook|hotjar|optimizely|segment|sentry|datadog/i.test(u)) {
      return route.abort();
    }
    return route.continue();
  });

  const page = await ctx.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);

  // 1) Login
  await safeGoto(page, LOGIN_URL);
  if (process.env.MANUAL_LOGIN === '1') {
    await waitForEnter();
  } else {
    try { await loginIfNeeded(page); } catch (e) { console.warn('Login automatico non riuscito:', e?.message || e); }
  }

  // 2) Elenco rose
  await safeGoto(page, TARGET_URL);
  await expandAccordions(page);
  await autoScroll(page);

  // 3) Estrai dalla lista
  const fromList = await extractRostersFlexible(page);

  // 4) Visita le pagine "Rosa" di ogni squadra e unisci
  const rosterLinks = await collectTeamLinks(page);
  const merged = { ...fromList };

  for (const url of rosterLinks) {
    try {
      await safeGoto(page, url);
      await expandAccordions(page);
      await autoScroll(page);
      const one = await extractRostersFlexible(page);
      for (const [team, rows] of Object.entries(one || {})) {
        const t = norm(team) || 'Senza nome';
        if (!merged[t]) merged[t] = [];
        merged[t].push(...(rows || []));
      }
    } catch (e) {
      console.warn('Skip link per errore:', url, e?.message || e);
    }
  }

  // 5) Pulizia e salvataggio JSON
  const cleaned = {};
  for (const [team, items] of Object.entries(merged || {})) {
    const tname = norm(team) || 'Senza nome';
    cleaned[tname] = (items || []).map(x => ({
      ruolo: norm(x.ruolo || ''),
      player: norm(x.player || ''),
      squadra: norm(x.squadra || ''),
      costo: x.costo ? (Number.isFinite(Number(x.costo)) ? Number(x.costo) : cleanNumber(x.costo)) : null
    })).filter(x => x.player);
  }

  const outPath = path.join(__dirname, '..', OUT);
  await fs.writeFile(outPath, JSON.stringify(cleaned, null, 2), 'utf8');

  const teamCount = Object.keys(cleaned).length;
  const rowCount = Object.values(cleaned).reduce((a, arr) => a + arr.length, 0);

  if (rowCount === 0) {
    const dbgPng = path.join(__dirname, '..', 'cache', 'page_debug.png');
    const dbgHtml = path.join(__dirname, '..', 'cache', 'page_debug.html');
    await page.screenshot({ path: dbgPng, fullPage: true });
    await fs.writeFile(dbgHtml, await page.content(), 'utf8');
    console.error('Ancora 0 righe: salvati cache/page_debug.png e cache/page_debug.html per debug.');
  } else {
    console.log(`OK: ${teamCount} squadre, ${rowCount} calciatori -> ${outPath}`);
  }

  await ctx.storageState({ path: STORAGE });
  await browser.close();
})().catch(async (err) => {
  console.error('Errore scraper:', err?.message || err);
  process.exit(3);
});
