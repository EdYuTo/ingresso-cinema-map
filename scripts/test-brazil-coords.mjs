#!/usr/bin/env node
/**
 * Unit tests for Brazil geolocation bbox sanity check.
 * Usage: node scripts/test-brazil-coords.mjs
 */

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { isPlausiblyInBrazilBBox } = require(path.join(__dirname, '..', 'lib', 'brazil-coords.js'));

/** Mirrors inpage.js: isValidCoord + shared bbox (no duplicated Number.isFinite in lib). */
function isValidCoord(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function isPlausiblyInBrazil(lat, lng) {
  return isValidCoord(lat, lng) && isPlausiblyInBrazilBBox(lat, lng);
}

let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('isPlausiblyInBrazil');

// São Paulo (valid)
assert('São Paulo coords accepted', isPlausiblyInBrazil(-23.5505, -46.6333));

// Instituto Moreira Salles bug: missing minus on lng → Madagascar
assert(
  'Moreira Salles API bug (positive lng) rejected',
  !isPlausiblyInBrazil(-23.55609, 46.66197),
);

// Brazil extremes (approx bbox edges, inclusive)
assert('southern tip accepted', isPlausiblyInBrazil(-34, -52));
assert('northern tip accepted', isPlausiblyInBrazil(6, -60));
assert('western tip accepted', isPlausiblyInBrazil(-10, -74));
assert('eastern tip accepted', isPlausiblyInBrazil(-8, -34));

// Outside bbox
assert('just south of Brazil rejected', !isPlausiblyInBrazil(-34.1, -52));
assert('just north of Brazil rejected', !isPlausiblyInBrazil(6.1, -60));
assert('just west of Brazil rejected', !isPlausiblyInBrazil(-10, -74.1));
assert('just east of Brazil rejected', !isPlausiblyInBrazil(-8, -33.9));
assert('null island rejected', !isPlausiblyInBrazil(0, 0));
assert('NaN rejected', !isPlausiblyInBrazil(NaN, -46));
assert('non-finite rejected', !isPlausiblyInBrazil(-23, Infinity));

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nAll brazil-coords assertions passed');
}
