(function () {
  'use strict';

  if (window.__icmLoaded) return;
  window.__icmLoaded = true;

  if (!location.pathname.startsWith('/filme/')) return;

  // ── Constants ──────────────────────────────────────────────────────────
  const THEATERS_API = 'https://api-content.ingresso.com/v0/theaters/city';
  const CITY_API = 'https://api-content.ingresso.com/v0/states/city/name';
  const NOMINATIM_API = 'https://nominatim.openstreetmap.org/search';
  const NOMINATIM_DELAY = 1100;

  const DEFAULT_CITY = {
    id: '1',
    name: 'São Paulo',
    uf: 'SP',
    state: 'São Paulo',
    urlKey: 'sao-paulo'
  };

  const TIME_RE = /^\d{2}:\d{2}$/;
  const SESSION_TYPES = ['VIP', 'LASER', 'DUBLADO', 'LEGENDADO', 'NORMAL'];
  const UI_NOISE = ['Assentos', 'Preços', 'Detalhes', 'Lembre-me', 'Compartilhar', 'Favoritar'];

  // ── Module state ───────────────────────────────────────────────────────
  let leafletMap = null;
  let cinemaMarkers = [];
  let userMarker = null;
  let previewMarker = null;
  let previewLabel = '';
  let locationPreviewActive = false;
  let previewContext = null; // null | 'user' | 'group' | 'group-pin'
  let groupPreviewQuery = '';
  let groupPinDropHandler = null;
  let cachedCinemas = null;
  let cachedUserCoords = null;
  let currentSort = 'dist-asc';
  let cinemaContainer = null;
  let refreshVersion = 0;
  let pageCity = null;
  let pageCityKey = null;

  const geocodeCache = new Map(); // cinemaName → { lat, lng }

  let groupMode = false;
  let friendLocations = []; // { lat, lng, label, marker }
  let currentGroupMode = 'centroid'; // 'centroid' | 'per-friend'
  let friendMarkers = [];

  const FRIEND_COLORS = ['#ec4899', '#06b6d4', '#22c55e', '#f97316', '#a855f7', '#14b8a6', '#f43f5e'];

  function getFriendColor(idx) {
    return FRIEND_COLORS[idx % FRIEND_COLORS.length];
  }

  function findClosestCinemaPerFriend(cinemas, friends) {
    const byCinema = new Map();
    friends.forEach((friend, friendIdx) => {
      let best = null;
      let bestDist = Infinity;
      for (const cinema of cinemas) {
        if (cinema.lat == null) continue;
        const d = haversine(friend.lat, friend.lng, cinema.lat, cinema.lng);
        if (d < bestDist) {
          bestDist = d;
          best = cinema;
        }
      }
      if (!best) return;
      const key = best.name;
      if (!byCinema.has(key)) byCinema.set(key, []);
      byCinema.get(key).push(friendIdx);
    });
    return byCinema;
  }

  function friendPinStyle(friendIndices) {
    const colors = friendIndices.map(getFriendColor);
    if (colors.length === 1) {
      const c = colors[0];
      return `background:${c};box-shadow:0 0 12px ${c}99,0 2px 8px rgba(0,0,0,0.45)`;
    }
    const slice = 100 / colors.length;
    const stops = colors.map((c, i) => `${c} ${i * slice}% ${(i + 1) * slice}%`).join(', ');
    return `background:conic-gradient(${stops});box-shadow:0 0 12px rgba(255,255,255,0.35),0 2px 8px rgba(0,0,0,0.45)`;
  }

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

  // Leaflet popups inject HH:MM session times into #icm-panel. Those must not
  // be treated as page cinema sessions (would trigger day-change refresh / map rebuild).
  function isExtensionDom(el) {
    return !!(el && typeof el.closest === 'function' && el.closest('#icm-panel'));
  }

  function getPageTimeLeaves() {
    return Array.from(document.body.querySelectorAll('*')).filter(
      el => !isExtensionDom(el)
        && TIME_RE.test(el.textContent.trim())
        && el.children.length === 0
    );
  }

  // ── Page city (from ingresso.com selector) ─────────────────────────────

  function readCookie(name) {
    const escaped = name.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1');
    const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function readSiteCityCookie() {
    const raw = readCookie('SiteCity');
    if (!raw) return null;
    try {
      const c = JSON.parse(raw);
      return {
        id: String(c.Id ?? c.id ?? ''),
        name: c.Name ?? c.name,
        uf: c.UF ?? c.uf,
        urlKey: c.UrlKey ?? c.urlKey,
        state: c.State ?? c.state
      };
    } catch {
      return null;
    }
  }

  function readCityHistoryLatest() {
    try {
      const hist = JSON.parse(localStorage.getItem('cityHistory') || '[]');
      if (!Array.isArray(hist) || !hist.length) return null;
      const c = hist[hist.length - 1];
      return {
        id: String(c.id),
        name: c.name,
        uf: c.uf,
        urlKey: c.urlKey,
        state: c.state
      };
    } catch {
      return null;
    }
  }

  function getCityLookupKey() {
    const urlKey = new URLSearchParams(location.search).get('city');
    if (urlKey) return urlKey;
    const cookie = readSiteCityCookie();
    if (cookie?.urlKey) return cookie.urlKey;
    const hist = readCityHistoryLatest();
    if (hist?.urlKey) return hist.urlKey;
    return DEFAULT_CITY.urlKey;
  }

  async function fetchCityByUrlKey(urlKey) {
    const res = await fetch(`${CITY_API}/${encodeURIComponent(urlKey)}`);
    if (!res.ok) return null;
    const c = await res.json();
    return {
      id: String(c.id),
      name: c.name,
      uf: c.uf,
      urlKey: c.urlKey,
      state: c.state
    };
  }

  async function resolvePageCity() {
    const key = getCityLookupKey();
    if (pageCity && pageCityKey === key) return pageCity;

    const cookie = readSiteCityCookie();
    if (cookie?.urlKey === key && cookie.name && cookie.uf && cookie.id) {
      pageCity = cookie;
      pageCityKey = key;
      return pageCity;
    }

    const hist = readCityHistoryLatest();
    if (hist?.urlKey === key && hist.name && hist.uf && hist.id) {
      pageCity = hist;
      pageCityKey = key;
      return pageCity;
    }

    pageCity = (await fetchCityByUrlKey(key)) || DEFAULT_CITY;
    pageCityKey = key;
    return pageCity;
  }

  function buildGeocodeQuery(query) {
    const city = pageCity || DEFAULT_CITY;
    const formatted = formatGoogleAddressForGeocode(query);
    if (formatted.city && formatted.uf) return formatted.query;

    const trimmed = query.trim();
    const normalized = normalizeName(trimmed);
    const cityNorm = normalizeName(city.name);
    const ufNorm = normalizeName(city.uf);
    if (normalized.includes(cityNorm) && normalized.includes(ufNorm)) {
      return `${trimmed}, Brasil`;
    }
    return `${trimmed}, ${city.name}, ${city.uf}, Brasil`;
  }

  function expandStreetAbbreviations(text) {
    return String(text)
      .replace(/\bR\.\s*/gi, 'Rua ')
      .replace(/\bAv\.\s*/gi, 'Avenida ')
      .replace(/\bAl\.\s*/gi, 'Alameda ')
      .replace(/\bTrav\.\s*/gi, 'Travessa ')
      .replace(/\bRod\.\s*/gi, 'Rodovia ')
      .replace(/\bPç\.\s*/gi, 'Praça ')
      .replace(/\bPc\.\s*/gi, 'Praça ')
      .trim();
  }

  function formatGoogleAddressForGeocode(raw) {
    const decoded = decodeMapsText(raw);
    let segments = decoded.split(',').map(s => s.trim()).filter(Boolean);
    if (!segments.length) return { query: decoded, city: null, uf: null };

    const cepRe = /^\d{5}-?\d{3}$/;
    const cityUfRe = /^(.+?)\s*-\s*([A-Z]{2})$/i;

    if (cepRe.test(segments[segments.length - 1])) segments.pop();

    let city = null;
    let uf = null;
    if (cityUfRe.test(segments[segments.length - 1] || '')) {
      const match = segments.pop().match(cityUfRe);
      city = match[1].trim();
      uf = match[2].toUpperCase();
    } else if (segments.length >= 2 && /^[A-Z]{2}$/i.test(segments[segments.length - 1])) {
      uf = segments.pop().toUpperCase();
      city = segments.pop();
    }

    let streetNumber = '';
    if (segments.length >= 2) {
      const tail = segments[segments.length - 1];
      const numMatch = tail.match(/^(\d+)\s*-\s*.+$/);
      if (numMatch) {
        streetNumber = numMatch[1];
        segments.pop();
      }
    }

    let street = expandStreetAbbreviations(segments.join(', '));
    if (streetNumber) street = `${street} ${streetNumber}`.trim();

    if (city && uf) {
      return { query: `${street}, ${city}, ${uf}, Brasil`, city, uf };
    }
    return { query: street || decoded, city: null, uf: null };
  }

  async function geocodeResolvedAddress(query) {
    const formatted = formatGoogleAddressForGeocode(query);
    const data = await nominatimSearch(formatted.query, 5);
    if (!data.length) {
      throw new Error(`Endereço não encontrado para "${query}". Tente incluir rua e número.`);
    }

    if (formatted.city) {
      const cityNorm = normalizeName(formatted.city);
      return data.find(item => normalizeName(item.display_name).includes(cityNorm)) || data[0];
    }
    return data[0];
  }

  const GOOGLE_MAPS_URL_RE =
    /^(https?:\/\/)?((www\.)?(google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)|maps\.app\.goo\.gl|goo\.gl\/maps)/i;

  const MAPS_SHORT_LINK_RE =
    /^(https?:\/\/)?(share\.google(\.com)?\/[^\s/?#]+|maps\.app\.goo\.gl\/[^\s/?#]+|goo\.gl\/maps\/[^\s/?#]+)/i;

  function decodeMapsText(text) {
    return decodeURIComponent(String(text).replace(/\+/g, ' ')).trim();
  }

  function isValidCoord(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng)
      && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  }

  const { isPlausiblyInBrazilBBox } = globalThis.IcmBrazilCoords;

  function isPlausiblyInBrazil(lat, lng) {
    return isValidCoord(lat, lng) && isPlausiblyInBrazilBBox(lat, lng);
  }

  function extractGooglePlaceCoords(href) {
    const m34 = href.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
    if (m34) {
      const lat = parseFloat(m34[1]);
      const lng = parseFloat(m34[2]);
      if (isValidCoord(lat, lng)) return { lat, lng };
    }

    const m12 = href.match(/!1d(-?\d+(?:\.\d+)?)!2d(-?\d+(?:\.\d+)?)/);
    if (m12) {
      const lng = parseFloat(m12[1]);
      const lat = parseFloat(m12[2]);
      if (isValidCoord(lat, lng)) return { lat, lng };
    }

    const m23 = href.match(/!2d(-?\d+(?:\.\d+)?)!3d(-?\d+(?:\.\d+)?)/);
    if (m23) {
      const lat = parseFloat(m23[1]);
      const lng = parseFloat(m23[2]);
      if (isValidCoord(lat, lng)) return { lat, lng };
    }

    return null;
  }

  function cleanMapsAddressLabel(raw) {
    const decoded = decodeMapsText(raw);
    const segments = decoded.split(',').map(s => s.trim()).filter(Boolean);
    if (segments.length <= 1) return decoded;
    if (/^(av\.?|r\.?|rua|al\.?|trav\.?|rod\.?|praça|pc\.?)/i.test(segments[1])) {
      return segments.slice(1).join(', ');
    }
    return decoded;
  }

  function parseGoogleMapsUrl(input) {
    const trimmed = input.trim();
    if (!GOOGLE_MAPS_URL_RE.test(trimmed)) return null;

    let url;
    try {
      url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    } catch {
      return null;
    }

    const href = url.href;
    const addressParam = extractMapsAddressParam(url);
    const addressLabel = addressParam ? cleanMapsAddressLabel(addressParam) : '';
    const placeMatch = url.pathname.match(/\/place\/([^/@?]+)/);
    const placeName = placeMatch ? decodeMapsText(placeMatch[1]) : '';

    const placeCoords = extractGooglePlaceCoords(href);
    if (placeCoords) {
      return {
        lat: placeCoords.lat,
        lng: placeCoords.lng,
        label: placeName || addressLabel || `${placeCoords.lat}, ${placeCoords.lng}`
      };
    }

    const ll = url.searchParams.get('ll');
    if (ll) {
      const [latRaw, lngRaw] = ll.split(',');
      const lat = parseFloat(latRaw);
      const lng = parseFloat(lngRaw);
      if (isValidCoord(lat, lng)) {
        return {
          lat,
          lng,
          label: placeName || addressLabel || `${lat}, ${lng}`
        };
      }
    }

    if (addressParam) {
      const decoded = decodeMapsText(addressParam);
      const coordMatch = decoded.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
      if (coordMatch) {
        const lat = parseFloat(coordMatch[1]);
        const lng = parseFloat(coordMatch[2]);
        if (isValidCoord(lat, lng)) {
          return { lat, lng, label: `${lat}, ${lng}` };
        }
      }
      return { query: cleanMapsAddressLabel(addressParam) };
    }

    const atMatch = href.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    if (atMatch) {
      const lat = parseFloat(atMatch[1]);
      const lng = parseFloat(atMatch[2]);
      if (isValidCoord(lat, lng)) {
        return {
          lat,
          lng,
          label: placeName || addressLabel || `${lat}, ${lng}`
        };
      }
    }

    if (placeName) return { query: placeName };
    return null;
  }

  function extractMapsAddressParam(url) {
    for (const key of ['query', 'q', 'daddr', 'saddr']) {
      const value = url.searchParams.get(key);
      if (value?.trim()) return value;
    }

    const dirMatch = url.pathname.match(/\/maps\/dir\/(.+)/);
    if (!dirMatch) return null;

    const parts = dirMatch[1].split('/').filter(Boolean);
    for (const part of parts) {
      if (part.startsWith('@')) continue;
      if (part.startsWith('data=')) continue;
      return part;
    }
    return null;
  }

  function geocodeResultMatchesCity(item, city) {
    const hay = normalizeName(item.display_name || '');
    const cityNorm = normalizeName(city.name);
    if (hay.includes(cityNorm)) return true;
    const words = cityNorm.split(' ').filter(w => w.length > 3);
    return words.length > 0 && words.every(w => hay.includes(w));
  }

  async function nominatimSearch(q, limit = 5) {
    const params = new URLSearchParams({
      q,
      format: 'json',
      limit: String(limit),
      countrycodes: 'br'
    });
    const res = await fetch(`${NOMINATIM_API}?${params}`, {
      headers: { 'User-Agent': 'IngressoCinemaMap/2.0' }
    });
    if (!res.ok) throw new Error('Serviço de geocodificação indisponível.');
    return res.json();
  }

  async function geocodeInPageCity(query) {
    await resolvePageCity();
    const city = pageCity || DEFAULT_CITY;
    const data = await nominatimSearch(buildGeocodeQuery(query), 5);
    if (!data.length) {
      throw new Error(`Endereço não encontrado em ${city.name}. Tente incluir o bairro.`);
    }
    const match = data.find(item => geocodeResultMatchesCity(item, city));
    if (!match) {
      throw new Error(
        `Nenhum resultado em ${city.name} para "${query}". Verifique o endereço ou a cidade selecionada no site.`
      );
    }
    return match;
  }

  // ── Group mode calculations ────────────────────────────────────────────

  function calculateCentroid(locations) {
    if (locations.length === 0) return null;
    const lat = locations.reduce((sum, loc) => sum + loc.lat, 0) / locations.length;
    const lng = locations.reduce((sum, loc) => sum + loc.lng, 0) / locations.length;
    return { lat, lng };
  }

  function calculateDistancesToPoint(point, cinemas) {
    return cinemas.map(cinema => ({
      ...cinema,
      distance: cinema.lat && cinema.lng ? haversine(point.lat, point.lng, cinema.lat, cinema.lng) : null
    }));
  }

  function friendDistancesForCinema(cinema, friends) {
    if (!cinema.lat || !cinema.lng) return friends.map(() => null);
    return friends.map(f => haversine(f.lat, f.lng, cinema.lat, cinema.lng));
  }

  function truncateText(text, maxLen = 26) {
    const s = String(text).trim();
    if (!s) return '';
    if (s.length <= maxLen) return s;
    return `${s.slice(0, maxLen - 1)}…`;
  }

  function friendShortLabel(friend, idx) {
    const full = friend.label || `Amigo ${idx + 1}`;
    const raw = full.split(',')[0].trim() || full.trim();
    return truncateText(raw);
  }

  function friendDisplayLabel(friend, idx) {
    return friend.label || `Amigo ${idx + 1}`;
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function formatPerFriendDistances(friends, distances, { compact = false, closestFriendIndices = null } = {}) {
    return friends.map((friend, idx) => {
      const dist = distances[idx];
      const label = escapeHtml(friendShortLabel(friend, idx));
      const fullLabel = escapeHtml(friendDisplayLabel(friend, idx));
      const value = dist != null ? `${dist.toFixed(1)} km` : '?';
      const color = getFriendColor(idx);
      const isClosest = closestFriendIndices?.includes(idx);

      if (compact) {
        const weight = isClosest ? '700' : '600';
        const marker = isClosest ? ' ★' : '';
        return `<div style="display:flex;align-items:center;gap:6px;margin:1px 0;font-size:11px;line-height:1.35">` +
          `<span style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0;box-shadow:0 0 6px ${color}88"></span>` +
          `<span style="color:rgba(240,240,240,0.78);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${fullLabel}">${label}</span>` +
          `<span style="color:${color};font-weight:${weight};white-space:nowrap">${value}${marker}</span>` +
          `</div>`;
      }

      return `<div class="icm-friend-dist-row">` +
        `<span class="icm-friend-dist-name"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px;vertical-align:middle"></span>${label}${isClosest ? ' ★' : ''}</span>` +
        `<span class="icm-friend-dist-val" style="color:${color}">${value}</span></div>`;
    }).join('');
  }

  function findHighlightedCinemaForSort(cinemas) {
    if (currentSort !== 'dist-asc' && currentSort !== 'dist-desc') return null;
    const withDist = cinemas.filter(c => c.distance != null && c.lat != null);
    if (!withDist.length) return null;
    if (currentSort === 'dist-asc') {
      return withDist.reduce((best, c) => (c.distance < best.distance ? c : best));
    }
    return withDist.reduce((best, c) => (c.distance > best.distance ? c : best));
  }

  function getHighlightedCinema(cinemas) {
    if (groupMode && friendLocations.length > 0) {
      if (currentGroupMode === 'centroid') {
        return findBestCinemaByMode(cinemas, friendLocations, currentGroupMode);
      }
      return null;
    }
    return findHighlightedCinemaForSort(cinemas);
  }

  function buildCinemaPinHtml(cinema, idx, cinemas, closestByCinema) {
    const highlighted = getHighlightedCinema(cinemas);
    const isBest = highlighted && highlighted.name === cinema.name;
    const closestFriends = closestByCinema?.get(cinema.name) || [];
    const pinStyle = closestFriends.length ? friendPinStyle(closestFriends) : '';
    const bestClass = isBest && !closestFriends.length ? 'icm-pin-best' : '';
    return `<div class="icm-pin ${bestClass}" style="${pinStyle}"><span class="icm-pin-n">${idx + 1}</span></div>`;
  }

  function findBestCinemaByMode(cinemas, friends, mode) {
    if (friends.length === 0 || cinemas.length === 0 || mode === 'per-friend') return null;

    const centroid = calculateCentroid(friends);
    const withDist = calculateDistancesToPoint(centroid, cinemas);
    return withDist.filter(c => c.distance !== null).sort((a, b) => a.distance - b.distance)[0] || null;
  }

  function prepareCinemasForGroup(cinemas, friends, mode) {
    if (mode === 'centroid') {
      const centroid = calculateCentroid(friends);
      return cinemas.map(c => ({
        ...c,
        distance: c.lat != null ? haversine(centroid.lat, centroid.lng, c.lat, c.lng) : null
      }));
    }

    return cinemas.map(c => {
      const friendDistances = friendDistancesForCinema(c, friends);
      const valid = friendDistances.filter(d => d != null);
      const distance = valid.length
        ? valid.reduce((sum, d) => sum + d, 0) / valid.length
        : null;
      return { ...c, distance, friendDistances };
    });
  }

  function sortByDistanceAsc(cinemas) {
    return [...cinemas].sort((a, b) => {
      if (a.distance == null && b.distance == null) return 0;
      if (a.distance == null) return 1;
      if (b.distance == null) return -1;
      return a.distance - b.distance;
    });
  }

  function refreshMapDisplay() {
    if (!cachedCinemas || !cachedUserCoords) return;

    if (groupMode && friendLocations.length > 0) {
      const withMetrics = prepareCinemasForGroup(cachedCinemas, friendLocations, currentGroupMode);
      const sorted = sortByDistanceAsc(withMetrics);
      updateMapCount(sorted);
      renderMap(sorted, cachedUserCoords);
      if (leafletMap) leafletMap.invalidateSize();
      sortPageCinemas(sorted);
      return;
    }

    reSort();
  }

  function updateGroupBarState() {
    const hasFriends = friendLocations.length > 0;
    document.querySelectorAll('#icm-group-bar [data-group-mode]').forEach(chip => {
      chip.disabled = !hasFriends;
      chip.classList.toggle('icm-chip-disabled', !hasFriends);
      if (!hasFriends) chip.classList.remove('icm-chip-active');
    });
    if (hasFriends) {
      const active = document.querySelector(`#icm-group-bar [data-group-mode="${currentGroupMode}"]`);
      active?.classList.add('icm-chip-active');
    } else {
      document.querySelector('#icm-group-bar [data-group-mode="centroid"]')
        ?.classList.add('icm-chip-active');
      currentGroupMode = 'centroid';
    }
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
    const timeLeaves = getPageTimeLeaves();
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
    return getPageTimeLeaves()
      .map(el => el.textContent.trim())
      .sort().join(',');
  }

  // ── Find card elements for DOM sorting ────────────────────────────────

  // Returns { name, card (inner cinema card), element (direct child of cinemaContainer) }
  function findCinemaCardElements() {
    if (!cinemaContainer) return [];

    const timeLeaves = getPageTimeLeaves();

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

    const isPerFriend = groupMode && friendLocations.length > 0 && currentGroupMode === 'per-friend';
    const closestByCinema = isPerFriend ? findClosestCinemaPerFriend(sortedCinemas, friendLocations) : null;

    // Reorder: appendChild moves the child to end, building sorted order
    sortedCinemas.forEach((cinema, idx) => {
      const entry = cardEls.find(c => normalizeName(c.name) === normalizeName(cinema.name));
      if (!entry) return;

      cinemaContainer.appendChild(entry.element);

      // Inject distance badge at top of card
      const badge = document.createElement('div');
      badge.setAttribute('data-icm-dist', '1');
      badge.style.cssText = [
        'display:flex', 'align-items:flex-start', 'gap:8px',
        'padding:6px 12px 2px', 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        'font-size:12px', 'line-height:1.4'
      ].join(';');

      const numColor = cinema.lat ? '#3255e2' : '#4b5563';
      let distLabel;

      if (isPerFriend) {
        const distances = cinema.friendDistances || friendDistancesForCinema(cinema, friendLocations);
        const closestFriendIndices = closestByCinema?.get(cinema.name) || null;
        distLabel = `<div style="display:flex;flex-direction:column;gap:1px;min-width:0;flex:1">` +
          formatPerFriendDistances(friendLocations, distances, { compact: true, closestFriendIndices }) +
          `</div>`;
      } else {
        distLabel = cinema.distance != null
          ? `<span style="color:#98aaec;font-weight:600;">${cinema.distance.toFixed(1)} km</span>`
          : `<span style="color:rgba(240,240,240,0.4);">distância desconhecida</span>`;
      }

      badge.innerHTML = `
        <span style="background:${numColor};color:#fff;min-width:20px;height:20px;border-radius:50%;
          display:inline-flex;align-items:center;justify-content:center;
          font-size:11px;font-weight:700;flex-shrink:0;margin-top:1px;">${idx + 1}</span>
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
    applyDistancesFromPoint(cachedUserCoords, true);
  }

  function onPreviewMarkerDragged() {
    if (previewContext === 'group') return;
    if (!cachedCinemas || !previewMarker) return;
    const latlng = previewMarker.getLatLng();
    applyDistancesFromPoint({ lat: latlng.lat, lng: latlng.lng }, false);
  }

  function applyDistancesFromPoint(point, updatePageSort) {
    if (groupMode && friendLocations.length > 0) {
      if (point.lat != null && point.lng != null) {
        cachedUserCoords = { ...(cachedUserCoords || {}), lat: point.lat, lng: point.lng };
      }
      refreshMapDisplay();
      return;
    }

    const withDist = cachedCinemas.map(c => ({
      ...c,
      distance: c.lat !== null ? haversine(point.lat, point.lng, c.lat, c.lng) : null
    }));
    const sorted = sortCinemas(withDist);
    const highlighted = getHighlightedCinema(sorted);
    const closestByCinema = groupMode && friendLocations.length > 0 && currentGroupMode === 'per-friend'
      ? findClosestCinemaPerFriend(sorted, friendLocations)
      : null;

    sorted.forEach((cinema, idx) => {
      const entry = cinemaMarkers.find(m => m.name === cinema.name);
      if (!entry) return;
      const isBest = highlighted && highlighted.name === cinema.name;
      entry.marker.setIcon(L.divIcon({
        className: '',
        html: buildCinemaPinHtml(cinema, idx, sorted, closestByCinema),
        iconSize: [26, 26], iconAnchor: [13, 26]
      }));
      const distText = cinema.distance != null ? `${cinema.distance.toFixed(1)} km` : '';
      entry.marker.setPopupContent(
        `<div class="icm-popup">
          <div class="icm-popup-name">${cinema.name}${isBest ? ' ⭐' : ''}</div>
          ${distText ? `<div class="icm-popup-dist">${distText}</div>` : ''}
          <div class="icm-popup-addr">${cinema.address || ''}</div>
          <div class="icm-popup-sessions">${sessionBadgesHtml(cinema.sessions)}</div>
        </div>`);
    });

    if (updatePageSort) sortPageCinemas(sorted);
  }

  function renderMap(cinemas, userCoords, { preview = false, previewCoords = null } = {}) {
    const mapEl = document.getElementById('icm-map');
    if (!mapEl) return;

    if (leafletMap) { leafletMap.remove(); leafletMap = null; }
    mapEl._leaflet_map = null;
    cinemaMarkers = [];
    userMarker = null;
    previewMarker = null;
    friendMarkers.forEach(m => m.remove?.());
    friendMarkers = [];

    leafletMap = L.map(mapEl, { zoomControl: true });
    mapEl._leaflet_map = leafletMap;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
      // #29: send Referer on cross-origin tiles despite page same-origin policy
      referrerPolicy: 'strict-origin-when-cross-origin',
    }).addTo(leafletMap);

    const validCoords = [[userCoords.lat, userCoords.lng]];

    if (previewCoords) {
      const userIcon = L.divIcon({
        className: '',
        html: '<div class="icm-user-dot-wrapper"><div class="icm-user-dot"></div></div>',
        iconSize: [16, 16], iconAnchor: [8, 8]
      });
      userMarker = L.marker([userCoords.lat, userCoords.lng], { icon: userIcon, draggable: false })
        .addTo(leafletMap)
        .bindPopup(`<strong>Você</strong>`);

      const previewIcon = L.divIcon({
        className: 'icm-preview-marker-icon',
        html: '<div class="icm-preview-dot-wrapper"><div class="icm-preview-dot"></div></div>',
        iconSize: [22, 22], iconAnchor: [11, 11]
      });
      previewMarker = L.marker([previewCoords.lat, previewCoords.lng], { icon: previewIcon, draggable: true, zIndexOffset: 1000 })
        .addTo(leafletMap)
        .bindPopup(
          `<strong>Novo amigo</strong><br><span style="font-size:11px;color:rgba(240,240,240,0.5)">Arraste para ajustar</span>`
        );
      previewMarker.on('dragend', onPreviewMarkerDragged);
      validCoords.push([previewCoords.lat, previewCoords.lng]);
    } else if (preview) {
      const previewIcon = L.divIcon({
        className: 'icm-preview-marker-icon',
        html: '<div class="icm-preview-dot-wrapper"><div class="icm-preview-dot"></div></div>',
        iconSize: [22, 22], iconAnchor: [11, 11]
      });
      previewMarker = L.marker([userCoords.lat, userCoords.lng], { icon: previewIcon, draggable: true, zIndexOffset: 1000 })
        .addTo(leafletMap)
        .bindPopup(
          `<strong>Pré-visualização</strong><br><span style="font-size:11px;color:rgba(240,240,240,0.5)">Arraste para ajustar</span>`
        );
      previewMarker.on('dragend', onPreviewMarkerDragged);
    } else {
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
    }

    if (groupMode && friendLocations.length > 0) {
      friendLocations.forEach((friend, idx) => {
        const color = getFriendColor(idx);
        const friendIcon = L.divIcon({
          className: '',
          html: `<div class="icm-friend-marker" style="background:${color};box-shadow:0 0 10px ${color}88,0 2px 8px rgba(0,0,0,0.4)"><span class="icm-friend-marker-label">${idx + 1}</span></div>`,
          iconSize: [24, 24], iconAnchor: [12, 12]
        });
        const m = L.marker([friend.lat, friend.lng], { icon: friendIcon })
          .addTo(leafletMap)
          .bindPopup(`<strong style="color:${color}">${friend.label || `Amigo ${idx + 1}`}</strong>`);
        friendMarkers.push(m);
        validCoords.push([friend.lat, friend.lng]);
      });
    }

    const closestByCinema = groupMode && friendLocations.length > 0 && currentGroupMode === 'per-friend'
      ? findClosestCinemaPerFriend(cinemas, friendLocations)
      : null;

    const highlighted = getHighlightedCinema(cinemas);

    cinemas.forEach((cinema, idx) => {
      if (cinema.lat === null) return;
      const isBest = highlighted && highlighted.name === cinema.name;
      const closestFriends = closestByCinema?.get(cinema.name) || [];
      const icon = L.divIcon({
        className: '',
        html: buildCinemaPinHtml(cinema, idx, cinemas, closestByCinema),
        iconSize: [26, 26], iconAnchor: [13, 26]
      });

      let distText = '';
      if (groupMode && friendLocations.length > 0) {
        if (currentGroupMode === 'centroid') {
          const centroid = calculateCentroid(friendLocations);
          const dist = haversine(centroid.lat, centroid.lng, cinema.lat, cinema.lng);
          distText = `${dist.toFixed(1)} km (centroide)`;
        } else if (currentGroupMode === 'per-friend') {
          const distances = cinema.friendDistances || friendDistancesForCinema(cinema, friendLocations);
          distText = formatPerFriendDistances(friendLocations, distances, { closestFriendIndices: closestFriends });
        }
      } else if (cinema.distance != null) {
        distText = `${cinema.distance.toFixed(1)} km`;
      }

      const popup = `
        <div class="icm-popup">
          <div class="icm-popup-name">${cinema.name}${isBest ? ' ⭐' : ''}</div>
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

  async function fetchTheaters() {
    await resolvePageCity();
    const cityId = pageCity?.id || DEFAULT_CITY.id;
    const res = await fetch(`${THEATERS_API}/${cityId}?partnership=encora`);
    if (!res.ok) throw new Error(`Theater API ${res.status}`);
    return res.json();
  }

  async function geocodeAddress(address) {
    await resolvePageCity();
    const city = pageCity || DEFAULT_CITY;
    const base = address.replace('|', ',').trim();
    const q = `${base}, ${city.name}, ${city.uf}, Brasil`;
    try {
      const data = await nominatimSearch(q, 3);
      const match = data.find(item => geocodeResultMatchesCity(item, city)) || data[0];
      if (!match) return null;
      return { lat: parseFloat(match.lat), lng: parseFloat(match.lon) };
    } catch {
      return null;
    }
  }

  function isMapsShortLink(input) {
    return MAPS_SHORT_LINK_RE.test(input.trim());
  }

  function extractSearchQueryFromUrl(url) {
    try {
      const parsed = new URL(url);
      const q = parsed.searchParams.get('q');
      if (!q) return null;
      if (parsed.pathname.includes('/search') || parsed.hostname.includes('google.')) {
        return decodeMapsText(q);
      }
    } catch {
      return null;
    }
    return null;
  }

  function resolveMapsShortLinkViaExtension(input) {
    return new Promise((resolve, reject) => {
      const requestId = `icm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timeoutMs = 25000;

      const onMessage = (event) => {
        if (event.source !== window || event.data?.type !== 'icm-resolve-short-link-response') return;
        if (event.data.requestId !== requestId) return;
        cleanup();
        if (event.data.error) {
          reject(new Error(event.data.error));
          return;
        }
        const resp = event.data.resp;
        if (!resp?.success || !resp.resolvedUrl) {
          reject(new Error(resp?.error || 'Não foi possível resolver o link curto.'));
          return;
        }
        resolve(resp.resolvedUrl);
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Tempo limite ao resolver o link curto.'));
      }, timeoutMs);

      function cleanup() {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
      }

      window.addEventListener('message', onMessage);
      window.postMessage({
        type: 'icm-resolve-short-link-request',
        requestId,
        url: input.trim()
      }, '*');
    });
  }

  async function normalizeMapsInput(query) {
    const trimmed = query.trim();
    if (!isMapsShortLink(trimmed)) return trimmed;

    const resolvedUrl = await resolveMapsShortLinkViaExtension(trimmed);
    if (isMapsShortLink(resolvedUrl) && !extractSearchQueryFromUrl(resolvedUrl)) {
      throw new Error('Não foi possível extrair a localização deste link curto.');
    }

    const searchQuery = extractSearchQueryFromUrl(resolvedUrl);
    if (searchQuery) return searchQuery;
    return resolvedUrl;
  }

  async function geocodeManualInput(query) {
    let normalizedQuery;
    try {
      normalizedQuery = await normalizeMapsInput(query);
    } catch (err) {
      throw new Error(err.message || 'Não foi possível resolver o link curto.');
    }

    const mapsInput = parseGoogleMapsUrl(normalizedQuery);
    if (mapsInput?.lat != null && mapsInput?.lng != null) {
      return {
        lat: mapsInput.lat,
        lng: mapsInput.lng,
        label: mapsInput.label || `${mapsInput.lat}, ${mapsInput.lng}`
      };
    }

    const searchQuery = mapsInput?.query || normalizedQuery;
    const formatted = formatGoogleAddressForGeocode(searchQuery);
    const match = formatted.city && formatted.uf
      ? await geocodeResolvedAddress(searchQuery)
      : await geocodeInPageCity(searchQuery);
    return {
      lat: parseFloat(match.lat),
      lng: parseFloat(match.lon),
      label: cleanMapsAddressLabel(searchQuery) || match.display_name
    };
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
      const apiLat = theater?.geolocation?.lat;
      const apiLng = theater?.geolocation?.lng;
      if (apiLat && apiLat !== 0 && apiLng && apiLng !== 0 && isPlausiblyInBrazil(apiLat, apiLng)) {
        const coords = { lat: apiLat, lng: apiLng };
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
    if (cachedCinemas) {
      openLocationSearch();
      return;
    }
    const inp = document.getElementById('icm-manual-input');
    const err = document.getElementById('icm-manual-error');
    if (inp) inp.value = '';
    if (err) { err.textContent = ''; err.classList.add('icm-hidden'); }
    setState('icm-manual');
    setTimeout(() => inp?.focus(), 50);
  }

  function setMapOverlayVisibility(visible) {
    document.querySelector('.icm-map-overlays')?.classList.toggle('icm-hidden', !visible);
  }

  async function openLocationSearch() {
    if (locationPreviewActive) {
      cancelLocationPreview(false);
      if (cachedUserCoords && cachedCinemas) renderWithLocation(cachedUserCoords);
    }
    await resolvePageCity();
    setState('icm-map-section');
    document.getElementById('icm-loc-search')?.classList.remove('icm-hidden');
    document.getElementById('icm-loc-preview')?.classList.add('icm-hidden');
    const errEl = document.getElementById('icm-loc-search-error');
    if (errEl) { errEl.textContent = ''; errEl.classList.add('icm-hidden'); }
    setMapOverlayVisibility(false);
    const inp = document.getElementById('icm-loc-search-input');
    if (inp) {
      inp.placeholder = `Endereço ou link do Google Maps (${pageCity?.name || 'sua cidade'})`;
      inp.value = '';
      setTimeout(() => inp.focus(), 50);
    }
  }

  function closeLocationSearch() {
    document.getElementById('icm-loc-search')?.classList.add('icm-hidden');
    const errEl = document.getElementById('icm-loc-search-error');
    if (errEl) { errEl.textContent = ''; errEl.classList.add('icm-hidden'); }
    if (!locationPreviewActive) setMapOverlayVisibility(true);
  }

  function setPreviewOverlayUI(mode) {
    const labelEl = document.getElementById('icm-loc-preview-label');
    const hintEl = document.querySelector('#icm-loc-preview .icm-loc-preview-hint');
    const confirmBtn = document.getElementById('icm-loc-preview-confirm');
    if (!labelEl || !hintEl || !confirmBtn) return;

    if (mode === 'group-pin') {
      labelEl.textContent = 'Marcar localização no mapa';
      hintEl.textContent = 'Clique no mapa onde o amigo está. Pressione Cancelar para voltar.';
      confirmBtn.classList.add('icm-hidden');
      return;
    }

    confirmBtn.classList.remove('icm-hidden');
    if (mode === 'group') {
      labelEl.textContent = previewLabel || `Amigo ${friendLocations.length + 1}`;
      hintEl.textContent = 'Arraste o marcador para ajustar. Confirme para adicionar à lista.';
      confirmBtn.textContent = 'Adicionar amigo';
      return;
    }

    labelEl.textContent = previewLabel;
    hintEl.textContent = 'Arraste o marcador para ajustar a posição';
    confirmBtn.textContent = 'Confirmar localização';
  }

  function clearGroupSearchFeedback() {
    const errEl = document.getElementById('icm-group-search-error');
    if (errEl) { errEl.textContent = ''; errEl.classList.add('icm-hidden'); }
    document.getElementById('icm-group-pin-drop')?.classList.remove('icm-pin-drop-highlight');
  }

  function buildFriendLabel(query, coords) {
    if (coords?.label) {
      const fromCoords = coords.label.split(',').map(s => s.trim()).filter(Boolean).slice(0, 2).join(', ');
      if (fromCoords) return fromCoords;
    }
    const mapsInput = query ? parseGoogleMapsUrl(query) : null;
    const textQuery = mapsInput?.query || (!mapsInput ? query : null);
    if (textQuery) {
      const fromQuery = textQuery.split(',').map(s => s.trim()).filter(Boolean).slice(0, 2).join(', ');
      if (fromQuery) return fromQuery;
    }
    return `Amigo ${friendLocations.length + 1}`;
  }

  function stopGroupPinDropMode() {
    if (groupPinDropHandler && leafletMap) {
      leafletMap.off('click', groupPinDropHandler);
      groupPinDropHandler = null;
    }
    leafletMap?.getContainer().style.removeProperty('cursor');
  }

  function enterLocationPreview(coords) {
    if (!cachedCinemas) return;
    previewContext = 'user';
    previewLabel = coords.label || '';
    locationPreviewActive = true;

    setState('icm-map-section');
    closeLocationSearch();
    document.getElementById('icm-loc-preview')?.classList.remove('icm-hidden');
    setPreviewOverlayUI('user');
    setMapOverlayVisibility(false);

    const withDist = cachedCinemas.map(c => ({
      ...c,
      distance: c.lat !== null ? haversine(coords.lat, coords.lng, c.lat, c.lng) : null
    }));
    const sorted = sortCinemas(withDist);
    updateMapCount(sorted);

    setTimeout(() => {
      renderMap(sorted, coords, { preview: true });
      if (leafletMap) {
        leafletMap.setView([coords.lat, coords.lng], 15);
        leafletMap.invalidateSize();
      }
    }, 50);
  }

  function enterGroupFriendPreview(coords, query) {
    if (!cachedCinemas || !cachedUserCoords) return;
    stopGroupPinDropMode();
    previewContext = 'group';
    groupPreviewQuery = query || '';
    previewLabel = coords.label || buildFriendLabel(query, coords);
    locationPreviewActive = true;

    document.getElementById('icm-group-modal')?.classList.add('icm-hidden');
    setState('icm-map-section');
    document.getElementById('icm-loc-preview')?.classList.remove('icm-hidden');
    setPreviewOverlayUI('group');
    setMapOverlayVisibility(false);

    setTimeout(() => {
      renderMap(cachedCinemas, cachedUserCoords, { previewCoords: coords });
      if (leafletMap) {
        leafletMap.fitBounds(L.latLngBounds([
          [cachedUserCoords.lat, cachedUserCoords.lng],
          [coords.lat, coords.lng]
        ]), { padding: [40, 40] });
        leafletMap.invalidateSize();
      }
    }, 50);
  }

  function startGroupPinDrop() {
    if (!leafletMap || !cachedCinemas || !cachedUserCoords) return;
    stopGroupPinDropMode();
    clearGroupSearchFeedback();
    previewContext = 'group-pin';
    previewLabel = '';
    groupPreviewQuery = '';
    locationPreviewActive = true;

    document.getElementById('icm-group-modal')?.classList.add('icm-hidden');
    setState('icm-map-section');
    document.getElementById('icm-loc-preview')?.classList.remove('icm-hidden');
    setPreviewOverlayUI('group-pin');
    setMapOverlayVisibility(false);
    refreshMapDisplay();

    leafletMap.getContainer().style.cursor = 'crosshair';
    groupPinDropHandler = (e) => {
      stopGroupPinDropMode();
      enterGroupFriendPreview(
        { lat: e.latlng.lat, lng: e.latlng.lng, label: `Amigo ${friendLocations.length + 1}` },
        ''
      );
    };
    leafletMap.once('click', groupPinDropHandler);
  }

  function confirmGroupFriendPreview() {
    if (!previewMarker) return;
    const latlng = previewMarker.getLatLng();
    friendLocations.push({
      lat: latlng.lat,
      lng: latlng.lng,
      label: buildFriendLabel(groupPreviewQuery, { label: previewLabel })
    });
    resetGroupPreviewState(true);
    updateGroupList();
    updateGroupBarState();
    refreshMapDisplay();
  }

  function resetGroupPreviewState(reopenModal) {
    stopGroupPinDropMode();
    previewContext = null;
    locationPreviewActive = false;
    previewMarker = null;
    previewLabel = '';
    groupPreviewQuery = '';
    document.getElementById('icm-loc-preview')?.classList.add('icm-hidden');
    if (reopenModal) {
      clearGroupSearchFeedback();
      document.getElementById('icm-group-modal')?.classList.remove('icm-hidden');
      setMapOverlayVisibility(true);
    }
  }

  function confirmLocationPreview() {
    if (previewContext === 'group') {
      confirmGroupFriendPreview();
      return;
    }
    if (!previewMarker) return;
    const latlng = previewMarker.getLatLng();
    locationPreviewActive = false;
    previewContext = null;
    previewMarker = null;
    document.getElementById('icm-loc-preview')?.classList.add('icm-hidden');
    setMapOverlayVisibility(true);
    renderWithLocation({ lat: latlng.lat, lng: latlng.lng, label: previewLabel });
    previewLabel = '';
  }

  function cancelLocationPreview(restore = true) {
    if (previewContext === 'group' || previewContext === 'group-pin') {
      resetGroupPreviewState(restore);
      if (restore && cachedCinemas && cachedUserCoords) refreshMapDisplay();
      return;
    }

    locationPreviewActive = false;
    previewContext = null;
    previewMarker = null;
    previewLabel = '';
    document.getElementById('icm-loc-search')?.classList.add('icm-hidden');
    document.getElementById('icm-loc-preview')?.classList.add('icm-hidden');
    document.getElementById('icm-loc-search-error')?.classList.add('icm-hidden');

    if (!restore) return;

    if (cachedUserCoords && cachedCinemas) {
      setMapOverlayVisibility(true);
      renderWithLocation(cachedUserCoords);
    } else {
      setMapOverlayVisibility(true);
      setState('icm-manual');
    }
  }

  // ── Group mode ─────────────────────────────────────────────────────────

  function toggleGroupMode() {
    const modal = document.getElementById('icm-group-modal');
    const modalHidden = !modal || modal.classList.contains('icm-hidden');

    if (groupMode) {
      if (friendLocations.length === 0 && modalHidden) {
        exitGroupMode();
        return;
      }
      if (modal) modal.classList.toggle('icm-hidden');
    } else {
      groupMode = true;
      const bar = document.getElementById('icm-sort-bar');
      const groupBar = document.getElementById('icm-group-bar');
      const btn = document.getElementById('icm-btn-group-toggle');
      if (modal) modal.classList.remove('icm-hidden');
      if (bar) bar.style.display = 'none';
      if (groupBar) groupBar.classList.remove('icm-hidden');
      if (btn) btn.classList.add('icm-active');
    }
    updateGroupList();
    updateGroupBarState();
  }

  function exitGroupMode() {
    stopGroupPinDropMode();
    resetGroupPreviewState(false);
    groupMode = false;
    currentGroupMode = 'centroid';
    const modal = document.getElementById('icm-group-modal');
    const bar = document.getElementById('icm-sort-bar');
    const groupBar = document.getElementById('icm-group-bar');
    const btn = document.getElementById('icm-btn-group-toggle');
    if (modal) modal.classList.add('icm-hidden');
    if (bar) bar.style.display = 'flex';
    if (groupBar) groupBar.classList.add('icm-hidden');
    if (btn) btn.classList.remove('icm-active');
    friendLocations = [];
    friendMarkers.forEach(m => m.remove?.());
    friendMarkers = [];
    updateGroupList();
    updateGroupBarState();
    if (cachedCinemas && cachedUserCoords) {
      reSort();
    }
  }

  function closeGroupModal() {
    if (friendLocations.length === 0) {
      exitGroupMode();
      return;
    }
    const modal = document.getElementById('icm-group-modal');
    if (modal) modal.classList.add('icm-hidden');
    refreshMapDisplay();
  }

  async function addFriendLocation() {
    const input = document.getElementById('icm-group-search');
    const btn = document.getElementById('icm-group-add-btn');
    if (!input || !input.value.trim()) return;

    const query = input.value.trim();
    clearGroupSearchFeedback();
    if (btn) { btn.disabled = true; btn.textContent = 'Buscando...'; }

    try {
      const coords = await geocodeManualInput(query);
      const label = buildFriendLabel(query, coords);
      input.value = '';
      enterGroupFriendPreview({ ...coords, label }, query);
    } catch (err) {
      showSearchError(
        'icm-group-search-error',
        `${err.message} Você pode marcar a localização no mapa abaixo.`
      );
      document.getElementById('icm-group-pin-drop')?.classList.add('icm-pin-drop-highlight');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Adicionar'; }
    }
  }

  function enablePinDrop() {
    startGroupPinDrop();
  }

  function updateGroupList() {
    const list = document.getElementById('icm-group-list');
    if (!list) return;

    list.innerHTML = friendLocations.map((friend, idx) => {
      const color = getFriendColor(idx);
      return `
      <div class="icm-group-item">
        <span style="display:flex;align-items:center;gap:8px;min-width:0">
          <span style="width:10px;height:10px;border-radius:50%;background:${color};flex-shrink:0;box-shadow:0 0 8px ${color}88"></span>
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(friend.label)}">${escapeHtml(friendShortLabel(friend, idx))}</span>
        </span>
        <button class="icm-group-remove" data-idx="${idx}">✕</button>
      </div>`;
    }).join('');

    list.querySelectorAll('.icm-group-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        friendLocations.splice(idx, 1);
        updateGroupList();
        updateGroupBarState();
        refreshMapDisplay();
      });
    });
  }

  function updateMapCount(cinemas) {
    const countEl = document.getElementById('icm-count');
    if (countEl) {
      let text;
      if (groupMode && friendLocations.length > 0) {
        if (currentGroupMode === 'per-friend') {
          text = `${cinemas.length} cinemas • pin colorido = mais próximo de cada amigo`;
        } else {
          text = `${cinemas.length} cinemas • ${friendLocations.length} amigos`;
        }
      } else {
        text = `${cinemas.length} cinema${cinemas.length !== 1 ? 's' : ''}`;
      }
      countEl.textContent = text;
    }
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
    updateMapCount(sorted);

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

  function showSearchError(errElId, message) {
    const errEl = document.getElementById(errElId);
    if (errEl) { errEl.textContent = message; errEl.classList.remove('icm-hidden'); }
  }

  async function searchAndPreviewLocation(query, errElId, btn) {
    if (!query) return;
    const errEl = document.getElementById(errElId);
    if (errEl) errEl.classList.add('icm-hidden');
    if (btn) { btn.disabled = true; btn.textContent = 'Buscando...'; }
    try {
      const coords = await geocodeManualInput(query);
      const shortLabel = coords.label.split(',').slice(0, 3).join(',').trim();
      enterLocationPreview({ ...coords, label: shortLabel });
    } catch (e) {
      showSearchError(errElId, e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Buscar'; }
    }
  }

  async function submitManualLocation() {
    const inp = document.getElementById('icm-manual-input');
    const btn = document.getElementById('icm-btn-manual-go');
    await searchAndPreviewLocation(inp?.value.trim(), 'icm-manual-error', btn);
  }

  async function submitLocationSearch() {
    const inp = document.getElementById('icm-loc-search-input');
    const btn = document.getElementById('icm-loc-search-go');
    await searchAndPreviewLocation(inp?.value.trim(), 'icm-loc-search-error', btn);
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
    try { apiTheaters = await fetchTheaters(); } catch (_) {}

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

    new MutationObserver((mutations) => {
      // Ignore map/popup/UI mutations inside the extension panel — opening a
      // cinema pin injects session times that must not look like a day-tab change.
      const relevant = mutations.some(m => {
        const nodes = [...m.addedNodes, ...m.removedNodes, m.target];
        return nodes.some(n => n.nodeType === 1 && !isExtensionDom(n));
      });
      if (!relevant) return;

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

  function watchForCityChanges() {
    let lastKey = getCityLookupKey();
    setInterval(async () => {
      const key = getCityLookupKey();
      if (key === lastKey) return;
      lastKey = key;
      pageCityKey = null;
      geocodeCache.clear();
      await resolvePageCity();
      if (cachedCinemas) refreshCinemas();
    }, 1500);
  }

  // ── Main data load ─────────────────────────────────────────────────────

  async function loadData() {
    setLoading('Buscando sessões na página...');
    let domCinemas;
    try { domCinemas = scrapeCinemas(); }
    catch (e) { setError(e.message); return; }

    setLoading('Buscando coordenadas dos cinemas...');
    let apiTheaters = [];
    try { apiTheaters = await fetchTheaters(); } catch (_) {}

    cachedCinemas = await matchAndGeocode(domCinemas, apiTheaters, (i, total) => {
      setLoading(`Geocodificando ${i} de ${total} cinemas...`);
    });

    await runAutoLocation();
  }

  // ── Wait / find helpers ────────────────────────────────────────────────

  function waitForTimeElements() {
    return new Promise(resolve => {
      const hasTime = () => getPageTimeLeaves().length > 0;
      if (hasTime()) return resolve();
      const obs = new MutationObserver(() => {
        if (hasTime()) { obs.disconnect(); resolve(); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(); }, 10000);
    });
  }

  function findCinemaListContainer() {
    const timeLeaves = getPageTimeLeaves();
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
          <input id="icm-manual-input" type="text" placeholder="Endereço ou link do Google Maps" autocomplete="off">
          <button id="icm-btn-manual-go" class="icm-btn-primary">Buscar</button>
        </div>
        <p id="icm-manual-error" class="icm-hidden"></p>
        <button id="icm-btn-use-auto" class="icm-btn-link">Usar localização automática</button>
      </div>
      <div id="icm-map-section">
        <div id="icm-map-wrap">
          <div id="icm-map"></div>
          <div id="icm-loc-search" class="icm-loc-overlay icm-hidden">
            <div class="icm-loc-search-row">
              <input id="icm-loc-search-input" type="text" placeholder="Endereço ou link do Google Maps" autocomplete="off">
              <button id="icm-loc-search-go" class="icm-btn-primary" type="button">Buscar</button>
              <button id="icm-loc-search-close" class="icm-loc-search-close" type="button" aria-label="Fechar">✕</button>
            </div>
            <p id="icm-loc-search-error" class="icm-loc-search-error icm-hidden"></p>
          </div>
          <div id="icm-loc-preview" class="icm-loc-overlay icm-hidden">
            <p id="icm-loc-preview-label" class="icm-loc-preview-label"></p>
            <p class="icm-loc-preview-hint">Arraste o marcador para ajustar a posição</p>
            <div class="icm-loc-preview-actions">
              <button id="icm-loc-preview-cancel" class="icm-btn-link" type="button">Cancelar</button>
              <button id="icm-loc-preview-confirm" class="icm-btn-primary" type="button">Confirmar localização</button>
            </div>
          </div>
          <div class="icm-map-overlays">
            <button id="icm-btn-center-loc" class="icm-overlay-btn" type="button">
              <span class="icm-overlay-icon" aria-hidden="true">📍</span>
              <span class="icm-overlay-label">Centralizar na minha localização</span>
            </button>
            <button id="icm-btn-change-loc" class="icm-overlay-btn" type="button">
              <span class="icm-overlay-icon" aria-hidden="true">✏️</span>
              <span class="icm-overlay-label">Inserir outro endereço</span>
            </button>
          </div>
        </div>
        <div id="icm-toolbar">
          <span id="icm-count"></span>
          <div id="icm-sort-bar">
            <span class="icm-sort-label">Ordenar:</span>
            <button class="icm-chip icm-chip-active" data-sort="dist-asc">Mais próximo</button>
            <button class="icm-chip" data-sort="dist-desc">Mais distante</button>
            <button class="icm-chip" data-sort="name">A–Z</button>
          </div>
          <div id="icm-group-bar" class="icm-hidden">
            <span class="icm-sort-label">Modo: <span id="icm-group-help" class="icm-help-icon" title="Clique para saber mais">ℹ️</span></span>
            <button class="icm-chip icm-chip-active" data-group-mode="centroid" title="Cinema mais próximo do ponto médio entre os amigos">Centroide</button>
            <button class="icm-chip" data-group-mode="per-friend" title="Mostra a distância de cada amigo em cada cinema">Por Amigo</button>
          </div>
          <button id="icm-btn-group-toggle" class="icm-btn-small">👥 Grupo</button>
        </div>
      </div>
      <div id="icm-group-modal" class="icm-hidden">
        <div class="icm-group-panel">
          <div class="icm-group-header">
            <h3>Buscar cinema para o grupo</h3>
            <button id="icm-group-close" class="icm-group-close">✕</button>
          </div>
          <div class="icm-group-content">
            <div class="icm-group-section">
              <label>Adicionar endereço do amigo:</label>
              <div class="icm-manual-row">
                <input id="icm-group-search" type="text" placeholder="Endereço ou link do Google Maps" autocomplete="off">
                <button id="icm-group-add-btn" class="icm-btn-primary">Adicionar</button>
              </div>
              <button id="icm-group-pin-drop" class="icm-btn-link">ou marque no mapa</button>
              <p id="icm-group-search-error" class="icm-group-search-error icm-hidden"></p>
            </div>
            <div id="icm-group-list" class="icm-group-list"></div>
            <div style="display: flex; gap: 8px; margin-top: 12px;">
              <button id="icm-group-done" class="icm-btn-primary" style="flex: 1;">Pronto</button>
              <button id="icm-group-exit" class="icm-btn-link" style="white-space: nowrap;">Sair</button>
            </div>
          </div>
        </div>
      </div>
      <div id="icm-help-modal" class="icm-hidden">
        <div class="icm-group-panel">
          <div class="icm-group-header">
            <h3>Como funcionam os modos</h3>
            <button id="icm-help-close" class="icm-group-close">✕</button>
          </div>
          <div class="icm-group-content">
            <div class="icm-help-item">
              <h4>📍 Centroide</h4>
              <p>Encontra o cinema mais próximo do ponto médio entre todos os amigos. Ideal para dividir a distância igualmente.</p>
            </div>
            <div class="icm-help-item">
              <h4>👥 Por Amigo</h4>
              <p>Cada amigo recebe uma cor. O pin do cinema mais próximo dele fica na mesma cor (amarelo continua reservado ao centroide). Distâncias aparecem nos cards e no mapa — ★ marca o cinema ideal daquele amigo.</p>
            </div>
          </div>
        </div>
      </div>`;

    panel.querySelector('#icm-btn-retry').addEventListener('click', () => {
      cachedCinemas = null;
      loadData();
    });
    panel.querySelector('#icm-btn-manual-err').addEventListener('click', showManualInput);
    panel.querySelector('#icm-btn-manual-loading').addEventListener('click', showManualInput);
    panel.querySelector('#icm-btn-use-auto').addEventListener('click', runAutoLocation);
    panel.querySelector('#icm-btn-center-loc').addEventListener('click', () => {
      if (!leafletMap) return;
      const marker = locationPreviewActive ? previewMarker : userMarker;
      if (marker) leafletMap.setView(marker.getLatLng(), 14);
    });
    panel.querySelector('#icm-btn-change-loc').addEventListener('click', showManualInput);
    panel.querySelector('#icm-btn-manual-go').addEventListener('click', submitManualLocation);
    panel.querySelector('#icm-manual-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') submitManualLocation();
    });
    panel.querySelector('#icm-loc-search-go').addEventListener('click', submitLocationSearch);
    panel.querySelector('#icm-loc-search-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') submitLocationSearch();
    });
    panel.querySelector('#icm-loc-search-close').addEventListener('click', () => {
      closeLocationSearch();
      setMapOverlayVisibility(true);
    });
    panel.querySelector('#icm-loc-preview-confirm').addEventListener('click', confirmLocationPreview);
    panel.querySelector('#icm-loc-preview-cancel').addEventListener('click', () => cancelLocationPreview(true));
    panel.querySelector('#icm-btn-group-toggle').addEventListener('click', toggleGroupMode);
    panel.querySelector('#icm-group-close').addEventListener('click', closeGroupModal);
    panel.querySelector('#icm-group-done').addEventListener('click', closeGroupModal);
    panel.querySelector('#icm-group-exit').addEventListener('click', exitGroupMode);
    panel.querySelector('#icm-group-add-btn').addEventListener('click', addFriendLocation);
    panel.querySelector('#icm-group-search').addEventListener('keydown', e => {
      if (e.key === 'Enter') addFriendLocation();
    });
    panel.querySelector('#icm-group-pin-drop').addEventListener('click', enablePinDrop);
    panel.querySelectorAll('[data-group-mode]').forEach(chip => {
      chip.addEventListener('click', () => {
        if (friendLocations.length === 0) return;
        panel.querySelectorAll('[data-group-mode]').forEach(c => c.classList.remove('icm-chip-active'));
        chip.classList.add('icm-chip-active');
        currentGroupMode = chip.dataset.groupMode;
        refreshMapDisplay();
      });
    });
    panel.querySelectorAll('.icm-chip[data-sort]').forEach(chip => {
      chip.addEventListener('click', () => {
        panel.querySelectorAll('.icm-chip[data-sort]').forEach(c => c.classList.remove('icm-chip-active'));
        chip.classList.add('icm-chip-active');
        currentSort = chip.dataset.sort;
        reSort();
      });
    });

    const helpModal = panel.querySelector('#icm-help-modal');
    panel.querySelector('#icm-group-help').addEventListener('click', () => {
      if (helpModal) helpModal.classList.toggle('icm-hidden');
    });
    panel.querySelector('#icm-help-close').addEventListener('click', () => {
      if (helpModal) helpModal.classList.add('icm-hidden');
    });
    if (helpModal) {
      helpModal.addEventListener('click', (e) => {
        if (e.target === helpModal) helpModal.classList.add('icm-hidden');
      });
    }

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
    watchForCityChanges();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
