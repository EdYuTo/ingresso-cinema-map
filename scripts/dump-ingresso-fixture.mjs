#!/usr/bin/env node
/**
 * Capture static Ingresso movie-page HTML and API fixtures for Playwright tests.
 *
 * Usage: npm run test:dump-fixture
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'fixtures', 'ingresso');
const MOVIE_URL = 'https://www.ingresso.com/filme/homem-aranha-um-novo-dia?city=sao-paulo';

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: 'pt-BR' });
const page = await context.newPage();

await context.addCookies([
  {
    name: 'SiteCity',
    value: JSON.stringify({
      Id: '1', Name: 'São Paulo', UrlKey: 'sao-paulo', UF: 'SP', State: 'São Paulo',
    }),
    domain: '.ingresso.com',
    path: '/',
  },
  { name: 'ingressoCookieConsent', value: 'true', domain: '.ingresso.com', path: '/' },
]);

const theaters = [];
const cities = [];

page.on('response', async (res) => {
  const url = res.url();
  try {
    if (url.includes('/v0/theaters/city/') && res.ok()) {
      theaters.push(await res.text());
    }
    if (url.includes('/v0/states/city/name/') && res.ok()) {
      cities.push(await res.text());
    }
  } catch {}
});

console.log('Fetching live Ingresso page…');
await page.goto(MOVIE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => {
  return Array.from(document.body.querySelectorAll('*')).some(
    el => /^\d{2}:\d{2}$/.test(el.textContent.trim()) && el.children.length === 0,
  );
}, { timeout: 90000 });
await page.waitForTimeout(3000);

const html = await page.content();
fs.writeFileSync(path.join(OUT, 'movie-page.html'), html);

if (theaters[0]) {
  fs.writeFileSync(path.join(OUT, 'theaters-city-1.json'), theaters[0]);
} else {
  console.warn('Theater API response not captured — fetching directly…');
  const res = await fetch('https://api-content.ingresso.com/v0/theaters/city/1?partnership=encora');
  fs.writeFileSync(path.join(OUT, 'theaters-city-1.json'), await res.text());
}

if (cities[0]) {
  fs.writeFileSync(path.join(OUT, 'city-sao-paulo.json'), cities[0]);
} else {
  console.warn('City API response not captured — fetching directly…');
  const res = await fetch('https://api-content.ingresso.com/v0/states/city/name/sao-paulo');
  fs.writeFileSync(path.join(OUT, 'city-sao-paulo.json'), await res.text());
}

const sessions = await page.evaluate(() => {
  const TIME_RE = /^\d{2}:\d{2}$/;
  return Array.from(document.body.querySelectorAll('*'))
    .filter(el => TIME_RE.test(el.textContent.trim()) && el.children.length === 0).length;
});

console.log(`Saved fixtures to ${OUT}`);
console.log(`  movie-page.html (${html.length} bytes, ${sessions} session times)`);
console.log(`  theaters-city-1.json`);
console.log(`  city-sao-paulo.json`);

await browser.close();
