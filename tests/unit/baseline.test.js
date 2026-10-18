'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const baseline = require('../../src/baseline');

test('median handles odd, even and empty inputs', () => {
  assert.equal(baseline.median([3, 1, 2]), 2);
  assert.equal(baseline.median([4, 1, 3, 2]), 2.5);
  assert.equal(baseline.median([]), null);
});

test('summarize reports count, median and spread', () => {
  const s = baseline.summarize([100, 110, 120]);
  assert.equal(s.count, 3);
  assert.equal(s.median, 110);
  assert.equal(s.spreadPct, 18.18);
});

test('classify marks a small change as within-noise, not a regression', () => {
  const result = baseline.classify(100, { median: 105, spreadPct: 2 }, 2, { lowerIsBetter: true });
  assert.equal(result.verdict, 'within-noise');
});

test('classify marks a large increase (lower-is-better) as a regression', () => {
  const result = baseline.classify(100, { median: 140, spreadPct: 3 }, 3, { lowerIsBetter: true });
  assert.equal(result.verdict, 'regression');
  assert.equal(result.deltaPct, 40);
});

test('classify marks a large decrease (lower-is-better) as an improvement', () => {
  const result = baseline.classify(100, { median: 70, spreadPct: 3 }, 3, { lowerIsBetter: true });
  assert.equal(result.verdict, 'improvement');
});

test('classify is inconclusive for a high-variance current run', () => {
  const result = baseline.classify(100, { median: 140, spreadPct: 45 }, 45, { lowerIsBetter: true });
  assert.equal(result.verdict, 'inconclusive');
});

test('checkCompatibility blocks on browser mismatch', () => {
  const result = baseline.checkCompatibility(
    { browser: 'chromium', os: 'Windows 10', platform: 'win32' },
    { browser: 'firefox', os: 'Windows 10', platform: 'win32' }
  );
  assert.equal(result.compatible, false);
  assert.equal(result.blockers.length, 1);
});

test('checkCompatibility blocks on viewport width mismatch', () => {
  const result = baseline.checkCompatibility(
    { browser: 'chromium', viewport: { width: 1350, height: 940 } },
    { browser: 'chromium', viewport: { width: 800, height: 940 } }
  );
  assert.equal(result.compatible, false);
});

test('checkCompatibility only warns on Lighthouse version change', () => {
  const result = baseline.checkCompatibility(
    { browser: 'chromium', lighthouseVersion: '13.0.0' },
    { browser: 'chromium', lighthouseVersion: '13.5.0' }
  );
  assert.equal(result.compatible, true);
  assert.equal(result.warnings.length, 1);
});

test('compareBaseline refuses to compare incompatible environments', () => {
  const current = { environment: { browser: 'firefox' }, browserMetrics: [{ metrics: { largestContentfulPaintMs: 1000 } }] };
  const saved = { environment: { browser: 'chromium' }, browserMetrics: [{ metrics: { largestContentfulPaintMs: 900 } }] };
  const result = baseline.compareBaseline(current, saved);
  assert.equal(result.comparable, false);
  assert.equal(result.blockers.length, 1);
});

test('compareBaseline produces delta, percentage and verdict for a compatible run', () => {
  const current = {
    environment: { browser: 'chromium', viewport: { width: 1350, height: 940 } },
    browserMetrics: [{ metrics: { largestContentfulPaintMs: 1400, cumulativeLayoutShift: 0.048 } }],
  };
  const saved = {
    environment: { browser: 'chromium', viewport: { width: 1350, height: 940 } },
    browserMetrics: [{ metrics: { largestContentfulPaintMs: 1000, cumulativeLayoutShift: 0.05 } }],
  };
  const result = baseline.compareBaseline(current, saved);
  assert.equal(result.comparable, true);
  const lcp = result.deltas.find((d) => d.metric === 'LCP (ms)');
  assert.equal(lcp.delta, 400);
  assert.equal(lcp.deltaPct, 40);
  assert.equal(lcp.verdict, 'regression');
  const cls = result.deltas.find((d) => d.metric === 'CLS');
  assert.equal(cls.verdict, 'within-noise');
});
