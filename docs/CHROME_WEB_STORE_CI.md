# Chrome Web Store CI

Two GitHub Actions workflows automate testing and publishing.

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| **Test** (`.github/workflows/test.yml`) | Pull request → `main` | Runs Playwright fixture tests |
| **Publish** (`.github/workflows/publish.yml`) | Push to `main` (after merge) | Re-runs tests, builds zip, uploads + publishes to Chrome Web Store |

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

The publish workflow uses the `production` GitHub Environment so you can add required reviewers before releases if desired (**Settings → Environments → production**).

## Version bumps

Each Chrome Web Store upload requires a **new version** in `manifest.json`. Bump `version` before merging to `main`, or the publish step will fail.

## Local commands

```bash
npm test              # fixture integration tests
npm run package       # build dist/ingresso-cinema-map-vX.Y.Z.zip (allowlist only; no fixtures)
```

The package script uses an explicit allowlist of extension files and fails if `fixtures/`, `scripts/`, tests, or other dev-only paths appear in the zip.

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
