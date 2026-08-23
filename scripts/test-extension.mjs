#!/usr/bin/env node
/**
 * Playwright integration tests for Ingresso Cinema Map.
 *
 * Usage: npm test
 */

import {
  LOCATIONS,
  createReporter,
  launchExtensionContext,
  waitForExtension,
  waitForInitialLoad,
  openFixturePage,
  waitForPanel,
  setPersonalLocation,
  clickSort,
  readCinemaSortOrder,
  openGroupModal,
  addGroupFriend,
  resolveViaBackground,
  isSortedAsc,
  isSortedDesc,
  isSortedLocaleNames,
} from './lib/test-harness.mjs';

const report = createReporter();

async function testPersonalShortLink(page) {
  report.section('Personal location: share.google short link');
  await setPersonalLocation(page, LOCATIONS.cinusp.shortLink);

  const mapVisible = await page.locator('#icm-map-section').isVisible();
  report.assert('map section visible after short link', mapVisible);

  const pins = await page.locator('.icm-pin').count();
  report.assert('cinema pins rendered', pins > 0, `pins=${pins}`);
}

async function testSortControls(page) {
  report.section('Sort: Mais próximo (dist-asc)');

  await clickSort(page, 'dist-asc');
  let order = await readCinemaSortOrder(page);
  const ascKm = order.map(o => o.km).filter(km => km != null);
  report.assert('dist-asc produces distance badges', ascKm.length >= 3, `count=${ascKm.length}`);
  report.assert('dist-asc sorted ascending', isSortedAsc(ascKm), ascKm.slice(0, 5).join(', '));

  report.section('Sort: Mais distante (dist-desc)');
  await clickSort(page, 'dist-desc');
  order = await readCinemaSortOrder(page);
  const descKm = order.map(o => o.km).filter(km => km != null);
  report.assert('dist-desc sorted descending', isSortedDesc(descKm), descKm.slice(0, 5).join(', '));

  report.section('Sort: A–Z (name)');
  await clickSort(page, 'name');
  order = await readCinemaSortOrder(page);
  const names = order.map(o => o.name);
  report.assert('name sort has cinema names', names.length >= 3, `count=${names.length}`);
  report.assert('name sort is alphabetical (pt-BR)', isSortedLocaleNames(names), names.slice(0, 5).join(' | '));

  await clickSort(page, 'dist-asc');
}

async function testBackgroundShortLink(context) {
  report.section('Background resolver: CINUSP share.google');
  let resolved;
  try {
    resolved = await resolveViaBackground(context, LOCATIONS.cinusp.shortLink);
  } catch (err) {
    report.assert('resolver success', false, err.message);
    return;
  }

  report.assert('resolver returned URL', typeof resolved === 'string' && resolved.length > 0);
  report.assert('resolved URL is not still a short link', !/share\.google/.test(resolved), resolved);
  report.assert(
    'resolved URL mentions CINUSP',
    resolved.toLowerCase().includes('cinusp'),
    resolved.slice(0, 120),
  );
}

async function testGroupFriends(page) {
  report.section('Group: friend via share.google short link');
  await openGroupModal(page);
  await addGroupFriend(page, LOCATIONS.cinusp.shortLink, {
    labelIncludes: LOCATIONS.cinusp.labelIncludes,
  });
  report.assert('CINUSP friend in list', await page.locator('#icm-group-list').textContent()
    .then(t => (t || '').includes('CINUSP') || (t || '').includes('Paulo Emílio')));

  report.section('Group: friend via Google Maps URL (daddr)');
  await addGroupFriend(page, LOCATIONS.museu.mapsUrl, {
    labelIncludes: LOCATIONS.museu.labelIncludes,
  });
  report.assert('Museu friend in list', await page.locator('#icm-group-list').textContent()
    .then(t => (t || '').toLowerCase().includes('europa') || (t || '').toLowerCase().includes('museu')));

  report.section('Group: friend via typed address');
  await addGroupFriend(page, LOCATIONS.belasArtes.typedAddress, {
    labelIncludes: LOCATIONS.belasArtes.labelIncludes,
  });

  const friendCount = await page.locator('#icm-group-list .icm-group-item').count();
  report.assert('three friends added', friendCount === 3, `count=${friendCount}`);

  await page.locator('#icm-group-done').click();
  await page.waitForFunction(
    () => document.getElementById('icm-group-modal')?.classList.contains('icm-hidden'),
    { timeout: 10000 },
  );

  const friendMarkers = await page.locator('.icm-friend-marker').count();
  report.assert('friend markers on map', friendMarkers >= 3, `markers=${friendMarkers}`);
}

console.log('Launching Chromium with extension and static Ingresso fixture…');
const { context, page } = await launchExtensionContext();

try {
  await waitForExtension(context);
  await openFixturePage(page);
  await waitForPanel(page);
  await waitForInitialLoad(page);

  await testBackgroundShortLink(context);
  await testPersonalShortLink(page);
  await testSortControls(page);
  await testGroupFriends(page);

  const failures = report.summary();
  if (failures > 0) process.exitCode = 1;
} catch (err) {
  console.error('\nFatal:', err.message);
  process.exitCode = 1;
} finally {
  await context.close();
}
