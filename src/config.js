'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function envBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function envNum(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envPages(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length && parsed.every((p) => p && p.name && p.path)) {
      return parsed.map((p) => ({
        name: String(p.name),
        path: String(p.path),
        requiresAuth: !!p.requiresAuth,
      }));
    }
  } catch (e) {
    // Invalid JSON falls back to the default page list.
  }
  return fallback;
}

// Resolve the run id once and export it via the environment so Playwright
// workers and downstream scripts share it. When RUN_ID was supplied explicitly
// (`runIdFromEnv`), report aggregation trusts it; otherwise it must fall back to
// the most recent raw run directory rather than a freshly generated timestamp.
const runIdFromEnv = !!(process.env.RUN_ID && process.env.RUN_ID.trim());
const runId = runIdFromEnv ? process.env.RUN_ID.trim() : new Date().toISOString().replace(/[:.]/g, '-');
process.env.RUN_ID = runId;

// Reports root is overridable so tests and CI can target an isolated directory
// instead of the machine-specific default.
const reportsDir = process.env.REPORTS_DIR
  ? path.resolve(process.env.REPORTS_DIR)
  : path.join(ROOT, 'reports');

const config = {
  runId,
  runIdFromEnv,
  projectRoot: ROOT,

  baseUrl: (process.env.BASE_URL || 'https://www.saucedemo.com').replace(/\/+$/, ''),

  // Public SauceDemo demo account only - documented, non-secret values. Never
  // use real credentials here.
  credentials: {
    username: process.env.SAUCE_USERNAME || 'standard_user',
    password: process.env.SAUCE_PASSWORD || 'secret_sauce',
  },

  paths: {
    reports: reportsDir,
    raw: path.join(reportsDir, 'raw'),
    playwright: {
      html: path.join(reportsDir, 'playwright', 'html'),
      json: path.join(reportsDir, 'playwright', 'results.json'),
    },
    junit: path.join(reportsDir, 'junit', 'results.xml'),
    browserMetrics: path.join(reportsDir, 'browser-metrics', 'browser-metrics.json'),
    lighthouse: path.join(reportsDir, 'lighthouse'),
    summaryJson: path.join(reportsDir, 'summary.json'),
    summaryMarkdown: path.join(reportsDir, 'SUMMARY.md'),
    dashboard: path.join(reportsDir, 'dashboard.html'),
    runStartedMarker: path.join(reportsDir, 'run-started-at.txt'),
  },

  metrics: {
    // Settle window (ms) after the page readiness point so LCP/CLS can be read.
    // LCP is only final after user input / page hide, so this is an approximation.
    lcpObservationMs: envNum(process.env.LCP_OBSERVATION_MS, 2500),
  },

  lighthouse: {
    // Pages with requiresAuth sit behind the login and are audited with a
    // session cookie obtained by logging in once through Playwright.
    pages: envPages(process.env.LIGHTHOUSE_PAGES, [
      { name: 'login', path: '/', requiresAuth: false },
      { name: 'product-detail', path: '/inventory-item.html?id=4', requiresAuth: true },
      { name: 'cart', path: '/cart.html', requiresAuth: true },
    ]),
    chromePath: process.env.CHROME_PATH || undefined,
    categories: ['performance', 'accessibility', 'best-practices', 'seo'],
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    formFactor: 'desktop',
    screenEmulation: {
      mobile: false,
      width: 1350,
      height: 940,
      deviceScaleFactor: 1,
      disabled: false,
    },
    throttlingMethod: 'simulate',
  },

  // Disabled by default (observation mode); a disabled threshold cannot fail a build.
  thresholds: {
    enabled: envBool(process.env.PERF_THRESHOLDS_ENABLED, false),
    lcpMs: envNum(process.env.THRESHOLD_LCP_MS, null),
    cls: envNum(process.env.THRESHOLD_CLS, null),
    journeyMs: envNum(process.env.THRESHOLD_JOURNEY_MS, null),
  },

  // Only honoured when the baseline file exists and is comparable.
  baseline: {
    file: process.env.BASELINE_FILE || path.join(reportsDir, 'baseline', 'summary.json'),
    // A change below noisePct is `within-noise`; a current run whose spread exceeds
    // variabilityPct is `inconclusive`. Both prevent false regression claims.
    noisePct: envNum(process.env.BASELINE_NOISE_PCT, 10),
    variabilityPct: envNum(process.env.BASELINE_VARIABILITY_PCT, 20),
  },

  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
};

module.exports = config;
