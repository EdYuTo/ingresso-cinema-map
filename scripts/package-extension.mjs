#!/usr/bin/env node
/**
 * Build a Chrome Web Store zip from extension source files.
 *
 * Usage: npm run package
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const PACKAGE_PATHS = [
  'manifest.json',
  'background.js',
  'content-bridge.js',
  'inpage.js',
  'inpage.css',
  'icons',
  'lib',
];

for (const rel of PACKAGE_PATHS) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    console.error(`Missing required path: ${rel}`);
    process.exit(1);
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const zipName = `ingresso-cinema-map-v${manifest.version}.zip`;

fs.mkdirSync(DIST, { recursive: true });

for (const entry of fs.readdirSync(DIST)) {
  if (entry.endsWith('.zip')) {
    fs.unlinkSync(path.join(DIST, entry));
  }
}

const zipPath = path.join(DIST, zipName);
const zipArgs = PACKAGE_PATHS.map((rel) => `"${rel}"`).join(' ');
execSync(`zip -r "${zipPath}" ${zipArgs} -x "*.DS_Store"`, {
  cwd: ROOT,
  stdio: 'inherit',
});

console.log(`Created ${zipPath} (${fs.statSync(zipPath).size} bytes)`);
