import { Builder } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { ServiceBuilder } from 'selenium-webdriver/firefox.js';
import { firefox as playwrightFirefox } from 'playwright';
import { download as downloadGeckodriver } from 'geckodriver';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { prepareFirefoxTestExtension, startFixtureServer } from './fixture-server.mjs';

let geckodriverPathPromise = null;

async function getGeckodriverPath() {
  if (!geckodriverPathPromise) {
    geckodriverPathPromise = downloadGeckodriver();
  }
  return geckodriverPathPromise;
}

function resolveFirefoxBinary() {
  if (process.env.FIREFOX_BIN) return process.env.FIREFOX_BIN;

  const macSystem = '/Applications/Firefox.app/Contents/MacOS/firefox';
  if (process.platform === 'darwin' && fs.existsSync(macSystem)) return macSystem;

  return playwrightFirefox.executablePath();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function zipExtensionDir(extensionDir) {
  const xpiPath = path.join(os.tmpdir(), `icm-firefox-fixture-${Date.now()}.xpi`);
  execSync(`zip -qr "${xpiPath}" . -x "*.DS_Store"`, { cwd: extensionDir, stdio: 'pipe' });
  return xpiPath;
}

class SeleniumPage {
  constructor(driver) {
    this.driver = driver;
  }

  async goto(url, { waitUntil = 'domcontentloaded' } = {}) {
    await this.driver.get(url);
    if (waitUntil === 'domcontentloaded') {
      await this.driver.wait(async () => {
        const state = await this.driver.executeScript('return document.readyState');
        return state === 'interactive' || state === 'complete';
      }, 120000);
    }
  }

  async addStyleTag({ content }) {
    await this.driver.executeScript(
      `(function(){var s=document.createElement('style');s.textContent=${JSON.stringify(content)};document.head.appendChild(s);})()`,
    );
  }

  async waitForSelector(selector, { state = 'visible', timeout = 30000 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const exists = await this.driver.executeScript(
        sel => !!document.querySelector(sel),
        selector,
      );
      if (!exists) {
        await sleep(100);
        continue;
      }
      if (state === 'attached') return;

      const visible = await this.driver.executeScript(function(sel) {
        const el = document.querySelector(sel);
        if (!el) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      }, selector);
      if (visible) return;
      await sleep(100);
    }
    throw new Error(`waitForSelector timeout: ${selector}`);
  }

  async waitForFunction(pageFunction, arg, { timeout = 30000 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const ok = await this.driver.executeScript(pageFunction, arg);
      if (ok) return;
      await sleep(200);
    }
    throw new Error('waitForFunction timeout');
  }

  locator(selector) {
    const driver = this.driver;
    return {
      async click({ force = false } = {}) {
        const el = await driver.findElement({ css: selector });
        if (force) {
          await driver.executeScript('arguments[0].click()', el);
        } else {
          await el.click();
        }
      },
      async fill(value) {
        const el = await driver.findElement({ css: selector });
        await el.clear();
        await el.sendKeys(value);
      },
      async isVisible({ timeout = 1000 } = {}) {
        try {
          await driver.wait(async () => {
            const el = await driver.findElement({ css: selector });
            return el.isDisplayed();
          }, timeout);
          return true;
        } catch {
          return false;
        }
      },
      async textContent() {
        const el = await driver.findElement({ css: selector });
        return el.getText();
      },
      async inputValue() {
        const el = await driver.findElement({ css: selector });
        return el.getAttribute('value');
      },
      async allTextContents() {
        const els = await driver.findElements({ css: selector });
        return Promise.all(els.map(el => el.getText()));
      },
      async count() {
        const els = await driver.findElements({ css: selector });
        return els.length;
      },
    };
  }

  async evaluate(pageFunction, arg) {
    return this.driver.executeScript(pageFunction, arg);
  }

  waitForTimeout(ms) {
    return sleep(ms);
  }
}

class SeleniumContext {
  constructor(driver, fixtureServer) {
    this.driver = driver;
    this.fixtureServer = fixtureServer;
    this._pages = [new SeleniumPage(driver)];
  }

  pages() {
    return this._pages;
  }

  async close() {
    await this.driver.quit().catch(() => {});
    await this.fixtureServer.close().catch(() => {});
  }
}

export async function launchFirefoxExtensionContext() {
  const fixtureServer = await startFixtureServer();
  const extensionDir = prepareFirefoxTestExtension(fixtureServer.origin);
  const xpiPath = zipExtensionDir(extensionDir);

  const options = new firefox.Options();
  options.setBinary(resolveFirefoxBinary());
  options.setPreference('xpinstall.signatures.required', false);
  options.setPreference('datareporting.policy.firstRunURL', '');
  options.setPreference('termsofuse.bypassNotification', true);
  options.setPreference('geo.enabled', false);
  options.setPreference('geo.prompt.testing', true);
  options.setPreference('geo.prompt.testing.allow', false);

  const service = new ServiceBuilder(await getGeckodriverPath());
  const driver = await new Builder()
    .forBrowser('firefox')
    .setFirefoxOptions(options)
    .setFirefoxService(service)
    .build();

  await driver.manage().window().setRect({ width: 1360, height: 900, x: 0, y: 0 });
  await driver.installAddon(xpiPath, true);
  fs.unlinkSync(xpiPath);

  const context = new SeleniumContext(driver, fixtureServer);
  const page = context.pages()[0];
  return { context, page, movieUrl: fixtureServer.movieUrl };
}

export async function waitForFirefoxExtension() {
  await sleep(1500);
  console.log('  ✓ Extension loaded');
}

export async function openFirefoxFixturePage(page, movieUrl) {
  // Seed city cookie on the fixture origin before the movie page loads.
  const origin = new URL(movieUrl).origin;
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    document.cookie = `SiteCity=${encodeURIComponent(JSON.stringify({
      Id: '1', Name: 'São Paulo', UrlKey: 'sao-paulo', UF: 'SP', State: 'São Paulo',
    }))}; path=/`;
    document.cookie = 'ingressoCookieConsent=true; path=/';
    document.cookie = 'dcuc=true; path=/';
  });

  await page.goto(movieUrl, { waitUntil: 'domcontentloaded' });
  await page.addStyleTag({
    content: '.CookieConsent, [class*="CookieConsent"] { display: none !important; }',
  });
}

export async function resolveViaBackgroundFirefox(page, url) {
  return page.evaluate(async (shortUrl) => {
    const requestId = `test-${Date.now()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        reject(new Error('Tempo limite ao resolver o link curto.'));
      }, 20000);

      function onMessage(event) {
        if (event.source !== window || event.data?.type !== 'icm-resolve-short-link-response') return;
        if (event.data.requestId !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        const resp = event.data.resp;
        if (resp?.success) resolve(resp.resolvedUrl);
        else reject(new Error(resp?.error || event.data.error || 'Resolver failed'));
      }

      window.addEventListener('message', onMessage);
      window.postMessage({ type: 'icm-resolve-short-link-request', requestId, url: shortUrl }, '*');
    });
  }, url);
}
