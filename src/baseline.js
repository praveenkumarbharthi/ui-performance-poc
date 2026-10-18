'use strict';

// Baseline comparison rules. Pure functions only (no file/process access) so the
// regression logic is unit-testable and reusable by report-summary.js.
//
// Safeguards against false regressions:
//  - Comparison is blocked when the environments are incompatible.
//  - A change smaller than the noise tolerance is reported as `within-noise`,
//    never as a regression.
//  - A high-variance current run is reported as `inconclusive`.

const DEFAULT_NOISE_PCT = 10;
const DEFAULT_VARIABILITY_PCT = 20;

function finiteNumbers(values) {
  return (values || []).filter((v) => Number.isFinite(v));
}

function median(values) {
  const nums = finiteNumbers(values).slice().sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function summarize(values) {
  const nums = finiteNumbers(values);
  if (nums.length === 0) return { count: 0, median: null, min: null, max: null, spreadPct: null };
  const med = median(nums);
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const spreadPct = med ? +(((max - min) / med) * 100).toFixed(2) : null;
  return { count: nums.length, median: +med.toFixed(3), min, max, spreadPct };
}

// verdict: improvement | regression | within-noise | inconclusive
function classify(baselineValue, currentSummary, currentVariabilityPct, opts = {}) {
  const noisePct = Number.isFinite(opts.noisePct) ? opts.noisePct : DEFAULT_NOISE_PCT;
  const variabilityPct = Number.isFinite(opts.variabilityPct)
    ? opts.variabilityPct
    : DEFAULT_VARIABILITY_PCT;
  const lowerIsBetter = opts.lowerIsBetter !== false;

  const current = currentSummary.median;
  if (!Number.isFinite(baselineValue) || !Number.isFinite(current)) {
    return { delta: null, deltaPct: null, verdict: 'inconclusive' };
  }

  const delta = +(current - baselineValue).toFixed(3);
  const deltaPct = baselineValue !== 0 ? +((delta / baselineValue) * 100).toFixed(2) : null;

  if (currentVariabilityPct !== null && currentVariabilityPct > variabilityPct) {
    return { delta, deltaPct, verdict: 'inconclusive' };
  }
  if (deltaPct === null || Math.abs(deltaPct) <= noisePct) {
    return { delta, deltaPct, verdict: 'within-noise' };
  }

  const improved = lowerIsBetter ? delta < 0 : delta > 0;
  return { delta, deltaPct, verdict: improved ? 'improvement' : 'regression' };
}

// Environment fields that must be present on BOTH sides for a comparison to mean
// anything. Without them a difference cannot be attributed to the change under
// test, so the comparison is inconclusive rather than a reliable result.
const MANDATORY_ENV_FIELDS = [
  { label: 'browser', get: (env) => env.browser },
  { label: 'os', get: (env) => env.os },
  { label: 'platform', get: (env) => env.platform },
  { label: 'viewport width', get: (env) => (env.viewport || {}).width },
];

function isMissing(value) {
  return value === null || value === undefined || value === '';
}

// Hard incompatibilities (and missing mandatory metadata) block comparison and
// make it inconclusive; soft differences only warn.
function checkCompatibility(baseEnv, curEnv) {
  const warnings = [];
  const blockers = [];
  const b = baseEnv || {};
  const c = curEnv || {};

  for (const field of MANDATORY_ENV_FIELDS) {
    const baseValue = field.get(b);
    const curValue = field.get(c);
    const baseMissing = isMissing(baseValue);
    const curMissing = isMissing(curValue);
    if (baseMissing && curMissing) {
      blockers.push(`${field.label} missing on both baseline and current (required for comparison)`);
    } else if (baseMissing) {
      blockers.push(`${field.label} missing in baseline environment (required for comparison)`);
    } else if (curMissing) {
      blockers.push(`${field.label} missing in current environment (required for comparison)`);
    } else if (baseValue !== curValue) {
      blockers.push(`${field.label} differs (baseline=${baseValue}, current=${curValue})`);
    }
  }

  const bView = b.viewport || {};
  const cView = c.viewport || {};
  if (bView.height && cView.height && bView.height !== cView.height) {
    warnings.push(`viewport height differs (baseline=${bView.height}, current=${cView.height})`);
  }
  if (b.lighthouseVersion && c.lighthouseVersion && b.lighthouseVersion !== c.lighthouseVersion) {
    warnings.push(
      `Lighthouse version differs (baseline=${b.lighthouseVersion}, current=${c.lighthouseVersion})`
    );
  }
  const bAudit = b.lighthouseAudit || {};
  const cAudit = c.lighthouseAudit || {};
  for (const key of ['formFactor', 'throttlingMethod']) {
    if (bAudit[key] && cAudit[key] && bAudit[key] !== cAudit[key]) {
      warnings.push(`Lighthouse ${key} differs (baseline=${bAudit[key]}, current=${cAudit[key]})`);
    }
  }

  return { compatible: blockers.length === 0, blockers, warnings };
}

const METRICS = [
  { key: 'largestContentfulPaintMs', label: 'LCP (ms)', lowerIsBetter: true },
  { key: 'cumulativeLayoutShift', label: 'CLS', lowerIsBetter: true },
  { key: 'firstContentfulPaintMs', label: 'FCP (ms)', lowerIsBetter: true },
];

// Extract per-metric sample arrays from a list of browser-metrics runs.
function collectSamples(metricsList) {
  const samples = {};
  for (const m of METRICS) samples[m.key] = [];
  for (const run of metricsList || []) {
    const metrics = (run && run.metrics) || {};
    for (const m of METRICS) {
      const value = metrics[m.key];
      if (Number.isFinite(value)) samples[m.key].push(value);
    }
  }
  return samples;
}

function compareBaseline(current, baseline, opts = {}) {
  const result = {
    attempted: !!baseline,
    comparable: false,
    inconclusive: false,
    warnings: [],
    blockers: [],
    deltas: [],
  };
  if (!baseline) return result;

  const compat = checkCompatibility(baseline.environment, current.environment);
  result.warnings = compat.warnings;
  result.blockers = compat.blockers;
  if (!compat.compatible) {
    // No deltas are computed, so no regression/improvement is implied: the
    // comparison is explicitly inconclusive.
    result.inconclusive = true;
    result.warnings.push(
      'Comparison is inconclusive: environments are incompatible or lack the metadata required for a reliable result.'
    );
    return result;
  }

  const baseSamples = collectSamples([{ metrics: (baseline.browserMetrics && baseline.browserMetrics[0] && baseline.browserMetrics[0].metrics) || {} }]);
  const curSamples = collectSamples(current.browserMetrics);

  for (const m of METRICS) {
    const curSummary = summarize(curSamples[m.key]);
    const baseSummary = summarize(baseSamples[m.key]);
    const baselineValue = baseSummary.median;
    if (baselineValue === null || curSummary.median === null) continue;

    const c = classify(baselineValue, curSummary, curSummary.spreadPct, {
      lowerIsBetter: m.lowerIsBetter,
      noisePct: opts.noisePct,
      variabilityPct: opts.variabilityPct,
    });
    result.deltas.push({
      metric: m.label,
      baseline: baselineValue,
      current: curSummary.median,
      delta: c.delta,
      deltaPct: c.deltaPct,
      verdict: c.verdict,
      samples: curSummary,
    });
  }

  result.comparable = result.deltas.length > 0;
  return result;
}

module.exports = {
  DEFAULT_NOISE_PCT,
  DEFAULT_VARIABILITY_PCT,
  median,
  summarize,
  classify,
  checkCompatibility,
  collectSamples,
  compareBaseline,
};
