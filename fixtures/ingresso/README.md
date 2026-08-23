# Ingresso test fixtures

Static snapshots used by Playwright tests (`npm test`) so tests do not depend on live ingresso.com HTML.

| File | Description |
|------|-------------|
| `movie-page.html` | Saved movie page DOM (session times + cinema cards) |
| `theaters-city-1.json` | Ingresso theaters API for São Paulo |
| `city-sao-paulo.json` | Ingresso city metadata |

## Refresh fixtures

When Ingresso changes page structure and tests fail to scrape cinemas:

```bash
npm run test:dump-fixture
```

Commit updated files along with any selector fixes in `inpage.js`.

## Test locations

Tests use public venues only (no personal addresses):

- **CINUSP Paulo Emílio** — `share.google` short link
- **Museu da Imagem e do Som** — Google Maps URL with `daddr`
- **Cine Belas Artes** — typed street address
