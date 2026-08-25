/**
 * Approximate Brazil bounding box for rejecting bad Ingresso API geolocations
 * (e.g. positive lng mirroring São Paulo into Madagascar).
 *
 * Loaded as a classic script in the extension (globalThis.IcmBrazilCoords)
 * and required from Node unit tests. Bbox only — compose with isValidCoord
 * in the page script.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.IcmBrazilCoords = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function isPlausiblyInBrazilBBox(lat, lng) {
    return lat >= -34 && lat <= 6
      && lng >= -74 && lng <= -34;
  }

  return { isPlausiblyInBrazilBBox };
});
