'use strict';

// Pure quality-gate rules: no file or process access, so they can be unit
// tested directly. report-summary.js is the only caller that turns these
// results into files and process exit codes.

const STATUS = Object.freeze({
  PASSED: 'passed',
  FAILED: 'failed',
  UNSTABLE: 'unstable',
  NO_DATA: 'no-data',
});

const FAILURE_TYPE = Object.freeze({
  FUNCTIONAL: 'functional-test-failure',
  THRESHOLD: 'performance-threshold-failure',
  LIGHTHOUSE: 'lighthouse-audit-failure',
  LIGHTHOUSE_PARTIAL: 'lighthouse-partial-audit',
  MISSING_DATA: 'missing-data',
});

function readMetric(metrics, dottedPath) {
  return dottedPath.split('.').reduce((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    return acc[key];
  }, metrics);
}

const THRESHOLD_DEFS = [
  { metric: 'lcpMs', actualPath: 'largestContentfulPaintMs' },
  { metric: 'cls', actualPath: 'cumulativeLayoutShift' },
  { metric: 'journeyMs', actualPath: 'interactionTimings.total-journey-duration' },
];

// Thresholds are observation-only while disabled, so a disabled configuration can
// never fail a build. Enabled-but-unconfigured is reported as a warning rather
// than an implicit failure.
function evaluateThresholds(thresholdsConfig, metrics) {
  const cfg = thresholdsConfig || {};
  const result = { enabled: !!cfg.enabled, checks: [], failures: [], warnings: [] };
  if (!result.enabled) return result;

  const defs = THRESHOLD_DEFS.map((def) => ({
    metric: def.metric,
    actual: readMetric(metrics, def.actualPath),
    max: cfg[def.metric],
  }));

  const configured = defs.filter((d) => d.max !== null && d.max !== undefined);
  if (configured.length === 0) {
    result.warnings.push(
      'Thresholds are enabled but no threshold value is configured; nothing is enforced.'
    );
    return result;
  }

  for (const def of defs) {
    if (def.max === null || def.max === undefined) continue;

    if (!Number.isFinite(def.max) || def.max < 0) {
      const check = { ...def, status: 'invalid-input' };
      result.checks.push(check);
      result.failures.push(check);
      result.warnings.push(`Threshold ${def.metric} is not a valid non-negative number (${def.max}).`);
      continue;
    }

    if (!Number.isFinite(def.actual)) {
      result.checks.push({ ...def, status: 'unavailable' });
      continue;
    }

    const passed = def.actual <= def.max;
    const check = {
      ...def,
      overshoot: passed ? 0 : +(def.actual - def.max).toFixed(3),
      status: passed ? 'passed' : 'failed',
    };
    result.checks.push(check);
    if (!passed) result.failures.push(check);
  }

  return result;
}

// Missing evidence must never read as success, so an absent Lighthouse summary or
// absent browser metrics downgrades the run to `unstable` rather than `passed`.
// A partial Lighthouse run (some pages skipped) is likewise `unstable`, never
// `passed`.
function determineStatus(input = {}) {
  const functionalFailures = Number(input.functionalFailures) || 0;
  const metricsCount = Number(input.metricsCount) || 0;
  const thresholdFailed = !!input.thresholdFailed;
  const lighthousePresent = !!input.lighthousePresent;
  const lighthouseFailed = !!input.lighthouseFailed;
  const lighthousePartial = !!input.lighthousePartial;
  const playwrightReportPresent = !!input.playwrightReportPresent;

  const failureTypes = new Set();

  if (!playwrightReportPresent && metricsCount === 0 && !lighthousePresent) {
    failureTypes.add(FAILURE_TYPE.MISSING_DATA);
    return { status: STATUS.NO_DATA, failureTypes: [...failureTypes] };
  }

  if (functionalFailures > 0) failureTypes.add(FAILURE_TYPE.FUNCTIONAL);
  if (thresholdFailed) failureTypes.add(FAILURE_TYPE.THRESHOLD);
  if (lighthouseFailed) failureTypes.add(FAILURE_TYPE.LIGHTHOUSE);
  else if (lighthousePartial) failureTypes.add(FAILURE_TYPE.LIGHTHOUSE_PARTIAL);

  if (functionalFailures > 0 || thresholdFailed) {
    return { status: STATUS.FAILED, failureTypes: [...failureTypes] };
  }

  if (!lighthousePresent) failureTypes.add(FAILURE_TYPE.MISSING_DATA);
  if (metricsCount === 0) failureTypes.add(FAILURE_TYPE.MISSING_DATA);

  if (lighthouseFailed || lighthousePartial || failureTypes.has(FAILURE_TYPE.MISSING_DATA)) {
    return { status: STATUS.UNSTABLE, failureTypes: [...failureTypes] };
  }

  return { status: STATUS.PASSED, failureTypes: [] };
}

module.exports = {
  STATUS,
  FAILURE_TYPE,
  THRESHOLD_DEFS,
  evaluateThresholds,
  determineStatus,
};
