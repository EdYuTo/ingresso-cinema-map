#!/usr/bin/env node
/**
 * Build release notes from git history since the previous version tag.
 *
 * Reads version from manifest.json, expects the new tag to be v{version},
 * and writes:
 *   dist/release-notes.md        — GitHub Release (Markdown)
 *   dist/release-notes-store.txt — Chrome Web Store (plain text)
 *
 * Usage: npm run release-notes
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version;
const tag = `v${version}`;

function run(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function listVersionTags() {
  try {
    return run('git tag -l "v*" --sort=-v:refname').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function assertTagAvailable(tags) {
  if (tags.includes(tag)) {
    console.error(`Tag ${tag} already exists. Bump version in manifest.json before releasing.`);
    process.exit(1);
  }
}

function previousTag(tags) {
  return tags[0] ?? null;
}

function collectCommits(sinceTag) {
  const range = sinceTag ? `${sinceTag}..HEAD` : 'HEAD';
  const raw = run(`git log ${range} --pretty=format:%s%x09%h --no-merges --reverse`);
  if (!raw) return [];
  return raw.split('\n').map((line) => {
    const tab = line.lastIndexOf('\t');
    return {
      subject: line.slice(0, tab),
      hash: line.slice(tab + 1),
    };
  });
}

const tags = listVersionTags();
assertTagAvailable(tags);
const prevTag = previousTag(tags);
const commits = collectCommits(prevTag);

const md = [
  `# Ingresso Cinema Map v${version}`,
  '',
  prevTag ? `Changes since ${prevTag}:` : 'Initial release:',
  '',
  ...(commits.length
    ? commits.map(({ subject, hash }) => `- ${subject} (${hash})`)
    : ['- Maintenance release']),
  '',
].join('\n');

const store = commits.length
  ? commits.map(({ subject }) => `• ${subject}`).join('\n')
  : 'Maintenance release';

fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, 'release-notes.md'), md);
fs.writeFileSync(path.join(DIST, 'release-notes-store.txt'), `${store}\n`);

console.log(md);
console.log(`\nWrote dist/release-notes.md and dist/release-notes-store.txt`);
if (prevTag) console.log(`Previous tag: ${prevTag}`);
console.log(`Next tag: ${tag}`);
