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

// Complete environment metadata; a comparison is only valid when both sides have it.
function env(overrides = {}) {
  return {
    browser: 'chromium',
    os: 'Windows_NT 10.0.22631',
    platform: 'win32',
    viewport: { width: 1350, height: 940 },
    ...overrides,
  };
}

test('checkCompatibility blocks on browser mismatch', () => {
  const result = baseline.checkCompatibility(env(), env({ browser: 'firefox' }));
  assert.equal(result.compatible, false);
  assert.equal(result.blockers.length, 1);
});

test('checkCompatibility blocks on viewport width mismatch', () => {
  const result = baseline.checkCompatibility(env(), env({ viewport: { width: 800, height: 940 } }));
  assert.equal(result.compatible, false);
});

test('checkCompatibility only warns on Lighthouse version change', () => {
  const result = baseline.checkCompatibility(
    env({ lighthouseVersion: '13.0.0' }),
    env({ lighthouseVersion: '13.5.0' })
  );
  assert.equal(result.compatible, true);
  assert.equal(result.warnings.length, 1);
});

test('checkCompatibility is inconclusive when browser metadata is missing', () => {
  const result = baseline.checkCompatibility(env({ browser: null }), env());
  assert.equal(result.compatible, false);
  assert.ok(result.blockers.some((b) => /browser missing/.test(b)));
});

test('checkCompatibility is inconclusive when OS metadata is missing on the current side', () => {
  const result = baseline.checkCompatibility(env(), env({ os: undefined }));
  assert.equal(result.compatible, false);
  assert.ok(result.blockers.some((b) => /os missing in current/.test(b)));
});

test('checkCompatibility is inconclusive when viewport metadata is missing on both sides', () => {
  const result = baseline.checkCompatibility(env({ viewport: null }), env({ viewport: null }));
  assert.equal(result.compatible, false);
  assert.ok(result.blockers.some((b) => /viewport width missing on both/.test(b)));
});

test('checkCompatibility reports every mandatory field missing on a bare environment', () => {
  const result = baseline.checkCompatibility({}, {});
  assert.equal(result.compatible, false);
  assert.equal(result.blockers.length, 4);
});

test('compareBaseline refuses to compare incompatible environments', () => {
  const current = { environment: env({ browser: 'firefox' }), browserMetrics: [{ metrics: { largestContentfulPaintMs: 1000 } }] };
  const saved = { environment: env(), browserMetrics: [{ metrics: { largestContentfulPaintMs: 900 } }] };
  const result = baseline.compareBaseline(current, saved);
  assert.equal(result.comparable, false);
  assert.equal(result.inconclusive, true);
  assert.ok(result.blockers.length >= 1);
  assert.deepEqual(result.deltas, []);
});

test('compareBaseline is inconclusive (not a regression) when metadata is insufficient', () => {
  const current = { environment: { browser: 'chromium' }, browserMetrics: [{ metrics: { largestContentfulPaintMs: 2000 } }] };
  const saved = { environment: { browser: 'chromium' }, browserMetrics: [{ metrics: { largestContentfulPaintMs: 1000 } }] };
  const result = baseline.compareBaseline(current, saved);
  assert.equal(result.comparable, false);
  assert.equal(result.inconclusive, true);
  assert.deepEqual(result.deltas, [], 'no delta may be claimed without a valid comparison');
});

test('compareBaseline produces delta, percentage and verdict for a compatible run', () => {
  const current = {
    environment: env(),
    browserMetrics: [{ metrics: { largestContentfulPaintMs: 1400, cumulativeLayoutShift: 0.048 } }],
  };
  const saved = {
    environment: env(),
    browserMetrics: [{ metrics: { largestContentfulPaintMs: 1000, cumulativeLayoutShift: 0.05 } }],
  };
  const result = baseline.compareBaseline(current, saved);
  assert.equal(result.comparable, true);
  assert.equal(result.inconclusive, false);
  const lcp = result.deltas.find((d) => d.metric === 'LCP (ms)');
  assert.equal(lcp.delta, 400);
  assert.equal(lcp.deltaPct, 40);
  assert.equal(lcp.verdict, 'regression');
  const cls = result.deltas.find((d) => d.metric === 'CLS');
  assert.equal(cls.verdict, 'within-noise');
});
