'use strict';

// End-to-end tests for report-summary.js: they spawn the real script against an
// isolated REPORTS_DIR so every artifact combination (present, missing, stale,
// partial) is exercised without touching the project's reports/ directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const RUN_ID = 'TESTRUN';

function makeReportsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'uiperf-'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function playwrightResults({ failed = false, startTime = new Date().toISOString() } = {}) {
  return {
    stats: { startTime },
    suites: [
      {
        title: 'SauceDemo UI performance journey',
        specs: [
          {
            title: 'single-user purchase journey',
            ok: !failed,
            tests: [
              {
                results: [
                  {
                    status: failed ? 'failed' : 'passed',
                    duration: 1200,
                    error: failed ? { message: 'expected "1" but got "0"' } : undefined,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function metricsRun(runId, { lcp = 1800, cls = 0.03, journey = 9000 } = {}) {
  return {
    schemaVersion: '1.1',
    runId,
    testStatus: 'passed',
    environment: {
      browser: 'chromium',
      browserVersion: '130.0.0',
      viewport: { width: 1350, height: 940 },
    },
    metrics: {
      largestContentfulPaintMs: lcp,
      cumulativeLayoutShift: cls,
      firstContentfulPaintMs: 900,
      interactionTimings: { 'total-journey-duration': journey },
      pages: [],
    },
  };
}

function lighthouseSummary({ runId = RUN_ID, status = 'ok', pages } = {}) {
  return {
    schemaVersion: '2.0',
    tool: 'lighthouse',
    lighthouseVersion: '13.5.0',
    runId,
    status,
    outcomes: { total: 1, ok: status === 'ok' ? 1 : 0, failed: 0, skipped: status === 'unstable' ? 1 : 0 },
    environment: { configSettings: { formFactor: 'desktop', throttlingMethod: 'simulate' } },
    pages:
      pages ||
      [
        {
          name: 'login',
          status: 'ok',
          authenticated: false,
          finalUrl: 'https://www.saucedemo.com/',
          categories: { performance: 0.9 },
        },
      ],
  };
}

function writeMetrics(reportsDir, runId, value) {
  writeJson(path.join(reportsDir, 'raw', runId, 'browser-metrics', 'browser-metrics-journey.json'), value);
}

function runReport(reportsDir, extraEnv = {}) {
  const env = {
    ...process.env,
    REPORTS_DIR: reportsDir,
    RUN_ID,
    ...extraEnv,
  };
  try {
    const stdout = execFileSync(process.execPath, ['src/report-summary.js'], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

function readSummary(reportsDir) {
  return JSON.parse(fs.readFileSync(path.join(reportsDir, 'summary.json'), 'utf8'));
}

test('reports no-data when no artifacts exist', () => {
  const reportsDir = makeReportsDir();
  const { code } = runReport(reportsDir);
  const summary = readSummary(reportsDir);
  assert.equal(summary.status, 'no-data');
  assert.equal(code, 0);
});

test('reports passed with complete, fresh evidence', () => {
  const reportsDir = makeReportsDir();
  writeJson(path.join(reportsDir, 'playwright', 'results.json'), playwrightResults());
  writeMetrics(reportsDir, RUN_ID, metricsRun(RUN_ID));
  writeJson(path.join(reportsDir, 'lighthouse', 'summary.json'), lighthouseSummary());
  const { code } = runReport(reportsDir);
  const summary = readSummary(reportsDir);
  assert.equal(summary.status, 'passed');
  assert.equal(code, 0);
  assert.ok(fs.existsSync(path.join(reportsDir, 'dashboard.html')));
});

test('fails the build on a functional test failure', () => {
  const reportsDir = makeReportsDir();
  writeJson(path.join(reportsDir, 'playwright', 'results.json'), playwrightResults({ failed: true }));
  writeMetrics(reportsDir, RUN_ID, metricsRun(RUN_ID));
  writeJson(path.join(reportsDir, 'lighthouse', 'summary.json'), lighthouseSummary());
  const { code } = runReport(reportsDir);
  const summary = readSummary(reportsDir);
  assert.equal(summary.status, 'failed');
  assert.equal(code, 1);
  assert.ok(summary.failureTypes.includes('functional-test-failure'));
});

test('fails the build on an enforced threshold breach', () => {
  const reportsDir = makeReportsDir();
  writeJson(path.join(reportsDir, 'playwright', 'results.json'), playwrightResults());
  writeMetrics(reportsDir, RUN_ID, metricsRun(RUN_ID, { lcp: 5000 }));
  writeJson(path.join(reportsDir, 'lighthouse', 'summary.json'), lighthouseSummary());
  const { code } = runReport(reportsDir, {
    PERF_THRESHOLDS_ENABLED: 'true',
    THRESHOLD_LCP_MS: '2500',
  });
  const summary = readSummary(reportsDir);
  assert.equal(summary.status, 'failed');
  assert.equal(code, 1);
  assert.ok(summary.failureTypes.includes('performance-threshold-failure'));
});

test('is unstable (not passed) on a partial Lighthouse audit', () => {
  const reportsDir = makeReportsDir();
  writeJson(path.join(reportsDir, 'playwright', 'results.json'), playwrightResults());
  writeMetrics(reportsDir, RUN_ID, metricsRun(RUN_ID));
  writeJson(path.join(reportsDir, 'lighthouse', 'summary.json'), lighthouseSummary({ status: 'unstable' }));
  const { code } = runReport(reportsDir);
  const summary = readSummary(reportsDir);
  assert.equal(summary.status, 'unstable');
  assert.equal(code, 0);
  assert.ok(summary.failureTypes.includes('lighthouse-partial-audit'));
});

test('ignores a stale Lighthouse summary whose runId does not match', () => {
  const reportsDir = makeReportsDir();
  writeJson(path.join(reportsDir, 'playwright', 'results.json'), playwrightResults());
  writeMetrics(reportsDir, RUN_ID, metricsRun(RUN_ID));
  writeJson(path.join(reportsDir, 'lighthouse', 'summary.json'), lighthouseSummary({ runId: 'OLDRUN' }));
  const { code } = runReport(reportsDir);
  const summary = readSummary(reportsDir);
  assert.equal(summary.lighthouse.available, false);
  assert.equal(summary.lighthouse.stale, true);
  assert.equal(summary.status, 'unstable');
  assert.equal(code, 0);
});

test('ignores stale Playwright results produced before the run start', () => {
  const reportsDir = makeReportsDir();
  writeJson(
    path.join(reportsDir, 'playwright', 'results.json'),
    playwrightResults({ startTime: '2020-01-01T00:00:00.000Z' })
  );
  writeMetrics(reportsDir, RUN_ID, metricsRun(RUN_ID));
  writeJson(path.join(reportsDir, 'lighthouse', 'summary.json'), lighthouseSummary());
  const { code } = runReport(reportsDir, { RUN_STARTED_AT: new Date().toISOString() });
  const summary = readSummary(reportsDir);
  assert.equal(summary.staleArtifacts.playwright, true);
  assert.equal(summary.tests.summary.total, 0);
  assert.equal(summary.status, 'passed');
  assert.equal(code, 0);
});

test('records browser metrics availability in the summary', () => {
  const reportsDir = makeReportsDir();
  writeJson(path.join(reportsDir, 'playwright', 'results.json'), playwrightResults());
  writeMetrics(reportsDir, RUN_ID, metricsRun(RUN_ID));
  writeJson(path.join(reportsDir, 'lighthouse', 'summary.json'), lighthouseSummary());
  runReport(reportsDir);
  const summary = readSummary(reportsDir);
  assert.equal(summary.browserMetrics.length, 1);
  assert.ok(fs.existsSync(path.join(reportsDir, 'browser-metrics', 'browser-metrics.json')));
  assert.ok(fs.existsSync(path.join(reportsDir, 'SUMMARY.md')));
});
