(function () {
  'use strict';

  if (window.__icmLoaded) return;
  window.__icmLoaded = true;

  if (!location.pathname.startsWith('/filme/')) return;

  // ── Constants ──────────────────────────────────────────────────────────
  const THEATERS_API = 'https://api-content.ingresso.com/v0/theaters/city';
  const NOMINATIM_API = 'https://nominatim.openstreetmap.org/search';
  const NOMINATIM_DELAY = 1100;

  const TIME_RE = /^\d{2}:\d{2}$/;
  const SESSION_TYPES = ['VIP', 'LASER', 'DUBLADO', 'LEGENDADO', 'NORMAL'];
  const UI_NOISE = ['Assentos', 'Preços', 'Detalhes', 'Lembre-me', 'Compartilhar', 'Favoritar'];

  // ── Module state ───────────────────────────────────────────────────────
  let leafletMap = null;
  let cinemaMarkers = [];
  let userMarker = null;
  let cachedCinemas = null;
  let cachedUserCoords = null;
  let currentSort = 'dist-asc';
  let cinemaContainer = null;
  let refreshVersion = 0;

  const geocodeCache = new Map(); // cinemaName → { lat, lng }

  // ── Utilities ──────────────────────────────────────────────────────────

  function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  function normalizeName(name) {
    return name.toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ── DOM scraping ───────────────────────────────────────────────────────

  function getDirectText(el) {
    return Array.from(el.childNodes)
      .filter(n => n.nodeType === Node.TEXT_NODE)
      .map(n => n.textContent.trim()).filter(Boolean).join(' ');
  }

  function cleanText(text) {
    let s = text;
    for (const noise of UI_NOISE) s = s.replace(new RegExp(noise, 'gi'), '');
    return s.replace(/\s+/g, ' ').trim();
  }

  function hasTimeDescendant(el) {
    return Array.from(el.querySelectorAll('*')).some(
      c => TIME_RE.test(c.textContent.trim()) && c.children.length === 0
    );
  }

  function findCardAncestor(el) {
    let node = el.parentElement;
    while (node && node !== document.body) {
      if (node.textContent.includes('|') && hasTimeDescendant(node)) {
        const n = node.children.length;
        if (n > 0 && n < 30) return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function extractName(card) {
    for (const tag of ['h2', 'h3', 'h4', 'h1']) {
      const el = card.querySelector(tag);
      if (el) {
        const d = getDirectText(el);
        if (d.length > 3) return d;
        const c = cleanText(el.textContent.trim());
        if (c.length > 3) return c;
      }
    }
    for (const hint of ['title', 'name', 'cinema', 'theater']) {
      const el = card.querySelector(`[class*="${hint}" i]`);
      if (el) { const d = getDirectText(el); if (d.length > 3) return d; }
    }
    for (const child of card.children) {
      const t = cleanText(child.textContent.trim());
      if (t.length > 3 && !t.includes('|') && !TIME_RE.test(t)) return t;
    }
    return null;
  }

  function extractAddress(card) {
    const all = Array.from(card.querySelectorAll('*'));
    for (const el of all) {
      const d = getDirectText(el);
      if (d.includes('|') && d.length > 5 && d.length < 200) return d;
    }
    for (const el of all) {
      if (!el.textContent.includes('|')) continue;
      const c = cleanText(el.textContent.trim());
      if (c.includes('|') && c.length > 5 && c.length < 200) {
        const m = c.match(/^(.+?\|[^|]+?)(?:\s{2,}|$)/);
        return m ? m[1].trim() : c;
      }
    }
    return '';
  }

  function extractSessions(card) {
    const allEls = Array.from(card.querySelectorAll('*'));
    const timeEls = allEls.filter(el => TIME_RE.test(el.textContent.trim()) && el.children.length === 0);
    if (timeEls.length === 0) return [];
    const badgeEls = allEls.filter(
      el => SESSION_TYPES.includes(el.textContent.trim().toUpperCase()) && el.children.length === 0
    );
    if (badgeEls.length === 0) {
      return [{ type: 'NORMAL', times: timeEls.map(el => el.textContent.trim()) }];
    }

    const groups = [], usedTimes = new Set();
    badgeEls.forEach(badge => {
      const bp = badge.parentElement;
      if (!bp) return;
      const siblings = [bp, ...Array.from(bp.parentElement?.children || [])];
      const rowTimes = timeEls.filter(t => siblings.some(s => s.contains(t)) && !usedTimes.has(t));
      if (rowTimes.length > 0) {
        const type = badge.textContent.trim().toUpperCase();
        const ex = groups.find(g => g.type === type);
        if (ex) {
          rowTimes.forEach(t => { ex.times.push(t.textContent.trim()); usedTimes.add(t); });
        } else {
          groups.push({ type, times: rowTimes.map(t => t.textContent.trim()) });
          rowTimes.forEach(t => usedTimes.add(t));
        }
      }
    });
    const rem = timeEls.filter(t => !usedTimes.has(t)).map(t => t.textContent.trim());
    if (rem.length > 0) {
      if (groups[0]) groups[0].times.push(...rem);
      else groups.push({ type: 'NORMAL', times: rem });
    }
    return groups.filter(g => g.times.length > 0);
  }

  function scrapeCinemas() {
    const allEls = Array.from(document.body.querySelectorAll('*'));
    const timeLeaves = allEls.filter(el => TIME_RE.test(el.textContent.trim()) && el.children.length === 0);
    if (timeLeaves.length === 0) throw new Error('Nenhuma sessão encontrada. A página carregou completamente?');

    const cardSet = new Set(), cardMap = new Map();
    for (const te of timeLeaves) {
      const card = findCardAncestor(te);
      if (card && !cardSet.has(card)) {
        cardSet.add(card);
        const name = extractName(card);
        const address = extractAddress(card);
        if (name) cardMap.set(card, { name, address, sessions: [] });
      }
    }
    if (cardMap.size === 0) throw new Error('Não foi possível identificar os cinemas na página.');

    const result = [];
    for (const [card, cinema] of cardMap) {
      cinema.sessions = extractSessions(card);
      result.push(cinema);
    }
    return result;
  }

  function getCinemaSignature() {
    return Array.from(document.body.querySelectorAll('*'))
      .filter(el => TIME_RE.test(el.textContent.trim()) && el.children.length === 0)
      .map(el => el.textContent.trim())
      .sort().join(',');
  }

  // ── Find card elements for DOM sorting ────────────────────────────────

  // Returns { name, card (inner cinema card), element (direct child of cinemaContainer) }
  function findCinemaCardElements() {
    if (!cinemaContainer) return [];

    const allEls = Array.from(document.body.querySelectorAll('*'));
    const timeLeaves = allEls.filter(
      el => TIME_RE.test(el.textContent.trim()) && el.children.length === 0
    );

    const cardSet = new Set(), entries = [];
    for (const te of timeLeaves) {
      const card = findCardAncestor(te);
      if (!card || cardSet.has(card)) continue;
      cardSet.add(card);

      const name = extractName(card);
      if (!name) continue;

      // Walk up to find the direct child of cinemaContainer
      let node = card;
      while (node && node.parentElement !== cinemaContainer) node = node.parentElement;
      if (node && node.parentElement === cinemaContainer) {
        entries.push({ name, card, element: node });
      }
    }
    return entries;
  }

  // ── Sort the page's own cinema cards ──────────────────────────────────

  function sortPageCinemas(sortedCinemas) {
    // Refresh container reference in case React replaced it
    if (!cinemaContainer || !document.body.contains(cinemaContainer)) {
      cinemaContainer = findCinemaListContainer();
    }
    if (!cinemaContainer) return;

    const cardEls = findCinemaCardElements();
    if (cardEls.length === 0) return;

    // Remove existing distance badges
    document.querySelectorAll('[data-icm-dist]').forEach(el => el.remove());

    // Reorder: appendChild moves the child to end, building sorted order
    sortedCinemas.forEach((cinema, idx) => {
      const entry = cardEls.find(c => normalizeName(c.name) === normalizeName(cinema.name));
      if (!entry) return;

      cinemaContainer.appendChild(entry.element);

      // Inject distance badge at top of card
      const badge = document.createElement('div');
      badge.setAttribute('data-icm-dist', '1');
      badge.style.cssText = [
        'display:flex', 'align-items:center', 'gap:8px',
        'padding:6px 12px 2px', 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        'font-size:12px', 'line-height:1'
      ].join(';');

      const numColor = cinema.lat ? '#3255e2' : '#4b5563';
      const distLabel = cinema.distance != null
        ? `<span style="color:#98aaec;font-weight:600;">${cinema.distance.toFixed(1)} km</span>`
        : `<span style="color:rgba(240,240,240,0.4);">distância desconhecida</span>`;

      badge.innerHTML = `
        <span style="background:${numColor};color:#fff;min-width:20px;height:20px;border-radius:50%;
          display:inline-flex;align-items:center;justify-content:center;
          font-size:11px;font-weight:700;flex-shrink:0;">${idx + 1}</span>
        ${distLabel}`;

      entry.card.insertAdjacentElement('afterbegin', badge);
    });
  }

  // ── Map markers ────────────────────────────────────────────────────────

  function sessionBadgesHtml(sessions) {
    return sessions.map(s => {
      const type = s.type.toLowerCase();
      const times = s.times.map(t => `<span class="icm-time">${t}</span>`).join(' ');
      return `<span class="icm-badge icm-badge-${type}">${s.type}</span>${times}`;
    }).join('');
  }

  function onUserMarkerDragged() {
    if (!cachedCinemas || !userMarker) return;
    const latlng = userMarker.getLatLng();
    cachedUserCoords = { lat: latlng.lat, lng: latlng.lng };

    const withDist = cachedCinemas.map(c => ({
      ...c,
      distance: c.lat !== null ? haversine(cachedUserCoords.lat, cachedUserCoords.lng, c.lat, c.lng) : null
    }));
    const sorted = sortCinemas(withDist);

    // Update markers in-place — no map teardown
    sorted.forEach((cinema, idx) => {
      const entry = cinemaMarkers.find(m => m.name === cinema.name);
      if (!entry) return;
      entry.marker.setIcon(L.divIcon({
        className: '',
        html: `<div class="icm-pin"><span class="icm-pin-n">${idx + 1}</span></div>`,
        iconSize: [26, 26], iconAnchor: [13, 26]
      }));
      const distText = cinema.distance != null ? `${cinema.distance.toFixed(1)} km` : '';
      entry.marker.setPopupContent(
        `<div class="icm-popup">
          <div class="icm-popup-name">${cinema.name}</div>
          ${distText ? `<div class="icm-popup-dist">${distText}</div>` : ''}
          <div class="icm-popup-addr">${cinema.address || ''}</div>
          <div class="icm-popup-sessions">${sessionBadgesHtml(cinema.sessions)}</div>
        </div>`);
    });

    sortPageCinemas(sorted);
  }

  function renderMap(cinemas, userCoords) {
    const mapEl = document.getElementById('icm-map');
    if (!mapEl) return;

    if (leafletMap) { leafletMap.remove(); leafletMap = null; }
    cinemaMarkers = [];

    leafletMap = L.map(mapEl, { zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19
    }).addTo(leafletMap);

    const userIcon = L.divIcon({
      className: '',
      html: '<div class="icm-user-dot-wrapper"><div class="icm-user-dot"></div></div>',
      iconSize: [16, 16], iconAnchor: [8, 8]
    });
    userMarker = L.marker([userCoords.lat, userCoords.lng], { icon: userIcon, draggable: true })
      .addTo(leafletMap)
      .bindPopup(
        `<strong>Você está aqui</strong><br><span style="font-size:11px;color:rgba(240,240,240,0.5)">Arraste para mover</span>`
      );
    userMarker.on('dragend', onUserMarkerDragged);

    const validCoords = [[userCoords.lat, userCoords.lng]];
    cinemas.forEach((cinema, idx) => {
      if (cinema.lat === null) return;
      const icon = L.divIcon({
        className: '',
        html: `<div class="icm-pin"><span class="icm-pin-n">${idx + 1}</span></div>`,
        iconSize: [26, 26], iconAnchor: [13, 26]
      });
      const distText = cinema.distance != null ? `${cinema.distance.toFixed(1)} km` : '';
      const popup = `
        <div class="icm-popup">
          <div class="icm-popup-name">${cinema.name}</div>
          ${distText ? `<div class="icm-popup-dist">${distText}</div>` : ''}
          <div class="icm-popup-addr">${cinema.address || ''}</div>
          <div class="icm-popup-sessions">${sessionBadgesHtml(cinema.sessions)}</div>
        </div>`;
      const marker = L.marker([cinema.lat, cinema.lng], { icon })
        .addTo(leafletMap).bindPopup(popup, { maxWidth: 280 });
      cinemaMarkers.push({ marker, name: cinema.name });
      validCoords.push([cinema.lat, cinema.lng]);
    });

    if (validCoords.length > 1) {
      leafletMap.fitBounds(L.latLngBounds(validCoords), { padding: [30, 30] });
    } else {
      leafletMap.setView([userCoords.lat, userCoords.lng], 13);
    }
  }

  // ── Geolocation ────────────────────────────────────────────────────────

  function getLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject('Geolocalização não disponível.');
      navigator.geolocation.getCurrentPosition(
        pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        err => reject(
          err.code === err.PERMISSION_DENIED ? 'Permissão de localização negada.'
          : err.code === err.TIMEOUT ? 'Tempo limite ao obter localização.'
          : 'Não foi possível obter sua localização.'
        ),
        { timeout: 10000, maximumAge: 300000 }
      );
    });
  }

  // ── API ────────────────────────────────────────────────────────────────

  async function fetchTheaters(cityId = 1) {
    const res = await fetch(`${THEATERS_API}/${cityId}?partnership=encora`);
    if (!res.ok) throw new Error(`Theater API ${res.status}`);
    return res.json();
  }

  async function geocodeAddress(address) {
    const q = address.replace('|', ',').trim() + ', Brasil';
    const params = new URLSearchParams({ q, format: 'json', limit: '1', countrycodes: 'br' });
    const res = await fetch(`${NOMINATIM_API}?${params}`, {
      headers: { 'User-Agent': 'IngressoCinemaMap/2.0' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.length ? { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) } : null;
  }

  async function geocodeManualInput(query) {
    const params = new URLSearchParams({ q: query, format: 'json', limit: '1', countrycodes: 'br' });
    const res = await fetch(`${NOMINATIM_API}?${params}`, {
      headers: { 'User-Agent': 'IngressoCinemaMap/2.0' }
    });
    if (!res.ok) throw new Error('Serviço de geocodificação indisponível.');
    const data = await res.json();
    if (!data.length) throw new Error('Endereço não encontrado. Tente ser mais específico.');
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), label: data[0].display_name };
  }

  // ── Match & geocode (cache-aware) ──────────────────────────────────────

  async function matchAndGeocode(domCinemas, apiTheaters, onProgress) {
    const apiMap = new Map();
    for (const t of apiTheaters) apiMap.set(normalizeName(t.name), t);

    const result = [], needGeocode = [];

    for (const cinema of domCinemas) {
      if (geocodeCache.has(cinema.name)) {
        result.push({ ...cinema, ...geocodeCache.get(cinema.name) });
        continue;
      }
      const theater = apiMap.get(normalizeName(cinema.name));
      if (theater?.geolocation?.lat && theater.geolocation.lat !== 0 && theater.geolocation.lng !== 0) {
        const coords = { lat: theater.geolocation.lat, lng: theater.geolocation.lng };
        geocodeCache.set(cinema.name, coords);
        result.push({ ...cinema, ...coords });
      } else {
        result.push({ ...cinema, lat: null, lng: null });
        needGeocode.push(result[result.length - 1]);
      }
    }

    for (let i = 0; i < needGeocode.length; i++) {
      const cinema = needGeocode[i];
      if (onProgress) onProgress(i + 1, needGeocode.length);
      try {
        const coords = await geocodeAddress(cinema.address);
        if (coords) { cinema.lat = coords.lat; cinema.lng = coords.lng; geocodeCache.set(cinema.name, coords); }
      } catch (_) {}
      if (i < needGeocode.length - 1) await delay(NOMINATIM_DELAY);
    }

    return result;
  }

  // ── Sort ───────────────────────────────────────────────────────────────

  function sortCinemas(cinemas) {
    const sorted = [...cinemas];
    if (currentSort === 'dist-asc') {
      sorted.sort((a, b) => {
        if (a.distance == null && b.distance == null) return 0;
        if (a.distance == null) return 1; if (b.distance == null) return -1;
        return a.distance - b.distance;
      });
    } else if (currentSort === 'dist-desc') {
      sorted.sort((a, b) => {
        if (a.distance == null && b.distance == null) return 0;
        if (a.distance == null) return 1; if (b.distance == null) return -1;
        return b.distance - a.distance;
      });
    } else {
      sorted.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    }
    return sorted;
  }

  // ── State machine ──────────────────────────────────────────────────────

  const ALL_STATES = ['icm-loading', 'icm-error', 'icm-manual', 'icm-map-section'];

  function setState(id) {
    ALL_STATES.forEach(s => {
      const el = document.getElementById(s);
      if (!el) return;
      if (s === id) el.style.removeProperty('display');
      else el.style.setProperty('display', 'none', 'important');
    });
  }

  function setLoading(msg, showManualLink = false) {
    setState('icm-loading');
    const el = document.getElementById('icm-loading-msg');
    if (el) el.textContent = msg;
    const link = document.getElementById('icm-btn-manual-loading');
    if (link) link.classList.toggle('icm-hidden', !showManualLink);
  }

  function setError(msg) {
    setState('icm-error');
    const el = document.getElementById('icm-error-msg');
    if (el) el.textContent = msg;
  }

  function showManualInput() {
    const inp = document.getElementById('icm-manual-input');
    const err = document.getElementById('icm-manual-error');
    if (inp) inp.value = '';
    if (err) { err.textContent = ''; err.classList.add('icm-hidden'); }
    setState('icm-manual');
    setTimeout(() => inp?.focus(), 50);
  }

  // ── Sticky toolbar (JS-based, works despite overflow:hidden ancestors) ──

  function setupStickyToolbar() {
    const toolbar = document.getElementById('icm-toolbar');
    const panel = document.getElementById('icm-panel');
    if (!toolbar) return;

    // Detect ingresso.com's fixed/sticky header height
    let navHeight = 0;
    for (const el of document.querySelectorAll('*')) {
      if (panel && panel.contains(el)) continue;
      const style = getComputedStyle(el);
      if (style.position !== 'fixed' && style.position !== 'sticky') continue;
      const rect = el.getBoundingClientRect();
      if (rect.top <= 2 && rect.height > 10 && rect.width > 100) {
        navHeight = Math.max(navHeight, rect.bottom);
      }
    }

    // Sentinel preserves toolbar's height in flow when toolbar goes fixed
    const sentinel = document.createElement('div');
    let isFixed = false;

    function fix() {
      if (isFixed) return;
      isFixed = true;
      const rect = toolbar.getBoundingClientRect();
      sentinel.style.cssText = `height:${toolbar.offsetHeight}px;flex-shrink:0;`;
      toolbar.after(sentinel);
      toolbar.style.setProperty('position', 'fixed', 'important');
      toolbar.style.setProperty('top', navHeight + 'px', 'important');
      toolbar.style.setProperty('left', rect.left + 'px', 'important');
      toolbar.style.setProperty('width', toolbar.offsetWidth + 'px', 'important');
      toolbar.style.setProperty('z-index', '10000', 'important');
    }

    function unfix() {
      if (!isFixed) return;
      isFixed = false;
      sentinel.remove();
      ['position', 'top', 'left', 'width', 'z-index'].forEach(p => toolbar.style.removeProperty(p));
    }

    function update() {
      const mapSection = document.getElementById('icm-map-section');
      if (!mapSection || getComputedStyle(mapSection).display === 'none') { unfix(); return; }
      const measureRect = (isFixed ? sentinel : toolbar).getBoundingClientRect();
      measureRect.top < navHeight ? fix() : unfix();
    }

    function onResize() {
      if (!isFixed) return;
      unfix();
      update();
    }

    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
  }

  // ── Render with location ───────────────────────────────────────────────

  function renderWithLocation(userCoords) {
    if (!cachedCinemas) return;
    cachedUserCoords = userCoords;

    const withDist = cachedCinemas.map(c => ({
      ...c,
      distance: c.lat !== null ? haversine(userCoords.lat, userCoords.lng, c.lat, c.lng) : null
    }));
    const sorted = sortCinemas(withDist);

    setState('icm-map-section');

    const countEl = document.getElementById('icm-count');
    if (countEl) countEl.textContent =
      `${sorted.length} cinema${sorted.length !== 1 ? 's' : ''}`;

    setTimeout(() => {
      renderMap(sorted, userCoords);
      if (leafletMap) leafletMap.invalidateSize();
      sortPageCinemas(sorted);
    }, 50);
  }

  function reSort() {
    if (!cachedCinemas || !cachedUserCoords) return;
    const withDist = cachedCinemas.map(c => ({
      ...c,
      distance: c.lat !== null ? haversine(cachedUserCoords.lat, cachedUserCoords.lng, c.lat, c.lng) : null
    }));
    const sorted = sortCinemas(withDist);
    renderMap(sorted, cachedUserCoords);
    if (leafletMap) leafletMap.invalidateSize();
    sortPageCinemas(sorted);
  }

  // ── Manual location ────────────────────────────────────────────────────

  async function submitManualLocation() {
    const inp = document.getElementById('icm-manual-input');
    const errEl = document.getElementById('icm-manual-error');
    const btn = document.getElementById('icm-btn-manual-go');
    const query = inp?.value.trim();
    if (!query) return;
    if (errEl) errEl.classList.add('icm-hidden');
    if (btn) { btn.disabled = true; btn.textContent = 'Buscando...'; }
    try {
      const coords = await geocodeManualInput(query);
      const shortLabel = coords.label.split(',').slice(0, 2).join(',').trim();
      renderWithLocation({ ...coords, label: shortLabel });
    } catch (e) {
      if (errEl) { errEl.textContent = e.message; errEl.classList.remove('icm-hidden'); }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Buscar'; }
    }
  }

  // ── Auto location ──────────────────────────────────────────────────────

  async function runAutoLocation() {
    const manualTimer = setTimeout(() => {
      document.getElementById('icm-btn-manual-loading')?.classList.remove('icm-hidden');
    }, 5000);
    setLoading('Obtendo localização...');
    try {
      const userCoords = await getLocation();
      clearTimeout(manualTimer);
      renderWithLocation(userCoords);
    } catch (e) {
      clearTimeout(manualTimer);
      setError(typeof e === 'string' ? e : (e.message || 'Erro ao obter localização.'));
    }
  }

  // ── Refresh on day-tab change ──────────────────────────────────────────

  async function refreshCinemas() {
    const version = ++refreshVersion;

    let domCinemas;
    try { domCinemas = scrapeCinemas(); } catch (_) { return; }

    // Re-find container in case React replaced it during the day change
    const fresh = findCinemaListContainer();
    if (fresh) cinemaContainer = fresh;

    let apiTheaters = [];
    try { apiTheaters = await fetchTheaters(1); } catch (_) {}

    // Abort if a newer refresh was started while we were awaiting
    if (version !== refreshVersion) return;

    cachedCinemas = await matchAndGeocode(domCinemas, apiTheaters, (i, total) => {
      setLoading(`Geocodificando ${i} de ${total} cinemas...`);
    });

    if (version !== refreshVersion) return;
    if (cachedUserCoords) renderWithLocation(cachedUserCoords);
  }

  function watchForDayChanges() {
    let debounce = null;
    let lastSig = getCinemaSignature();

    new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (!cachedUserCoords) return;
        const sig = getCinemaSignature();
        if (sig === lastSig || sig === '') return;
        lastSig = sig;
        refreshCinemas();
      }, 800);
    }).observe(document.body, { childList: true, subtree: true });
  }

  // ── Main data load ─────────────────────────────────────────────────────

  async function loadData() {
    setLoading('Buscando sessões na página...');
    let domCinemas;
    try { domCinemas = scrapeCinemas(); }
    catch (e) { setError(e.message); return; }

    setLoading('Buscando coordenadas dos cinemas...');
    let apiTheaters = [];
    try { apiTheaters = await fetchTheaters(1); } catch (_) {}

    cachedCinemas = await matchAndGeocode(domCinemas, apiTheaters, (i, total) => {
      setLoading(`Geocodificando ${i} de ${total} cinemas...`);
    });

    await runAutoLocation();
  }

  // ── Wait / find helpers ────────────────────────────────────────────────

  function waitForTimeElements() {
    return new Promise(resolve => {
      const hasTime = () => Array.from(document.body.querySelectorAll('*')).some(
        el => TIME_RE.test(el.textContent.trim()) && el.children.length === 0
      );
      if (hasTime()) return resolve();
      const obs = new MutationObserver(() => {
        if (hasTime()) { obs.disconnect(); resolve(); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(); }, 10000);
    });
  }

  function findCinemaListContainer() {
    const allEls = Array.from(document.body.querySelectorAll('*'));
    const timeLeaves = allEls.filter(
      el => TIME_RE.test(el.textContent.trim()) && el.children.length === 0
    );
    if (timeLeaves.length === 0) return null;
    let node = timeLeaves[0].parentElement;
    while (node && node !== document.body) {
      if (timeLeaves.every(el => node.contains(el))) return node;
      node = node.parentElement;
    }
    return null;
  }

  // ── Build panel ────────────────────────────────────────────────────────

  function buildPanel() {
    const title = document.title.split(' - ')[0] || 'Cinema Map';

    const panel = document.createElement('div');
    panel.id = 'icm-panel';
    panel.innerHTML = `
      <div id="icm-header">
        <span id="icm-title">🎬 ${title} — Cinemas no Mapa</span>
      </div>
      <div id="icm-loading">
        <div class="icm-spinner"></div>
        <p id="icm-loading-msg">Aguardando sessões carregarem...</p>
        <button id="icm-btn-manual-loading" class="icm-btn-link icm-hidden">Inserir localização manualmente</button>
      </div>
      <div id="icm-error">
        <p class="icm-state-icon">⚠️</p>
        <p id="icm-error-msg"></p>
        <button id="icm-btn-retry" class="icm-btn-primary">Tentar novamente</button>
        <button id="icm-btn-manual-err" class="icm-btn-link">Inserir localização manualmente</button>
      </div>
      <div id="icm-manual">
        <p class="icm-state-icon">📍</p>
        <p class="icm-manual-label">Digite seu endereço ou bairro</p>
        <div class="icm-manual-row">
          <input id="icm-manual-input" type="text" placeholder="Ex: Av. Paulista, São Paulo" autocomplete="off">
          <button id="icm-btn-manual-go" class="icm-btn-primary">Buscar</button>
        </div>
        <p id="icm-manual-error" class="icm-hidden"></p>
        <button id="icm-btn-use-auto" class="icm-btn-link">Usar localização automática</button>
      </div>
      <div id="icm-map-section">
        <div id="icm-map"></div>
        <div id="icm-toolbar">
          <span id="icm-count"></span>
          <div id="icm-sort-bar">
            <span class="icm-sort-label">Ordenar:</span>
            <button class="icm-chip icm-chip-active" data-sort="dist-asc">Mais próximo</button>
            <button class="icm-chip" data-sort="dist-desc">Mais distante</button>
            <button class="icm-chip" data-sort="name">A–Z</button>
          </div>
          <button id="icm-btn-change-loc" class="icm-btn-small">Inserir endereço</button>
        </div>
      </div>`;

    panel.querySelector('#icm-btn-retry').addEventListener('click', () => {
      cachedCinemas = null;
      loadData();
    });
    panel.querySelector('#icm-btn-manual-err').addEventListener('click', showManualInput);
    panel.querySelector('#icm-btn-manual-loading').addEventListener('click', showManualInput);
    panel.querySelector('#icm-btn-use-auto').addEventListener('click', runAutoLocation);
    panel.querySelector('#icm-btn-change-loc').addEventListener('click', showManualInput);
    panel.querySelector('#icm-btn-manual-go').addEventListener('click', submitManualLocation);
    panel.querySelector('#icm-manual-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') submitManualLocation();
    });
    panel.querySelectorAll('.icm-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        panel.querySelectorAll('.icm-chip').forEach(c => c.classList.remove('icm-chip-active'));
        chip.classList.add('icm-chip-active');
        currentSort = chip.dataset.sort;
        reSort();
      });
    });

    return panel;
  }

  // ── Init ───────────────────────────────────────────────────────────────

  async function init() {
    const panel = buildPanel();
    document.body.insertAdjacentElement('afterbegin', panel);

    ['icm-error', 'icm-manual', 'icm-map-section'].forEach(id => {
      document.getElementById(id)?.style.setProperty('display', 'none', 'important');
    });

    setLoading('Aguardando sessões carregarem...');
    await waitForTimeElements();

    cinemaContainer = findCinemaListContainer();
    if (cinemaContainer && cinemaContainer.parentElement && !cinemaContainer.parentElement.contains(panel)) {
      cinemaContainer.before(panel);
    }

    setupStickyToolbar();
    await loadData();

    watchForDayChanges();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
