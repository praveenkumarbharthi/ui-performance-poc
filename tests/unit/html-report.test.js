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

test('renderDashboard shows a dedicated verdict per section, not one overall badge', () => {
  const html = htmlReport.renderDashboard({
    ...baseSummary,
    thresholds: { enabled: false, checks: [] },
    lighthouse: { available: true, status: 'ok', outcomes: { total: 1, ok: 1, failed: 0, skipped: 0 }, pages: [] },
  });
  assert.match(html, /Run verdicts/);
  assert.match(html, /Functional tests/);
  assert.match(html, /Lighthouse audits/);
  assert.match(html, /Performance thresholds/);
  assert.match(html, /not-enforced/);
});

test('renderDashboard reports Lighthouse as completed, separate from score quality', () => {
  const html = htmlReport.renderDashboard({
    ...baseSummary,
    lighthouse: {
      available: true,
      status: 'ok',
      outcomes: { total: 1, ok: 1, failed: 0, skipped: 0 },
      pages: [{ name: 'login', status: 'ok', authenticated: false, categories: { performance: 0.7 } }],
    },
  });
  assert.match(html, /completed/);
  assert.match(html, /lowest performance 70\/100/);
  assert.match(html, /Audit completion is separate from score quality/);
});

test('renderDashboard includes a narrow-screen media query for the chart', () => {
  const html = htmlReport.renderDashboard(baseSummary);
  assert.match(html, /@media \(max-width:680px\)/);
  assert.match(html, /\.chart-row\{grid-template-columns:1fr auto\}/);
});

test('renderDashboard presents Lighthouse scores as 0-100 cards', () => {
  const html = htmlReport.renderDashboard({
    ...baseSummary,
    lighthouse: {
      available: true,
      status: 'ok',
      outcomes: { total: 2, ok: 2, failed: 0, skipped: 0 },
      pages: [
        { name: 'login', status: 'ok', authenticated: false, categories: { performance: 0.7 } },
        { name: 'cart', status: 'ok', authenticated: true, categories: { performance: 0.99 } },
      ],
    },
  });
  assert.match(html, /Lighthouse scores/);
  assert.match(html, /0-100/);
  assert.match(html, />70</);
  assert.match(html, />99</);
  assert.match(html, /authenticated/);
});

test('renderDashboard renders a journey timing chart from interaction timings', () => {
  const html = htmlReport.renderDashboard({
    ...baseSummary,
    browserMetrics: [
      {
        metrics: {
          interactionTimings: { login: 500, 'add-to-cart': 300, 'overview-total': 9 },
          pages: [],
        },
      },
    ],
  });
  assert.match(html, /User journey timings/);
  assert.match(html, /login/);
  assert.match(html, /500 ms/);
  assert.ok(!html.includes('overview-total'));
});

test('renderDashboard flags session-cumulative values on SPA route checkpoints', () => {
  const html = htmlReport.renderDashboard({
    ...baseSummary,
    browserMetrics: [
      {
        metrics: {
          interactionTimings: { 'total-journey-duration': 3655 },
          pages: [
            { name: 'login', sameDocument: false, firstContentfulPaintMs: 468, largestContentfulPaintMs: 644, cumulativeLayoutShift: 0.002 },
            { name: 'cart', sameDocument: true, firstContentfulPaintMs: null, largestContentfulPaintMs: 644, cumulativeLayoutShift: 0.002 },
          ],
        },
      },
    ],
  });
  assert.match(html, /Session-cumulative values/);
  assert.match(html, /route \(SPA\)/);
});

test('renderDashboard states when a baseline was never configured', () => {
  const html = htmlReport.renderDashboard({
    ...baseSummary,
    baseline: { attempted: false, comparable: false, warnings: [], deltas: [] },
  });
  assert.match(html, /Baseline not configured/);
});
