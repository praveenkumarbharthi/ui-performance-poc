'use strict';

/**
 * Central, environment-driven configuration for the ui-performance-poc project.
 *
 * All values have safe defaults so the project runs with zero configuration.
 * Optional behaviour (thresholds, baseline comparison) is DISABLED by default
 * and can only be turned on explicitly via environment variables.
 *
 * No machine-specific paths, usernames or secrets are hard-coded here.
 */

const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** Parse a boolean-ish environment variable. */
function envBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

/** Parse a numeric environment variable, returning the fallback when invalid. */
function envNum(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Resolve the run id once per process and export it via the environment so that
 * Playwright worker processes and downstream scripts share the same run id.
 *
 * `runIdFromEnv` records whether the caller supplied RUN_ID explicitly. When it
 * was NOT supplied, downstream tooling (report aggregation) must fall back to the
 * most recent raw run directory rather than a freshly generated timestamp.
 */
const runIdFromEnv = !!(process.env.RUN_ID && process.env.RUN_ID.trim());
const runId = runIdFromEnv
  ? process.env.RUN_ID.trim()
  : new Date().toISOString().replace(/[:.]/g, '-');
process.env.RUN_ID = runId;

const reportsDir = path.join(ROOT, 'reports');

const config = {
  runId,
  runIdFromEnv,
  projectRoot: ROOT,

  /** Application under test. */
  baseUrl: (process.env.BASE_URL || 'https://www.saucedemo.com').replace(/\/+$/, ''),

  /**
   * Public SauceDemo demo credentials only. These are documented, non-secret
   * values published by the SauceDemo demo site. Never use real credentials.
   */
  credentials: {
    username: process.env.SAUCE_USERNAME || 'standard_user',
    password: process.env.SAUCE_PASSWORD || 'secret_sauce',
  },

  /** Report and artifact locations (all relative to the project root). */
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
  },

  /** Browser metric collection options. */
  metrics: {
    /**
     * Documented observation window (ms) after the navigation `load` event and
     * the page readiness point, used to let LCP and CLS settle before reading.
     * LCP is only final after user input / page hide, so this is an approximation.
     */
    lcpObservationMs: envNum(process.env.LCP_OBSERVATION_MS, 2500),
  },

  /** Lighthouse audit configuration (login page only, no credentials). */
  lighthouse: {
    url: process.env.LIGHTHOUSE_URL || 'https://www.saucedemo.com/',
    chromePath: process.env.CHROME_PATH || undefined,
    categories: ['performance', 'accessibility', 'best-practices', 'seo'],
    chromeFlags: [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
    ],
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

  /**
   * Optional performance thresholds. DISABLED by default (observation mode).
   * A disabled threshold can never fail a build.
   */
  thresholds: {
    enabled: envBool(process.env.PERF_THRESHOLDS_ENABLED, false),
    lcpMs: envNum(process.env.THRESHOLD_LCP_MS, null),
    cls: envNum(process.env.THRESHOLD_CLS, null),
    journeyMs: envNum(process.env.THRESHOLD_JOURNEY_MS, null),
  },

  /** Optional baseline comparison (only honoured when the file exists/valid). */
  baseline: {
    file: process.env.BASELINE_FILE || path.join(reportsDir, 'baseline', 'summary.json'),
  },

  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
};

module.exports = config;
