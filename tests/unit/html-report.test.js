'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const htmlReport = require('../../src/html-report');

const baseSummary = {
  status: 'passed',
  runId: 'run-1',
  generatedAt: '2026-01-01T00:00:00.000Z',
  baseUrl: 'https://www.saucedemo.com',
  failureTypes: [],
  tests: { summary: { passed: 1, failed: 0, flaky: 0, skipped: 0, total: 1 }, details: [] },
  browserMetrics: [],
  lighthouse: { available: false, status: null, pages: [] },
  thresholds: { enabled: false, checks: [] },
  reports: { dashboard: 'reports/dashboard.html' },
};

test('renderDashboard produces a self-contained HTML document', () => {
  const html = htmlReport.renderDashboard(baseSummary);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<\/html>\n?$/);
  assert.ok(!html.includes('http://cdn') && !html.includes('https://cdn'));
});

test('renderDashboard shows the overall status', () => {
  const html = htmlReport.renderDashboard(baseSummary);
  assert.match(html, /Run Dashboard/);
  assert.match(html, /passed/);
});

test('renderDashboard escapes untrusted values to prevent HTML injection', () => {
  const html = htmlReport.renderDashboard({
    ...baseSummary,
    runId: '<script>alert(1)</script>',
  });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('renderDashboard handles a missing Lighthouse summary gracefully', () => {
  const html = htmlReport.renderDashboard({
    ...baseSummary,
    lighthouse: { available: false, status: null, pages: [], error: 'no session cookie' },
  });
  assert.match(html, /Lighthouse summary unavailable/);
});

test('renderDashboard renders baseline verdicts when present', () => {
  const html = htmlReport.renderDashboard({
    ...baseSummary,
    baseline: {
      attempted: true,
      comparable: true,
      warnings: [],
      deltas: [
        { metric: 'LCP (ms)', baseline: 1000, current: 1400, delta: 400, deltaPct: 40, verdict: 'regression' },
      ],
    },
  });
  assert.match(html, /Baseline comparison/);
  assert.match(html, /regression/);
});
