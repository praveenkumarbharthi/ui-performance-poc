'use strict';

const { defineConfig, devices } = require('@playwright/test');
const path = require('path');
const config = require('./src/config');

/**
 * Playwright configuration.
 *
 * Reporters produce the three required formats:
 *   - HTML  -> reports/playwright/html
 *   - JSON  -> reports/playwright/results.json
 *   - JUnit -> reports/junit/results.xml
 *
 * Raw per-run artifacts (traces, screenshots) go into reports/raw/<runId>.
 * Artifacts are only kept on failure to avoid bulky output.
 */
module.exports = defineConfig({
  testDir: './tests',
  timeout: 120_000,
  expect: { timeout: 15_000 },

  // A single-user journey; keep execution deterministic and sequential.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,

  reporter: [
    ['list'],
    ['html', { outputFolder: config.paths.playwright.html, open: 'never' }],
    ['json', { outputFile: config.paths.playwright.json }],
    ['junit', { outputFile: config.paths.junit }],
  ],

  use: {
    baseURL: config.baseUrl,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  outputDir: path.join(config.paths.raw, config.runId, 'test-artifacts'),
});
