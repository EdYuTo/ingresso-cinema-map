#!/usr/bin/env node
/**
 * Captures marketing screenshots with the extension loaded in Chromium via Playwright.
 * Saves PNGs to website/images/ (used by the landing page and README).
 *
 * Usage: npm run screenshots
 * Requires: npm install && npx playwright install chromium
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { LOCATIONS } from './lib/test-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'website', 'images');
const PROFILE = path.join(ROOT, '.playwright-profile');
const MOVIE_URL = 'https://www.ingresso.com/filme/homem-aranha-um-novo-dia?city=sao-paulo';

/** Zoom for 01-map-overview (Leaflet: ~12 = wide, 13 = balanced, 14+ = tight) */
const OVERVIEW_ZOOM = 13;

const GROUP_FRIENDS = [
  LOCATIONS.cinusp.shortLink,
  LOCATIONS.museu.mapsUrl,
  LOCATIONS.belasArtes.typedAddress,
];

fs.mkdirSync(OUT, { recursive: true });

async function dismissCookies(page) {
  for (const sel of ['#rcc-confirm-button', '.CookieConsent button']) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 })) {
        await btn.click();
        await page.waitForSelector('.CookieConsent', { state: 'detached', timeout: 3000 }).catch(() => {});
      }
    } catch {}
  }
  await page.addStyleTag({
    content: '.CookieConsent, [class*="CookieConsent"] { display: none !important; visibility: hidden !important; }',
  }).catch(() => {});
}

async function waitForExtension(context) {
  await new Promise(r => setTimeout(r, 2000));
  let [sw] = context.serviceWorkers();
  if (!sw) {
    sw = await context.waitForEvent('serviceworker', { timeout: 30000 });
  }
  if (!sw.url().includes('chrome-extension://')) {
    throw new Error(`Service worker inesperado: ${sw.url()}`);
  }
  console.log('  ✓ Extensão carregada:', sw.url().split('/')[2]);
  return sw;
}

async function waitForPanel(page) {
  await page.waitForSelector('#icm-panel', { state: 'attached', timeout: 90000 });
  const fromExtension = await page.evaluate(() => !!window.__icmLoaded);
  if (!fromExtension) {
    throw new Error('Painel encontrado, mas window.__icmLoaded ausente — content script não rodou.');
  }
  console.log('  ✓ Content script ativo');
}

async function waitForMap(page) {
  await page.waitForSelector('#icm-map-section', { state: 'visible', timeout: 180000 });
  await page.waitForSelector('#icm-map .leaflet-tile', { timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('.icm-pin').length > 0, { timeout: 60000 });
  await page.waitForTimeout(3000);
  console.log('  ✓ Mapa renderizado');
}

async function ensureMapReady(page) {
  if (await page.locator('#icm-map-section').isVisible()) return;

  if (await page.locator('#icm-btn-manual-loading').isVisible({ timeout: 5000 }).catch(() => false)) {
    await page.locator('#icm-btn-manual-loading').click();
  } else if (await page.locator('#icm-btn-manual-err').isVisible({ timeout: 2000 }).catch(() => false)) {
    await page.locator('#icm-btn-manual-err').click();
  }

  if (await page.locator('#icm-manual').isVisible({ timeout: 3000 }).catch(() => false)) {
    await page.locator('#icm-manual-input').fill('Consolação, São Paulo');
    await page.locator('#icm-btn-manual-go').click();
    await page.waitForSelector('#icm-loc-preview:not(.icm-hidden)', { timeout: 60000 });
    await page.locator('#icm-loc-preview-confirm').click();
  }

  await waitForMap(page);
}

async function shot(page, name, locator) {
  await dismissCookies(page);
  const file = path.join(OUT, name);
  const el = page.locator(locator).first();
  await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await el.screenshot({ path: file });
  console.log('  ✓', name);
}

async function frameMapForOverview(page, zoom = OVERVIEW_ZOOM) {
  await page.evaluate((targetZoom) => {
    const map = document.querySelector('#icm-map')?._leaflet_map;
    if (!map) return;

    let latlng = map.getCenter();
    const userPane = document.querySelector('.icm-user-dot-wrapper');
    if (userPane) {
      const marker = userPane.closest('.leaflet-marker-icon');
      const mapEl = document.querySelector('#icm-map');
      if (marker && mapEl) {
        const mapRect = mapEl.getBoundingClientRect();
        const r = marker.getBoundingClientRect();
        const point = map.mouseEventToContainerPoint({
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
        });
        latlng = map.containerPointToLatLng(point);
      }
    }

    map.setView(latlng, targetZoom, { animate: false });
  }, zoom);

  await page.waitForFunction(
    z => document.querySelector('#icm-map')?._leaflet_map?.getZoom() === z,
    zoom,
    { timeout: 10000 }
  ).catch(() => {});
  await page.waitForTimeout(1500);
}

async function shotCinemaCard(page, name) {
  await dismissCookies(page);
  const card = page.locator('div.bg-ing-neutral-600.mt-6').first();
  await card.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await page.waitForTimeout(600);
  await card.screenshot({ path: path.join(OUT, name) });
  console.log('  ✓', name);
}

async function addGroupFriend(page, address) {
  const before = await page.locator('#icm-group-list .icm-group-item').count();
  await page.locator('#icm-group-search').fill(address);
  await page.locator('#icm-group-add-btn').click();
  await page.locator('#icm-loc-preview-confirm').click({ timeout: 90000 });
  await page.waitForFunction(
    n => document.querySelectorAll('#icm-group-list .icm-group-item').length > n,
    before,
    { timeout: 90000 }
  );
  await page.waitForTimeout(800);
}

console.log('Abrindo Chromium com extensão…');
const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 1360, height: 900 },
  locale: 'pt-BR',
  geolocation: { latitude: -23.5505, longitude: -46.6333 },
  permissions: ['geolocation'],
  args: [
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
    '--no-first-run',
    '--disable-default-apps',
  ],
});

const page = context.pages()[0] || await context.newPage();

try {
  await waitForExtension(context);

  await context.addCookies([
    {
      name: 'SiteCity',
      value: JSON.stringify({
        Id: '1', Name: 'São Paulo', UrlKey: 'sao-paulo', UF: 'SP', State: 'São Paulo'
      }),
      domain: '.ingresso.com',
      path: '/',
    },
    { name: 'ingressoCookieConsent', value: 'true', domain: '.ingresso.com', path: '/' },
    { name: 'dcuc', value: 'true', domain: '.ingresso.com', path: '/' },
  ]);

  console.log('Navegando…');
  await page.goto(MOVIE_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await dismissCookies(page);

  await waitForPanel(page);
  await ensureMapReady(page);

  console.log('Capturando screenshots…');
  await frameMapForOverview(page);
  await shot(page, '01-map-overview.png', '#icm-map-section');

  await page.locator('#icm-btn-change-loc').click();
  await page.waitForSelector('#icm-loc-search:not(.icm-hidden)', { timeout: 15000 });
  await shot(page, '02-location-search.png', '#icm-map-wrap');

  await page.locator('#icm-loc-search-input').fill('R. da Consolação, 2423');
  await page.locator('#icm-loc-search-go').click();
  await page.waitForSelector('#icm-loc-preview:not(.icm-hidden)', { timeout: 45000 });
  await page.waitForTimeout(2000);
  await shot(page, '03-location-preview.png', '#icm-map-wrap');

  await page.locator('#icm-loc-preview-cancel').click();
  await page.waitForTimeout(1000);

  await shotCinemaCard(page, '04-cinema-list.png');

  await page.locator('#icm-btn-group-toggle').click();
  await page.waitForSelector('#icm-group-modal:not(.icm-hidden)', { timeout: 15000 });

  for (const address of GROUP_FRIENDS) {
    console.log('  + amigo:', address);
    await addGroupFriend(page, address);
  }

  await dismissCookies(page);
  const panel = page.locator('#icm-group-modal .icm-group-panel').first();
  await panel.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await panel.screenshot({ path: path.join(OUT, '05-group-friends.png') });
  console.log('  ✓ 05-group-friends.png');

  await page.locator('#icm-group-done').click();
  await page.waitForFunction(
    () => document.getElementById('icm-group-modal')?.classList.contains('icm-hidden'),
    { timeout: 15000 }
  );
  await page.locator('[data-group-mode="per-friend"]').click();
  await page.waitForFunction(
    n => document.querySelectorAll('.icm-friend-marker').length >= n,
    GROUP_FRIENDS.length,
    { timeout: 60000 }
  );
  await page.waitForTimeout(2000);
  await shot(page, '06-group-per-friend-map.png', '#icm-map-section');

  await shotCinemaCard(page, '07-cinema-list-per-friend.png');

  console.log(`\nConcluído → ${OUT}`);
} finally {
  await context.close();
}
