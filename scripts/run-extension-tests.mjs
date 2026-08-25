import {
  LOCATIONS,
  createReporter,
  waitForPanel,
  waitForInitialLoad,
  setPersonalLocation,
  clickSort,
  readCinemaSortOrder,
  openGroupModal,
  addGroupFriend,
  personalLocationInput,
  groupCinuspInput,
  isSortedAsc,
  isSortedDesc,
  isSortedLocaleNames,
  readLeafletMapState,
  readPageCinemaTimeSignature,
  openCinemaPinPopup,
  closeOpenMapPopup,
} from './lib/test-harness.mjs';

export async function runExtensionTests({
  page,
  resolveViaBackground,
  report = createReporter(),
}) {
  async function testPersonalShortLink(page) {
    report.section('Personal location: Google Maps URL (mocked short link)');
    await setPersonalLocation(page, personalLocationInput());

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
    report.assert('dist-asc produces distance badges', ascKm.length >= 2, `count=${ascKm.length}`);
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
    report.assert('name sort has cinema names', names.length >= 2, `count=${names.length}`);
    report.assert('name sort is alphabetical (pt-BR)', isSortedLocaleNames(names), names.slice(0, 5).join(' | '));

    await clickSort(page, 'dist-asc');
  }

  async function testBackgroundShortLink(resolveViaBackground) {
    report.section('Background resolver: CINUSP share.google');
    let resolved;
    try {
      resolved = await resolveViaBackground(LOCATIONS.cinusp.shortLink);
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

  async function assertMapStable(page, expected, label) {
    const state = await readLeafletMapState(page);
    report.assert(
      `${label}: same leaflet instance`,
      state?.mapId === expected.mapId,
      `before=${expected.mapId} after=${state?.mapId}`,
    );
    report.assert(
      `${label}: zoom preserved`,
      state?.zoom === expected.zoom,
      `before=${expected.zoom} after=${state?.zoom}`,
    );
  }

  async function testPinClickDoesNotReloadMap(page) {
    report.section('Map: cinema pin popup does not trigger day-refresh rebuild');

    await page.waitForSelector('.icm-pin', { timeout: 15000 });
    report.assert('leaflet map ready before pin click', !!(await readLeafletMapState(page)));

    const sigBefore = await readPageCinemaTimeSignature(page);
    report.assert('page cinema time signature non-empty', sigBefore.length > 0, `sig=${sigBefore.slice(0, 40)}`);

    await page.evaluate(() => {
      const map = document.getElementById('icm-map')?._leaflet_map;
      if (map) map.setZoom(Math.min(18, map.getZoom() + 2));
    });
    await page.waitForTimeout(200);
    const baseline = await readLeafletMapState(page);

    const opened = await openCinemaPinPopup(page, 0);
    report.assert('first cinema popup opened', !!opened, `method=${opened}`);
    await page.waitForSelector('.leaflet-popup-content .icm-popup', { state: 'attached', timeout: 5000 });

    const popupMeta = await page.evaluate(() => {
      const popup = document.querySelector('.leaflet-popup-content .icm-popup');
      const times = Array.from(popup?.querySelectorAll('.icm-time') || [])
        .map(el => el.textContent.trim())
        .filter(t => /^\d{2}:\d{2}$/.test(t));
      const name = popup?.querySelector('.icm-popup-name')?.textContent?.trim() || '';
      const panelTimes = Array.from(document.querySelectorAll('#icm-panel .icm-time'))
        .map(el => el.textContent.trim())
        .filter(t => /^\d{2}:\d{2}$/.test(t));
      return { name, times, panelTimes: panelTimes.length };
    });
    report.assert('popup shows cinema name', popupMeta.name.length > 0, `name=${popupMeta.name}`);
    report.assert(
      'popup injects HH:MM session times into panel',
      popupMeta.times.length > 0 && popupMeta.panelTimes > 0,
      `popupTimes=${popupMeta.times.length} panelTimes=${popupMeta.panelTimes}`,
    );

    await page.waitForTimeout(1500);

    const afterOpen = await page.evaluate(() => {
      const loading = document.getElementById('icm-loading');
      const loadingShown = !!(loading
        && loading.style.display !== 'none'
        && !loading.classList.contains('icm-hidden'));
      return {
        loadingShown,
        popupOpen: !!document.querySelector('.leaflet-popup-content .icm-popup'),
      };
    });
    const sigAfterOpen = await readPageCinemaTimeSignature(page);
    report.assert(
      'page time signature unchanged with popup open',
      sigAfterOpen === sigBefore,
      `beforeLen=${sigBefore.length} afterLen=${sigAfterOpen.length}`,
    );
    report.assert('loading UI not shown after pin open', afterOpen.loadingShown === false);
    await assertMapStable(page, baseline, 'after first pin');
    report.assert('first popup still open after debounce', afterOpen.popupOpen === true);

    report.section('Map: switching to another cinema pin keeps map stable');
    const pinCount = await page.locator('.icm-pin').count();
    if (pinCount < 2) {
      report.assert('at least two cinema pins for switch test', false, `pins=${pinCount}`);
    } else {
      const openedSecond = await openCinemaPinPopup(page, 1);
      report.assert('second cinema popup opened', !!openedSecond, `method=${openedSecond}`);
      await page.waitForSelector('.leaflet-popup-content .icm-popup', { state: 'attached', timeout: 5000 });
      await page.waitForTimeout(1500);
      await assertMapStable(page, baseline, 'after second pin');
      report.assert(
        'page time signature unchanged after second pin',
        (await readPageCinemaTimeSignature(page)) === sigBefore,
      );
    }

    report.section('Map: closing cinema popup keeps map stable');
    await closeOpenMapPopup(page);
    await page.waitForTimeout(1500);
    await assertMapStable(page, baseline, 'after popup close');
    report.assert(
      'page time signature unchanged after popup close',
      (await readPageCinemaTimeSignature(page)) === sigBefore,
    );

    report.section('Map: sort still works after pin popup interactions');
    await clickSort(page, 'dist-desc');
    const descOrder = await readCinemaSortOrder(page);
    const descKm = descOrder.map(o => o.km).filter(km => km != null);
    report.assert('sort after pin popup still applies', descKm.length >= 2, `count=${descKm.length}`);
    report.assert('sort after pin popup is descending', isSortedDesc(descKm), descKm.slice(0, 5).join(', '));
    await clickSort(page, 'dist-asc');
  }

  async function testGroupFriends(page) {
    report.section('Group: friend via Google Maps URL (mocked short link)');
    await openGroupModal(page);
    await addGroupFriend(page, groupCinuspInput(), {
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
      null,
      { timeout: 10000 },
    );

    const friendMarkers = await page.locator('.icm-friend-marker').count();
    report.assert('friend markers on map', friendMarkers >= 3, `markers=${friendMarkers}`);
  }

  await waitForPanel(page);
  await waitForInitialLoad(page);

  await testBackgroundShortLink(resolveViaBackground);
  await testPersonalShortLink(page);
  await testPinClickDoesNotReloadMap(page);
  await testSortControls(page);
  await testGroupFriends(page);

  return report.summary();
}
