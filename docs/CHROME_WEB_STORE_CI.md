# Chrome Web Store CI

## Workflows

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| **Test** (`.github/workflows/test.yml`) | PR or push to `main` | Runs Playwright fixture tests |
| **Release** (`.github/workflows/release.yml`) | **Manual only** (`workflow_dispatch`) | Tests → release notes → git tag → GitHub Release → optional Chrome Web Store upload |

**Release does not run automatically on merge.** You control when to ship.

## Release process

1. Bump `version` in `manifest.json` on a PR and merge to `main`
2. Confirm **Test** passed on `main`
3. Add Chrome Web Store secrets (see below) when ready to ship
4. **Actions → Release → Run workflow**
   - Leave **Skip Chrome Web Store upload** checked until secrets are configured (creates tag + GitHub Release only)
   - Uncheck it when secrets are ready to upload and publish

The release job will:

1. Collect commits since the previous `v*` tag
2. Write `dist/release-notes.md` (GitHub) and `dist/release-notes-store.txt` (Chrome Web Store)
3. Create annotated tag `v{manifest.version}` and push it
4. Create a [GitHub Release](https://docs.github.com/en/repositories/releasing-projects-on-github) with the zip attached
5. Upload/publish to Chrome Web Store (unless skipped)
6. Post store release notes in the job summary — **paste these manually** in the Developer Dashboard (the API cannot set per-version release notes)

Preview notes locally:

```bash
npm run release-notes
```

## One-time setup

### 1. Create the extension in Chrome Web Store

Upload the first version manually (or via `npm run package` + dashboard upload) so you have an **Extension ID** (32-character string from `chrome://extensions` or the developer dashboard URL).

`npm run package` ships only the extension allowlist (`manifest.json`, scripts, `icons/`, `lib/`). Test fixtures and dev files are excluded and verified before the zip is written.

### 2. Enable the Chrome Web Store API

1. Open [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project
3. Enable **Chrome Web Store API**
4. Configure **OAuth consent screen** (External is fine for a personal developer account)
5. Create **OAuth client ID** → Application type: **Desktop app**
6. Note the **Client ID** and **Client Secret**

### 3. Generate a refresh token

Follow [chrome-webstore-upload-keys](https://github.com/fregante/chrome-webstore-upload/blob/main/How%20to%20generate%20Google%20API%20keys.md):

1. Open the authorization URL (replace `YOUR_CLIENT_ID`):

   ```
   https://accounts.google.com/o/oauth2/auth?response_type=code&scope=https://www.googleapis.com/auth/chromewebstore&client_id=YOUR_CLIENT_ID&redirect_uri=urn:ietf:wg:oauth:2.0:oob
   ```

2. Sign in with the **same Google account** used for the Chrome Web Store developer account
3. Copy the authorization code
4. Exchange it for a refresh token:

   ```bash
   curl "https://accounts.google.com/o/oauth2/token" \
     -d "client_id=YOUR_CLIENT_ID" \
     -d "client_secret=YOUR_CLIENT_SECRET" \
     -d "code=AUTHORIZATION_CODE" \
     -d "grant_type=authorization_code" \
     -d "redirect_uri=urn:ietf:wg:oauth:2.0:oob"
   ```

5. Save the `refresh_token` from the response (it is shown only once)

### 4. Find your Publisher ID

In the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole), open **Account** → **Publisher ID** (format like `publisher-xxxxxxxxxxxxxxxx`).

### 5. Add GitHub secrets

In the repo: **Settings → Secrets and variables → Actions → New repository secret**

| Secret | Description |
|--------|-------------|
| `CHROME_EXTENSION_ID` | 32-character extension ID |
| `CHROME_CLIENT_ID` | OAuth client ID from Google Cloud |
| `CHROME_CLIENT_SECRET` | OAuth client secret |
| `CHROME_REFRESH_TOKEN` | Long-lived refresh token |
| `CHROME_PUBLISHER_ID` | Publisher ID from the developer dashboard |

The release workflow uses the `production` GitHub Environment so you can add required reviewers before releases if desired (**Settings → Environments → production**).

## Local commands

```bash
npm test              # fixture integration tests
npm run package       # build dist/ingresso-cinema-map-vX.Y.Z.zip (allowlist only; no fixtures)
npm run release-notes # preview changelog for current manifest.json version
```

## Manual publish (optional)

```bash
npm run package
export EXTENSION_ID=...
export CLIENT_ID=...
export CLIENT_SECRET=...
export REFRESH_TOKEN=...
export PUBLISHER_ID=...
npx chrome-webstore-upload upload --source dist/*.zip
npx chrome-webstore-upload publish
```
