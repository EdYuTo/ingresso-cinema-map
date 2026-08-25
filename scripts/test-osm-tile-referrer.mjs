#!/usr/bin/env node
/**
 * Regression guard for #29: OSM tiles 403r when Referer is omitted.
 * ingresso.com sends Referrer-Policy: same-origin, so cross-origin tile
 * requests need an explicit Leaflet referrerPolicy to send a Referer.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'inpage.js'), 'utf8');

const tileLayerMatch = src.match(
  /L\.tileLayer\(\s*'https:\/\/\{s\}\.tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png'\s*,\s*\{([\s\S]*?)\}\s*\)/,
);

if (!tileLayerMatch) {
  console.error('✗ Could not find OSM tileLayer call in inpage.js');
  process.exit(1);
}

const options = tileLayerMatch[1];
const hasPolicy = /referrerPolicy\s*:\s*['"]strict-origin-when-cross-origin['"]/.test(options);

if (!hasPolicy) {
  console.error(
    "✗ OSM tileLayer missing referrerPolicy: 'strict-origin-when-cross-origin'",
  );
  console.error(
    '  (Firefox + same-origin Referrer-Policy omits Referer → OSM 403r)',
  );
  process.exit(1);
}

console.log("✓ OSM tileLayer sets referrerPolicy: 'strict-origin-when-cross-origin'");
