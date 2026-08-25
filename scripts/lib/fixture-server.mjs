import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '../..');
const FIXTURES = path.join(ROOT, 'fixtures', 'ingresso');

function stripScripts(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '');
}

const MOCK_NOMINATIM = {
  belasArtes: [{
    lat: '-23.5558',
    lon: '-46.6626',
    display_name: 'Rua da Consolação, 2423, Consolação, São Paulo, SP, Brasil',
  }, {
    lat: '-23.5505',
    lon: '-46.6333',
    display_name: 'Consolação, São Paulo, SP, Brasil',
  }],
  museu: [{
    lat: '-23.5756',
    lon: '-46.6889',
    display_name: 'Av. Europa, 158, Jardim Europa, São Paulo, SP, Brasil',
  }],
  cinusp: [{
    lat: '-23.561414',
    lon: '-46.730982',
    display_name: 'CINUSP Paulo Emílio, São Paulo, SP, Brasil',
  }],
};

const tilePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAD0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let fixtureHtmlCache = null;

function loadFixtureHtml() {
  if (!fixtureHtmlCache) {
    const raw = fs.readFileSync(path.join(FIXTURES, 'movie-page.html'), 'utf8');
    fixtureHtmlCache = stripScripts(raw);
  }
  return fixtureHtmlCache;
}

function send(res, status, contentType, body) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function handleRequest(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    return res.end();
  }

  if (pathname === '/' || pathname === '') {
    return send(res, 200, 'text/html; charset=utf-8', '<!doctype html><title>icm-fixture</title>');
  }

  if (pathname.startsWith('/filme/')) {
    return send(res, 200, 'text/html; charset=utf-8', loadFixtureHtml());
  }

  if (pathname.startsWith('/v0/theaters/city/')) {
    const body = fs.readFileSync(path.join(FIXTURES, 'theaters-city-1.json'), 'utf8');
    return send(res, 200, 'application/json', body);
  }

  if (pathname.startsWith('/v0/states/city/name/')) {
    const body = fs.readFileSync(path.join(FIXTURES, 'city-sao-paulo.json'), 'utf8');
    return send(res, 200, 'application/json', body);
  }

  if (pathname.startsWith('/nominatim/search')) {
    const q = decodeURIComponent(url.searchParams.get('q') || '').toLowerCase();
    let body = MOCK_NOMINATIM.belasArtes;
    if (q.includes('europa') || q.includes('museu')) body = MOCK_NOMINATIM.museu;
    if (q.includes('cinusp') || q.includes('paulo emílio') || q.includes('paulo emilio')) {
      body = MOCK_NOMINATIM.cinusp;
    }
    return send(res, 200, 'application/json', JSON.stringify(body));
  }

  if (pathname.startsWith('/tiles/')) {
    return send(res, 200, 'image/png', tilePng);
  }

  send(res, 404, 'text/plain', 'not found');
}

/** @returns {Promise<{ origin: string, movieUrl: string, close: () => Promise<void> }>} */
export async function startFixtureServer() {
  const server = http.createServer(handleRequest);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    movieUrl: `${origin}/filme/homem-aranha-um-novo-dia?city=sao-paulo`,
    close: () => new Promise((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()));
    }),
  };
}

/**
 * Build a Firefox test extension that injects on localhost (no port in matches —
 * Firefox ignores ports in match patterns) and rewrites absolute API URLs to the
 * local fixture server.
 */
export function prepareFirefoxTestExtension(serverOrigin) {
  const extDir = path.join(ROOT, '.test-extension-firefox');
  fs.rmSync(extDir, { recursive: true, force: true });
  fs.mkdirSync(extDir, { recursive: true });

  const packagePaths = [
    'background.js',
    'content-bridge.js',
    'inpage.css',
    'icons',
    'lib',
  ];

  for (const rel of packagePaths) {
    fs.cpSync(path.join(ROOT, rel), path.join(extDir, rel), { recursive: true });
  }

  let inpage = fs.readFileSync(path.join(ROOT, 'inpage.js'), 'utf8');
  inpage = inpage
    .replaceAll(
      'https://api-content.ingresso.com/v0/theaters/city',
      `${serverOrigin}/v0/theaters/city`,
    )
    .replaceAll(
      'https://api-content.ingresso.com/v0/states/city/name',
      `${serverOrigin}/v0/states/city/name`,
    )
    .replaceAll(
      'https://nominatim.openstreetmap.org/search',
      `${serverOrigin}/nominatim/search`,
    )
    .replaceAll(
      'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      `${serverOrigin}/tiles/{z}/{x}/{y}.png`,
    );
  fs.writeFileSync(path.join(extDir, 'inpage.js'), inpage);

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

  // Firefox does not support ports in match patterns — omit the port.
  const localhostFilme = 'http://127.0.0.1/filme/*';
  manifest.host_permissions = [
    ...(manifest.host_permissions || []),
    'http://127.0.0.1/*',
  ];
  for (const script of manifest.content_scripts || []) {
    script.matches = [...new Set([...(script.matches || []), localhostFilme])];
  }

  fs.writeFileSync(path.join(extDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return extDir;
}
