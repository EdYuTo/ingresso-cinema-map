import { chromium } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '../..');
export const FIXTURES = path.join(ROOT, 'fixtures', 'ingresso');
export const PROFILE = process.env.CI
  ? path.join(os.tmpdir(), 'icm-playwright-profile-tests')
  : path.join(ROOT, '.playwright-profile-tests');
export const MOVIE_URL = 'https://www.ingresso.com/filme/homem-aranha-um-novo-dia?city=sao-paulo';

/** Public test locations — no personal addresses. */
export const LOCATIONS = {
  cinusp: {
    label: 'CINUSP Paulo Emílio',
    shortLink: 'https://share.google/fPuv7UtLbssmOp2YP',
    labelIncludes: 'CINUSP',
    toleranceKm: 2,
  },
  museu: {
    label: 'Museu da Imagem e do Som',
    mapsUrl:
      'https://www.google.com/maps?sca_esv=ff238d4159edaedd&sxsrf=APpeQnuQlZ9OPKq43ulpsqDBlHdcgNS-JQ:1787492066420&biw=1272&bih=868&uact=5&gs_lp=Egxnd3Mtd2l6LXNlcnAiGE11c2V1IGRhIEltYWdlbSBlIGRvIFNvbTIREC4YrwEYxwEYywEYgAQYjgUyCBAAGIAEGMsBMhEQLhiABBjLARjHARivARiOBTIIEAAYgAQYywEyCBAAGIAEGMsBMggQABiABBjLATIIEAAYgAQYywEyCBAAGIAEGMsBMggQABiABBjLATIIEAAYgAQYywEyIBAuGK8BGMcBGMsBGIAEGI4FGJcFGNwEGN4EGOAE2AEBSP0MUNEGWNEGcAF4AZABAJgBngGgAZ4BqgEDMC4xuAEDyAEA-AEC-AEBmAICoAKrAcICChAAGEcY1gQYsAPCAhcQLhjcBhi4BhjaBhjYAhjIAxiwA9gBAZgDAIgGAZAGDboGBggBEAEYGZIHAzEuMaAH3Q6yBwMwLjG4B6QBwgcDMi0yyAcLgAgB&um=1&ie=UTF-8&fb=1&gl=br&sa=X&geocode=KWW5cLpkV86UMcHU5T3iNLiU&daddr=Av.+Europa,+158+-+Jardim+Europa,+S%C3%A3o+Paulo+-+SP,+01449-000',
    labelIncludes: 'Europa',
    toleranceKm: 2,
  },
  belasArtes: {
    label: 'Cine Belas Artes',
    typedAddress: 'R. da Consolação, 2423 - Consolação, São Paulo - SP, 01301-100',
    labelIncludes: 'Consolação',
    toleranceKm: 2,
  },
};

export function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function createReporter() {
  let passed = 0;
  let failed = 0;

  return {
    passed: () => passed,
    failed: () => failed,
    assert(name, condition, detail = '') {
      if (condition) {
        passed += 1;
        console.log(`  ✓ ${name}`);
        return;
      }
      failed += 1;
      console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    },
    section(title) {
      console.log(`\n${title}`);
    },
    summary() {
      console.log(`\n${'='.repeat(40)}`);
      console.log(`Passed: ${passed}  Failed: ${failed}`);
      return failed;
    },
  };
}

function stripScripts(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '');
}

let fixtureHtmlCache = null;

function loadFixtureHtml() {
  if (!fixtureHtmlCache) {
    const raw = fs.readFileSync(path.join(FIXTURES, 'movie-page.html'), 'utf8');
    fixtureHtmlCache = stripScripts(raw);
  }
  return fixtureHtmlCache;
}

/** Stable maps URLs used to mock Google short-link resolution in CI. */
const MOCK_MAPS_URLS = {
  cinusp:
    'https://www.google.com/maps/place/CINUSP+Paulo+Em%C3%ADlio/@-23.561414,-46.730982,17z/data=!3d-23.561414!4d-46.730982',
  museu:
    'https://www.google.com/maps/place/Museu+da+Imagem+e+do+Som/@-23.5756,-46.6889,17z/data=!3d-23.5756!4d-46.6889',
};

const MOCK_NOMINATIM = {
  belasArtes: [{
    lat: '-23.5558',
    lon: '-46.6626',
    display_name: 'Rua da Consolação, 2423, Consolação, São Paulo, SP, Brasil',
  }],
  museu: [{
    lat: '-23.5756',
    lon: '-46.6889',
    display_name: 'Av. Europa, 158, Jardim Europa, São Paulo, SP, Brasil',
  }],
};

export async function setupNetworkMocks(context) {
  if (!process.env.CI) return;
  const shortLinkPattern = /https:\/\/(share\.google[^/]*|maps\.app\.goo\.gl|goo\.gl)\//;

  await context.route(shortLinkPattern, (route) => {
    route.fulfill({
      status: 302,
      headers: { Location: MOCK_MAPS_URLS.cinusp },
    });
  });

  await context.route('**/nominatim.openstreetmap.org/search**', (route) => {
    const q = decodeURIComponent(new URL(route.request().url()).searchParams.get('q') || '').toLowerCase();
    let body = MOCK_NOMINATIM.belasArtes;
    if (q.includes('europa') || q.includes('museu')) body = MOCK_NOMINATIM.museu;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });

  const tilePng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAD0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  await context.route('**tile.openstreetmap.org/**', (route) => {
    route.fulfill({ status: 200, contentType: 'image/png', body: tilePng });
  });
}

/** Short-link resolution via content-bridge is flaky in CI; use stable maps URLs there. */
export function personalLocationInput() {
  return process.env.CI ? MOCK_MAPS_URLS.cinusp : LOCATIONS.cinusp.shortLink;
}

export function groupCinuspInput() {
  return process.env.CI ? MOCK_MAPS_URLS.cinusp : LOCATIONS.cinusp.shortLink;
}

export async function setupFixtureRoutes(page) {
  const html = loadFixtureHtml();
  const theaters = fs.readFileSync(path.join(FIXTURES, 'theaters-city-1.json'), 'utf8');
  const city = fs.readFileSync(path.join(FIXTURES, 'city-sao-paulo.json'), 'utf8');

  await page.route('**/www.ingresso.com/filme/**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: html,
    });
  });

  await page.route('**/api-content.ingresso.com/v0/theaters/city/**', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: theaters });
  });

  await page.route('**/api-content.ingresso.com/v0/states/city/name/**', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: city });
  });
}

export async function launchExtensionContext() {
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: { width: 1360, height: 900 },
    locale: 'pt-BR',
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--no-first-run',
      '--disable-default-apps',
    ],
  });

  const page = context.pages()[0] || await context.newPage();
  await setupNetworkMocks(context);
  await setupFixtureRoutes(page);

  if (process.env.CI) {
    await context.grantPermissions(['geolocation'], { origin: 'https://www.ingresso.com' });
    await context.setGeolocation({ latitude: -23.561414, longitude: -46.730982 });
  }

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
    { name: 'dcuc', value: 'true', domain: '.ingresso.com', path: '/' },
  ]);

  return { context, page };
}

export async function waitForExtension(context) {
  await new Promise(r => setTimeout(r, 1500));
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30000 });
  if (!sw.url().includes('chrome-extension://')) {
    throw new Error(`Unexpected service worker: ${sw.url()}`);
  }
  console.log('  ✓ Extension loaded');
  return sw;
}

export async function openFixturePage(page) {
  await page.goto(MOVIE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.addStyleTag({
    content: '.CookieConsent, [class*="CookieConsent"] { display: none !important; }',
  }).catch(() => {});
}

export async function waitForPanel(page) {
  await page.waitForSelector('#icm-panel', { state: 'attached', timeout: 90000 });
  await page.waitForFunction(() => !!window.__icmLoaded, { timeout: 30000 });
  console.log('  ✓ Content script active');
}

export async function waitForInitialLoad(page) {
  await page.waitForFunction(() => {
    const loading = document.getElementById('icm-loading');
    if (loading && loading.style.display !== 'none') return false;

    const visible = (id) => {
      const el = document.getElementById(id);
      if (!el) return false;
      return el.style.display !== 'none' && !el.classList.contains('icm-hidden');
    };
    return visible('icm-map-section') || visible('icm-manual') || visible('icm-error');
  }, { timeout: 240000 });
}

async function openLocationEntry(page) {
  if (await page.locator('#icm-loc-search:not(.icm-hidden)').isVisible({ timeout: 1000 }).catch(() => false)) {
    return 'search';
  }
  if (await page.locator('#icm-manual').isVisible({ timeout: 1000 }).catch(() => false)) {
    return 'manual';
  }
  if (await page.locator('#icm-map-section').isVisible({ timeout: 1000 }).catch(() => false)) {
    await page.locator('#icm-btn-change-loc').click();
    await page.waitForSelector('#icm-loc-search:not(.icm-hidden)', { timeout: 15000 });
    return 'search';
  }

  for (const sel of ['#icm-btn-manual-err', '#icm-btn-manual-loading']) {
    const btn = page.locator(sel);
    if (await btn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await btn.click();
      break;
    }
  }

  if (await page.locator('#icm-loc-search:not(.icm-hidden)').isVisible({ timeout: 5000 }).catch(() => false)) {
    return 'search';
  }

  await page.waitForSelector('#icm-manual', { state: 'visible', timeout: 15000 });
  return 'manual';
}

async function submitLocationQuery(page, _query, errorSelector) {
  const preview = page.locator('#icm-loc-preview:not(.icm-hidden)');
  const error = page.locator(`${errorSelector}:not(.icm-hidden)`);

  await Promise.race([
    preview.waitFor({ state: 'visible', timeout: 120000 }),
    error.waitFor({ state: 'visible', timeout: 120000 }).then(async () => {
      throw new Error((await error.textContent())?.trim() || 'Location search failed');
    }),
  ]);

  await page.locator('#icm-loc-preview-confirm').click({ force: true });
}

export async function waitForMap(page) {
  await page.waitForSelector('#icm-map-section', { state: 'visible', timeout: 180000 });
  await page.waitForSelector('#icm-map .leaflet-tile', { timeout: 120000 });
  await page.waitForFunction(() => document.querySelectorAll('.icm-pin').length > 0, undefined, {
    timeout: 120000,
  });
}

export async function setPersonalLocation(page, query) {
  const mode = await openLocationEntry(page);

  if (mode === 'search') {
    await page.locator('#icm-loc-search-input').fill(query);
    await page.locator('#icm-loc-search-go').click();
    await submitLocationQuery(page, query, '#icm-loc-search-error');
  } else {
    await page.locator('#icm-manual-input').fill(query);
    await page.locator('#icm-btn-manual-go').click();
    await submitLocationQuery(page, query, '#icm-manual-error');
  }

  await waitForMap(page);
}

export async function clickSort(page, sortKey) {
  const chip = page.locator(`.icm-chip[data-sort="${sortKey}"]`);
  await chip.click();
  await page.waitForFunction(
    key => document.querySelector(`.icm-chip[data-sort="${key}"]`)?.classList.contains('icm-chip-active'),
    sortKey,
    { timeout: 10000 },
  );
  await page.waitForTimeout(400);
}

export async function readCinemaSortOrder(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('[data-icm-dist]')).map((badge) => {
      const card = badge.parentElement;
      const h2 = card?.querySelector('h2');
      const text = badge.textContent || '';
      const kmMatch = text.match(/([\d.]+)\s*km/);
      return {
        name: h2?.textContent?.trim() || '',
        km: kmMatch ? parseFloat(kmMatch[1]) : null,
      };
    }).filter(entry => entry.name);
  });
}

export async function openGroupModal(page) {
  await page.locator('#icm-btn-group-toggle').click();
  await page.waitForSelector('#icm-group-modal:not(.icm-hidden)', { timeout: 15000 });
}

export async function addGroupFriend(page, query, { labelIncludes } = {}) {
  await page.waitForSelector('#icm-group-modal:not(.icm-hidden)', { timeout: 15000 });

  const before = await page.locator('#icm-group-list .icm-group-item').count();
  await page.locator('#icm-group-search').fill(query);
  await page.locator('#icm-group-add-btn').click();

  const errorVisible = await page.locator('#icm-group-search-error:not(.icm-hidden)')
    .isVisible({ timeout: 10000 }).catch(() => false);
  if (errorVisible) {
    const err = await page.locator('#icm-group-search-error').textContent();
    throw new Error(err?.trim() || 'Group search failed');
  }

  await page.waitForSelector('#icm-loc-preview:not(.icm-hidden)', { timeout: 120000 });
  await page.waitForSelector('.icm-preview-dot', { timeout: 20000 });

  if (labelIncludes) {
    const previewLabel = await page.locator('#icm-loc-preview-label').textContent();
    if (!(previewLabel || '').includes(labelIncludes)) {
      throw new Error(`Preview label missing "${labelIncludes}": ${previewLabel}`);
    }
  }

  await page.evaluate(() => {
    document.getElementById('icm-loc-preview-confirm')?.click();
  });
  await page.waitForFunction(
    n => document.querySelectorAll('#icm-group-list .icm-group-item').length > n,
    before,
    { timeout: 60000 },
  );
  await page.waitForSelector('#icm-group-modal:not(.icm-hidden)', { timeout: 15000 });
}

export async function resolveViaBackground(context, url) {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30000 });
  await sw.evaluate(() => new Promise(r => setTimeout(r, 500)));
  return sw.evaluate(async (shortUrl) => {
    const fn = self.__icmResolveMapsShortLink || globalThis.__icmResolveMapsShortLink;
    if (typeof fn !== 'function') throw new Error('__icmResolveMapsShortLink missing');
    return fn(shortUrl);
  }, url);
}

export function isSortedAsc(values, { allowEqual = true } = {}) {
  for (let i = 1; i < values.length; i++) {
    if (allowEqual ? values[i] < values[i - 1] : values[i] <= values[i - 1]) return false;
  }
  return values.length > 0;
}

export function isSortedDesc(values) {
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[i - 1]) return false;
  }
  return values.length > 0;
}

export function isSortedLocaleNames(names) {
  const sorted = [...names].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  return names.length > 0 && names.every((name, i) => name === sorted[i]);
}
