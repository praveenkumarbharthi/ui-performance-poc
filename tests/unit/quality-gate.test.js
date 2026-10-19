'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../../src/quality-gate');

const metrics = {
  largestContentfulPaintMs: 2000,
  cumulativeLayoutShift: 0.05,
  interactionTimings: { 'total-journey-duration': 8000 },
};

test('evaluateThresholds returns no enforcement while disabled', () => {
  const result = gate.evaluateThresholds({ enabled: false, lcpMs: 1 }, metrics);
  assert.equal(result.enabled, false);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.checks, []);
});

test('evaluateThresholds passes when metrics are within thresholds', () => {
  const result = gate.evaluateThresholds(
    { enabled: true, lcpMs: 2500, cls: 0.1, journeyMs: 10000 },
    metrics
  );
  assert.equal(result.failures.length, 0);
  assert.equal(result.checks.length, 3);
  assert.ok(result.checks.every((c) => c.status === 'passed'));
});

test('evaluateThresholds fails and records overshoot on a breach', () => {
  const result = gate.evaluateThresholds({ enabled: true, lcpMs: 1500 }, metrics);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].metric, 'lcpMs');
  assert.equal(result.failures[0].overshoot, 500);
});

test('evaluateThresholds warns (not fails) when enabled but unconfigured', () => {
  const result = gate.evaluateThresholds({ enabled: true }, metrics);
  assert.equal(result.failures.length, 0);
  assert.equal(result.warnings.length, 1);
});

test('evaluateThresholds treats an invalid threshold value as a failure', () => {
  const result = gate.evaluateThresholds({ enabled: true, cls: -1 }, metrics);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].status, 'invalid-input');
});

test('evaluateThresholds marks a missing metric as unavailable, not failed', () => {
  const result = gate.evaluateThresholds({ enabled: true, lcpMs: 100 }, { cumulativeLayoutShift: 0 });
  const lcp = result.checks.find((c) => c.metric === 'lcpMs');
  assert.equal(lcp.status, 'unavailable');
  assert.equal(result.failures.length, 0);
  assert.equal(result.unavailable.length, 1);
  assert.equal(result.unavailable[0].metric, 'lcpMs');
});

test('evaluateThresholds fails an unavailable metric in strict mode', () => {
  const result = gate.evaluateThresholds(
    { enabled: true, strict: true, lcpMs: 100 },
    { cumulativeLayoutShift: 0 }
  );
  assert.equal(result.unavailable.length, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].metric, 'lcpMs');
  assert.equal(result.failures[0].status, 'unavailable');
});

test('evaluateThresholds has no unavailable entries when the metric is present', () => {
  const result = gate.evaluateThresholds({ enabled: true, lcpMs: 100 }, { largestContentfulPaintMs: 90 });
  assert.equal(result.unavailable.length, 0);
  assert.equal(result.failures.length, 0);
});

test('determineStatus is unstable (never passed) when an enabled threshold metric is unavailable', () => {
  const result = gate.determineStatus({
    metricsCount: 1,
    thresholdUnavailable: true,
    lighthousePresent: true,
    playwrightReportPresent: true,
  });
  assert.equal(result.status, gate.STATUS.UNSTABLE);
  assert.ok(result.failureTypes.includes(gate.FAILURE_TYPE.MISSING_DATA));
});

test('determineStatus fails when a strict threshold makes the missing metric a failure', () => {
  const result = gate.determineStatus({
    metricsCount: 1,
    thresholdFailed: true,
    thresholdUnavailable: true,
    lighthousePresent: true,
    playwrightReportPresent: true,
  });
  assert.equal(result.status, gate.STATUS.FAILED);
  assert.ok(result.failureTypes.includes(gate.FAILURE_TYPE.THRESHOLD));
});

test('determineStatus reports no-data when nothing ran', () => {
  const result = gate.determineStatus({});
  assert.equal(result.status, gate.STATUS.NO_DATA);
});

test('determineStatus fails the run on functional failure', () => {
  const result = gate.determineStatus({
    functionalFailures: 1,
    metricsCount: 1,
    lighthousePresent: true,
    playwrightReportPresent: true,
  });
  assert.equal(result.status, gate.STATUS.FAILED);
  assert.ok(result.failureTypes.includes(gate.FAILURE_TYPE.FUNCTIONAL));
});

test('determineStatus fails the run on a threshold breach', () => {
  const result = gate.determineStatus({
    metricsCount: 1,
    thresholdFailed: true,
    lighthousePresent: true,
    playwrightReportPresent: true,
  });
  assert.equal(result.status, gate.STATUS.FAILED);
  assert.ok(result.failureTypes.includes(gate.FAILURE_TYPE.THRESHOLD));
});

test('determineStatus is unstable when the Lighthouse audit failed', () => {
  const result = gate.determineStatus({
    metricsCount: 1,
    lighthousePresent: true,
    lighthouseFailed: true,
    playwrightReportPresent: true,
  });
  assert.equal(result.status, gate.STATUS.UNSTABLE);
  assert.ok(result.failureTypes.includes(gate.FAILURE_TYPE.LIGHTHOUSE));
});

test('determineStatus is unstable on a partial Lighthouse audit (never passed)', () => {
  const result = gate.determineStatus({
    metricsCount: 1,
    lighthousePresent: true,
    lighthousePartial: true,
    playwrightReportPresent: true,
  });
  assert.equal(result.status, gate.STATUS.UNSTABLE);
  assert.ok(result.failureTypes.includes(gate.FAILURE_TYPE.LIGHTHOUSE_PARTIAL));
});

test('determineStatus is unstable when Lighthouse evidence is missing', () => {
  const result = gate.determineStatus({ metricsCount: 1, playwrightReportPresent: true });
  assert.equal(result.status, gate.STATUS.UNSTABLE);
  assert.ok(result.failureTypes.includes(gate.FAILURE_TYPE.MISSING_DATA));
});

test('determineStatus passes only with complete evidence', () => {
  const result = gate.determineStatus({
    metricsCount: 1,
    lighthousePresent: true,
    playwrightReportPresent: true,
  });
  assert.equal(result.status, gate.STATUS.PASSED);
  assert.deepEqual(result.failureTypes, []);
});

const S = gate.SECTION_STATUS;

test('sectionStatuses reports functional passed / failed / no-data separately', () => {
  const base = { lighthouse: { available: false }, thresholds: { enabled: false } };
  assert.equal(
    gate.sectionStatuses({ ...base, tests: { summary: { total: 0, failed: 0 } } }).functional,
    S.NO_DATA
  );
  assert.equal(
    gate.sectionStatuses({ ...base, tests: { summary: { total: 2, failed: 0 } } }).functional,
    S.PASSED
  );
  assert.equal(
    gate.sectionStatuses({ ...base, tests: { summary: { total: 2, failed: 1 } } }).functional,
    S.FAILED
  );
});

test('sectionStatuses maps Lighthouse available/ok/failed/unstable distinctly', () => {
  const s = { tests: { summary: { total: 1, failed: 0 } }, thresholds: { enabled: false } };
  assert.equal(
    gate.sectionStatuses({ ...s, lighthouse: { available: false } }).lighthouse,
    S.NO_DATA
  );
  // A completed audit is reported as `completed`, not `passed`: it says nothing
  // about score quality (a page may still score low).
  assert.equal(
    gate.sectionStatuses({ ...s, lighthouse: { available: true, status: 'ok' } }).lighthouse,
    S.COMPLETED
  );
  assert.equal(
    gate.sectionStatuses({ ...s, lighthouse: { available: true, status: 'failed' } }).lighthouse,
    S.FAILED
  );
  assert.equal(
    gate.sectionStatuses({ ...s, lighthouse: { available: true, status: 'unstable' } }).lighthouse,
    S.INCOMPLETE
  );
});

test('sectionStatuses reports thresholds as not-enforced, never a silent pass', () => {
  const s = { tests: { summary: { total: 1, failed: 0 } }, lighthouse: { available: true, status: 'ok' } };
  assert.equal(gate.sectionStatuses({ ...s, thresholds: { enabled: false } }).thresholds, S.NOT_ENFORCED);
  assert.equal(
    gate.sectionStatuses({
      ...s,
      thresholds: { enabled: true, failures: [{ metric: 'lcpMs' }], checks: [], unavailable: [] },
    }).thresholds,
    S.FAILED
  );
  assert.equal(
    gate.sectionStatuses({
      ...s,
      thresholds: { enabled: true, failures: [], checks: [], unavailable: [{ metric: 'lcpMs' }] },
    }).thresholds,
    S.INCOMPLETE
  );
  assert.equal(
    gate.sectionStatuses({
      ...s,
      thresholds: { enabled: true, failures: [], unavailable: [], checks: [{ status: 'passed' }] },
    }).thresholds,
    S.PASSED
  );
});
