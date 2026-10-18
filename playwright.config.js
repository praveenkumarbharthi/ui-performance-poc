'use strict';

const { defineConfig, devices } = require('@playwright/test');
const path = require('path');
const config = require('./src/config');

module.exports = defineConfig({
  testDir: './tests',
  // Only Playwright specs; node:test unit files live under tests/unit/*.test.js.
  testMatch: '**/*.spec.js',
  timeout: 120_000,
  expect: { timeout: 15_000 },

  // A single-user journey: keep execution sequential and deterministic.
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
    // SauceDemo exposes its hooks as data-test, not Playwright's default data-testid.
    testIdAttribute: 'data-test',
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
