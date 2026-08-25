#!/usr/bin/env node
/**
 * Firefox integration tests for Ingresso Cinema Map (Selenium + geckodriver).
 *
 * Usage: npm run test:firefox
 */

import { createReporter } from './lib/test-harness.mjs';
import {
  launchFirefoxExtensionContext,
  waitForFirefoxExtension,
  openFirefoxFixturePage,
  resolveViaBackgroundFirefox,
} from './lib/selenium-harness.mjs';
import { runExtensionTests } from './run-extension-tests.mjs';

process.env.CI = 'true';

const report = createReporter();

console.log('Launching Firefox with extension and local Ingresso fixture…');
const { context, page, movieUrl } = await launchFirefoxExtensionContext();

try {
  await waitForFirefoxExtension();
  await openFirefoxFixturePage(page, movieUrl);

  const failures = await runExtensionTests({
    page,
    resolveViaBackground: (url) => resolveViaBackgroundFirefox(page, url),
    report,
  });

  if (failures > 0) process.exitCode = 1;
} catch (err) {
  console.error('\nFatal:', err.message);
  process.exitCode = 1;
} finally {
  await context.close();
}
