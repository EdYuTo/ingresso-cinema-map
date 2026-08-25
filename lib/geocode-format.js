/**
 * Pure helpers: Google Maps / share-link address strings → Nominatim queries.
 * Loaded as a classic script in the extension (globalThis.IcmGeocodeFormat)
 * and required from Node unit tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.IcmGeocodeFormat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TITLE_ABBREVIATIONS = [
    [/(\b)Dra\.\s*/gi, '$1Doutora '],
    [/(\b)Dr\.\s*/gi, '$1Doutor '],
    [/(\b)Prof\.\s*/gi, '$1Professor '],
    [/(\b)Eng\.\s*/gi, '$1Engenheiro '],
    [/(\b)Pres\.\s*/gi, '$1Presidente '],
    [/(\b)Sen\.\s*/gi, '$1Senador '],
    [/(\b)Des\.\s*/gi, '$1Desembargador '],
    [/(\b)Brig\.\s*/gi, '$1Brigadeiro ']
  ];

  function decodeMapsText(text) {
    return decodeURIComponent(String(text).replace(/\+/g, ' ')).trim();
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

  function expandTitleAbbreviations(text) {
    let out = String(text);
    for (const [pattern, replacement] of TITLE_ABBREVIATIONS) {
      out = out.replace(pattern, replacement);
    }
    return out.replace(/\s{2,}/g, ' ').trim();
  }

  function expandAddressAbbreviations(text) {
    return expandTitleAbbreviations(expandStreetAbbreviations(text));
  }

  function stripTrailingCep(address) {
    return String(address)
      .replace(/,?\s*\d{5}-?\d{3}\s*$/i, '')
      .replace(/,\s*$/, '')
      .trim();
  }

  function ensureBrasilSuffix(query) {
    const trimmed = String(query).trim();
    if (!trimmed) return trimmed;
    if (/,\s*Brasil\s*$/i.test(trimmed) || /\bBrasil\s*$/i.test(trimmed)) return trimmed;
    return `${trimmed}, Brasil`;
  }

  function formatGoogleAddressForGeocode(raw) {
    const decoded = decodeMapsText(raw);
    let segments = decoded.split(',').map(s => s.trim()).filter(Boolean);
    if (!segments.length) {
      return { query: decoded, street: null, city: null, uf: null, neighborhood: null };
    }

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
    let neighborhood = null;
    if (segments.length >= 2) {
      const tail = segments[segments.length - 1];
      const numNeighborhood = tail.match(/^(\d+)\s*-\s*(.+)$/);
      const bareNumber = tail.match(/^(\d+)$/);
      if (numNeighborhood) {
        streetNumber = numNeighborhood[1];
        neighborhood = numNeighborhood[2].trim() || null;
        segments.pop();
      } else if (bareNumber) {
        streetNumber = bareNumber[1];
        segments.pop();
      }
    }

    let street = expandAddressAbbreviations(segments.join(', '));
    if (streetNumber) street = `${street} ${streetNumber}`.trim();
    street = street || null;

    const parts = [];
    if (street) parts.push(street);
    if (neighborhood) parts.push(expandAddressAbbreviations(neighborhood));

    if (city && uf) {
      parts.push(city, uf, 'Brasil');
      return { query: parts.join(', '), street, city, uf, neighborhood };
    }
    return {
      query: parts.join(', ') || decoded,
      street,
      city: null,
      uf: null,
      neighborhood
    };
  }

  /** Free-form fallbacks after structured search: formatted → lightly cleaned original. */
  function buildGeocodeQueryFallbacks(raw, formatted) {
    const primary = formatted || formatGoogleAddressForGeocode(raw);
    const decoded = decodeMapsText(raw);
    const withoutCep = stripTrailingCep(decoded);
    const expandedWithoutCep = expandAddressAbbreviations(withoutCep);

    const candidates = [];
    const seen = new Set();
    function add(query) {
      const q = String(query || '').trim();
      if (!q || seen.has(q)) return;
      seen.add(q);
      candidates.push(q);
    }

    add(primary.query);
    add(ensureBrasilSuffix(expandedWithoutCep));

    return candidates;
  }

  return {
    decodeMapsText,
    expandStreetAbbreviations,
    expandTitleAbbreviations,
    expandAddressAbbreviations,
    formatGoogleAddressForGeocode,
    buildGeocodeQueryFallbacks
  };
});
