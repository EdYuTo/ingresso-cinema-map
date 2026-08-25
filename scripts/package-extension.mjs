#!/usr/bin/env node
/**
 * Build store packages from extension source files (Chrome .zip + Firefox .xpi).
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

/** Fail the build if any of these appear in the store zip. */
const FORBIDDEN_ZIP_PATTERNS = [
  /^fixtures\//,
  /^scripts\//,
  /^node_modules\//,
  /^docs\//,
  /^\.github\//,
  /^\.playwright-/,
  /\/\.env/,
  /movie-page\.html$/,
  /theaters-city-/,
  /city-sao-paulo\.json$/,
  /package\.json$/,
  /package-lock\.json$/,
];

for (const rel of PACKAGE_PATHS) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    console.error(`Missing required path: ${rel}`);
    process.exit(1);
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version;
const zipName = `ingresso-cinema-map-v${version}.zip`;
const xpiName = `ingresso-cinema-map-v${version}.xpi`;

fs.mkdirSync(DIST, { recursive: true });

for (const entry of fs.readdirSync(DIST)) {
  if (entry.endsWith('.zip') || entry.endsWith('.xpi')) {
    fs.unlinkSync(path.join(DIST, entry));
  }
}

const zipArgs = PACKAGE_PATHS.map((rel) => `"${rel}"`).join(' ');
const zipPath = path.join(DIST, zipName);
const xpiPath = path.join(DIST, xpiName);

for (const packagePath of [zipPath, xpiPath]) {
  execSync(`zip -r "${packagePath}" ${zipArgs} -x "*.DS_Store"`, {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

function listZipEntries(zipFile) {
  const listing = execSync(`unzip -Z1 "${zipFile}"`, { encoding: 'utf8' });
  return listing.split('\n').map(line => line.trim()).filter(Boolean);
}

function assertCleanStoreZip(zipFile) {
  const entries = listZipEntries(zipFile);
  const forbidden = entries.filter(entry =>
    FORBIDDEN_ZIP_PATTERNS.some(pattern => pattern.test(entry)),
  );

  if (forbidden.length > 0) {
    console.error('Store zip contains files that must not be published:');
    for (const entry of forbidden) console.error(`  - ${entry}`);
    process.exit(1);
  }

  const allowedRoots = new Set(PACKAGE_PATHS.map(p => p.replace(/\/.*$/, '')));
  const unexpected = entries.filter((entry) => {
    const root = entry.split('/')[0];
    return !PACKAGE_PATHS.includes(entry) && !allowedRoots.has(root);
  });

  if (unexpected.length > 0) {
    console.error('Store zip contains paths outside the publish allowlist:');
    for (const entry of unexpected) console.error(`  - ${entry}`);
    process.exit(1);
  }

  console.log(`Verified ${entries.length} paths (${PACKAGE_PATHS.length} top-level allowlist entries)`);
  console.log('Allowlist:', PACKAGE_PATHS.join(', '));
}

assertCleanStoreZip(zipPath);
assertCleanStoreZip(xpiPath);

console.log(`Created ${zipPath} (${fs.statSync(zipPath).size} bytes)`);
console.log(`Created ${xpiPath} (${fs.statSync(xpiPath).size} bytes)`);
