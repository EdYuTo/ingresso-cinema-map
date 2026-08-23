#!/usr/bin/env node
/**
 * Integration tests for Google Maps short-link resolution.
 *
 * Usage: npm run test:short-links
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PROFILE = path.join(ROOT, '.playwright-profile-test-links');
const MOVIE_URL = 'https://www.ingresso.com/filme/homem-aranha-um-novo-dia?city=sao-paulo';

const SHORT_LINKS = {
  gooGl: {
    url: 'https://maps.app.goo.gl/szdszr6joEkMwcmZ8',
    labelIncludes: 'Augusta',
    lat: -23.5530761,
    lng: -46.6543601,
    toleranceKm: 0.5
  },
  shareGoogle: {
    url: 'https://share.google/1uSGaGSSbEpz9G7Zp',
    labelIncludes: 'Augusta',
    lat: -23.5530761,
    lng: -46.6543601,
    toleranceKm: 1.0
  },
  shareGoogleOtherCity: {
    url: 'https://share.google/slxZRns0XhUsFKRgA',
    labelIncludes: 'Paolone',
    lat: -23.6130842,
    lng: -46.5679765,
    toleranceKm: 1.0
  }
};

let passed = 0;
let failed = 0;

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function assert(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
    return;
  }
  failed += 1;
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

async function dismissCookies(page) {
  for (const sel of ['#rcc-confirm-button', '.CookieConsent button']) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 })) await btn.click();
    } catch {}
  }
}

async function waitForExtension(context) {
  await new Promise(r => setTimeout(r, 1500));
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30000 });
  if (!sw.url().includes('chrome-extension://')) {
    throw new Error(`Unexpected service worker: ${sw.url()}`);
  }
  console.log('  ✓ Extension loaded');
  return sw;
}

async function waitForPanel(page) {
  await page.waitForSelector('#icm-panel', { state: 'attached', timeout: 90000 });
  await page.waitForFunction(() => !!window.__icmLoaded, { timeout: 30000 });
  console.log('  ✓ Content script active');
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

  await page.waitForSelector('#icm-map-section', { state: 'visible', timeout: 180000 });
  await page.waitForSelector('#icm-map .leaflet-tile', { timeout: 60000 });
}

async function resolveViaBackground(context, url) {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30000 });
  await sw.evaluate(() => new Promise(r => setTimeout(r, 500)));
  return sw.evaluate(async (shortUrl) => {
    const fn = self.__icmResolveMapsShortLink || globalThis.__icmResolveMapsShortLink;
    if (typeof fn !== 'function') {
      throw new Error('__icmResolveMapsShortLink missing in service worker');
    }
    return fn(shortUrl);
  }, url);
}

function extractCoordsFromResolved(resolvedUrl) {
  const m34 = resolvedUrl.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (m34) return { lat: parseFloat(m34[1]), lng: parseFloat(m34[2]) };

  const m12 = resolvedUrl.match(/!1d(-?\d+(?:\.\d+)?)!2d(-?\d+(?:\.\d+)?)/);
  if (m12) return { lng: parseFloat(m12[1]), lat: parseFloat(m12[2]) };

  const at = resolvedUrl.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (at) return { lat: parseFloat(at[1]), lng: parseFloat(at[2]) };

  return null;
}

async function testBackgroundResolver(context, name, spec) {
  console.log(`\nBackground: ${name}`);
  let resolved;
  try {
    resolved = await resolveViaBackground(context, spec.url);
  } catch (err) {
    assert('resolver success', false, err.message);
    return;
  }

  assert('resolver returned URL', typeof resolved === 'string' && resolved.length > 0, String(resolved));
  if (typeof resolved !== 'string') return;

  console.log(`    → ${resolved.slice(0, 120)}${resolved.length > 120 ? '…' : ''}`);

  assert('resolved URL is not still a short link', !/maps\.app\.goo\.gl|share\.google/.test(resolved), resolved);

  const coords = extractCoordsFromResolved(resolved);
  if (coords) {
    const dist = haversine(coords.lat, coords.lng, spec.lat, spec.lng);
    assert(
      `coordinates within ${spec.toleranceKm} km`,
      dist <= spec.toleranceKm,
      `got ${coords.lat},${coords.lng} (${dist.toFixed(2)} km away)`
    );
  } else if (resolved.includes('/search?')) {
    assert(
      'search URL contains expected address',
      resolved.toLowerCase().includes(spec.labelIncludes.toLowerCase()),
      resolved
    );
  } else {
    assert('extracted coordinates or search URL', false, resolved);
  }
}

async function testGroupUiFlow(page, name, spec) {
  console.log(`\nGroup UI: ${name}`);

  await page.locator('#icm-btn-group-toggle').click();
  await page.waitForSelector('#icm-group-modal:not(.icm-hidden)', { timeout: 15000 });

  const before = await page.locator('#icm-group-list .icm-group-item').count();
  await page.locator('#icm-group-search').fill(spec.url);
  await page.locator('#icm-group-add-btn').click();

  const errorVisible = await page.locator('#icm-group-search-error:not(.icm-hidden)').isVisible({ timeout: 5000 }).catch(() => false);
  if (errorVisible) {
    const err = await page.locator('#icm-group-search-error').textContent();
    assert('no visible group search error', false, err?.trim());
    await page.locator('#icm-group-close').click();
    return;
  }

  await page.waitForSelector('#icm-loc-preview:not(.icm-hidden)', { timeout: 90000 });
  const previewLabel = await page.locator('#icm-loc-preview-label').textContent();
  assert('preview label mentions address', (previewLabel || '').includes(spec.labelIncludes), previewLabel);

  await page.waitForSelector('.icm-preview-dot', { timeout: 10000 }).catch(() => {});

  const previewCoords = await page.evaluate(() => {
    const map = document.querySelector('#icm-map')?._leaflet_map;
    if (!map) return null;

    let coords = null;
    map.eachLayer(layer => {
      if (!layer.getLatLng) return;
      const html = layer.options?.icon?.options?.html || '';
      if (html.includes('icm-preview-dot')) {
        coords = layer.getLatLng();
      }
    });
    return coords ? { lat: coords.lat, lng: coords.lng } : null;
  });

  if (previewCoords) {
    const dist = haversine(previewCoords.lat, previewCoords.lng, spec.lat, spec.lng);
    assert(
      `preview marker within ${spec.toleranceKm} km`,
      dist <= spec.toleranceKm,
      `${previewCoords.lat},${previewCoords.lng} (${dist.toFixed(2)} km away)`
    );
  } else {
    const dotVisible = await page.locator('.icm-preview-dot').isVisible().catch(() => false);
    assert('preview marker present on map', dotVisible);
  }

  await page.locator('#icm-loc-preview-confirm').click();
  await page.waitForFunction(
    n => document.querySelectorAll('#icm-group-list .icm-group-item').length > n,
    before,
    { timeout: 30000 }
  );

  assert('friend added to group list', true);
  await page.locator('#icm-group-exit').click();
  await page.waitForSelector('#icm-group-bar.icm-hidden', { timeout: 10000 });
}

console.log('Launching Chromium with extension…');
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
  await page.goto(MOVIE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await dismissCookies(page);
  await waitForPanel(page);
  await ensureMapReady(page);

  await testBackgroundResolver(context, 'maps.app.goo.gl', SHORT_LINKS.gooGl);
  await testBackgroundResolver(context, 'share.google', SHORT_LINKS.shareGoogle);
  await testBackgroundResolver(context, 'share.google (outra cidade)', SHORT_LINKS.shareGoogleOtherCity);

  await testGroupUiFlow(page, 'maps.app.goo.gl', SHORT_LINKS.gooGl);
  await testGroupUiFlow(page, 'share.google', SHORT_LINKS.shareGoogle);
  await testGroupUiFlow(page, 'share.google (outra cidade)', SHORT_LINKS.shareGoogleOtherCity);

  console.log(`\n${'='.repeat(40)}`);
  console.log(`Passed: ${passed}  Failed: ${failed}`);
  if (failed > 0) process.exitCode = 1;
} catch (err) {
  console.error('\nFatal:', err.message);
  process.exitCode = 1;
} finally {
  await context.close();
}
