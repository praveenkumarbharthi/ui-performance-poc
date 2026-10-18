'use strict';

// Consolidates run artifacts into reports/summary.json, reports/SUMMARY.md and
// reports/browser-metrics/browser-metrics.json, then optionally compares against
// a baseline.
//
// Exit codes: 0 = ok, 1 = functional or threshold failure, 2 = infrastructure failure.

const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) {
    logger.warn(`Missing artifact (skipped): ${path.relative(config.projectRoot, file)}`);
    return null;
  }
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.trim()) {
      logger.warn(`Empty artifact (skipped): ${path.relative(config.projectRoot, file)}`);
      return null;
    }
    return JSON.parse(text);
  } catch (err) {
    logger.error(`Failed to parse JSON ${file}: ${err.message}`);
    return null;
  }
}

// Prefer an explicit RUN_ID; otherwise fall back to the most recent raw run
// directory so a standalone `npm run report` finds the latest evidence.
function resolveRunId() {
  if (config.runIdFromEnv) return config.runId;
  const rawRoot = config.paths.raw;
  if (fs.existsSync(rawRoot)) {
    const dirs = fs
      .readdirSync(rawRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    if (dirs.length) return dirs[dirs.length - 1];
  }
  return null;
}

function flattenPlaywrightSpecs(report) {
  const tests = [];
  function walkSuites(suites, parentTitles) {
    for (const suite of suites || []) {
      const titles = parentTitles.concat(suite.title ? [suite.title] : []);
      for (const spec of suite.specs || []) {
        const title = titles.concat(spec.title ? [spec.title] : []).join(' > ');
        let status = spec.ok ? 'passed' : 'failed';
        let durationMs = 0;
        let error = null;
        for (const t of spec.tests || []) {
          for (const r of t.results || []) {
            durationMs += r.duration || 0;
            if (r.status && r.status !== 'passed') status = r.status;
            if (r.error && r.error.message) error = r.error.message;
          }
        }
        tests.push({ title, status, durationMs, error });
      }
      walkSuites(suite.suites, titles);
    }
  }
  walkSuites(report.suites, []);
  return tests;
}

function collectBrowserMetrics(runId) {
  const dir = runId ? path.join(config.paths.raw, runId, 'browser-metrics') : null;
  const files = [];
  if (dir && fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.json')) files.push(path.join(dir, name));
    }
  }
  return files.map((f) => readJsonIfExists(f)).filter(Boolean);
}

function writeMergedMetrics(metricsList) {
  const merged = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    count: metricsList.length,
    runs: metricsList,
  };
  fs.mkdirSync(path.dirname(config.paths.browserMetrics), { recursive: true });
  fs.writeFileSync(config.paths.browserMetrics, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return config.paths.browserMetrics;
}

// Disabled thresholds can never fail the build.
function evaluateThresholds(metricsList) {
  const result = { enabled: config.thresholds.enabled, checks: [], failures: [] };
  if (!config.thresholds.enabled) return result;

  const first = metricsList[0];
  const defs = [
    {
      metric: 'lcpMs',
      actual: first ? first.metrics.largestContentfulPaintMs : null,
      max: config.thresholds.lcpMs,
    },
    {
      metric: 'cls',
      actual: first ? first.metrics.cumulativeLayoutShift : null,
      max: config.thresholds.cls,
    },
    {
      metric: 'journeyMs',
      actual: first ? first.metrics.interactionTimings['total-journey-duration'] : null,
      max: config.thresholds.journeyMs,
    },
  ];

  for (const def of defs) {
    if (def.max === null || def.max === undefined) continue;
    if (!Number.isFinite(def.max) || def.max < 0) {
      result.checks.push({ ...def, status: 'invalid-input' });
      result.failures.push({ metric: def.metric, reason: 'invalid threshold input' });
      continue;
    }
    if (def.actual === null || def.actual === undefined) {
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

// Optional baseline comparison - only when a valid, comparable baseline exists.
function compareBaseline(currentSummary) {
  const file = config.baseline.file;
  const result = { attempted: fs.existsSync(file), comparable: false, warnings: [], deltas: [] };
  if (!result.attempted) return result;

  const baseline = readJsonIfExists(file);
  if (!baseline) return result;

  const curEnv = currentSummary.environment || {};
  const baseEnv = baseline.environment || {};
  if (baseEnv.browser && curEnv.playwright && baseEnv.browser !== curEnv.playwright) {
    result.warnings.push(`Browser differs (baseline=${baseEnv.browser}, current=${curEnv.playwright}).`);
  }
  if (baseEnv.os && curEnv.os && baseEnv.os !== curEnv.os) {
    result.warnings.push(`OS differs (baseline=${baseEnv.os}, current=${curEnv.os}).`);
  }
  if (
    baseEnv.lighthouseVersion &&
    curEnv.lighthouseVersion &&
    baseEnv.lighthouseVersion !== curEnv.lighthouseVersion
  ) {
    result.warnings.push(
      `Lighthouse version differs (baseline=${baseEnv.lighthouseVersion}, current=${curEnv.lighthouseVersion}).`
    );
  }

  const cur = currentSummary.browserMetrics && currentSummary.browserMetrics[0];
  const base = baseline.browserMetrics && baseline.browserMetrics[0];
  if (cur && base) {
    const pairs = [
      ['largestContentfulPaintMs', 'LCP (ms)'],
      ['cumulativeLayoutShift', 'CLS'],
      ['firstContentfulPaintMs', 'FCP (ms)'],
    ];
    for (const [key, label] of pairs) {
      const c = cur.metrics[key];
      const b = base.metrics[key];
      if (Number.isFinite(c) && Number.isFinite(b)) {
        result.deltas.push({ metric: label, baseline: b, current: c, delta: +(c - b).toFixed(3) });
      }
    }
    result.comparable = result.deltas.length > 0;
  }
  return result;
}

function fmt(value) {
  return value === null || value === undefined ? 'n/a' : String(value);
}

function buildMarkdown(summary) {
  const lines = [];
  lines.push('# UI Performance PoC - Run Summary');
  lines.push('');
  lines.push(`- **Run ID:** ${summary.runId || 'n/a'}`);
  lines.push(`- **Generated:** ${summary.generatedAt}`);
  lines.push(`- **Base URL:** ${summary.baseUrl}`);
  lines.push(`- **Overall status:** ${summary.status}`);
  lines.push('');
  lines.push('## Test outcomes');
  lines.push('');
  lines.push(`- Passed: ${summary.tests.summary.passed}`);
  lines.push(`- Failed: ${summary.tests.summary.failed}`);
  lines.push(`- Flaky: ${summary.tests.summary.flaky}`);
  lines.push(`- Skipped: ${summary.tests.summary.skipped}`);
  lines.push('');
  if (summary.tests.details.length) {
    lines.push('| Test | Status | Duration (ms) |');
    lines.push('| --- | --- | --- |');
    for (const t of summary.tests.details) {
      lines.push(`| ${t.title} | ${t.status} | ${t.durationMs} |`);
    }
    lines.push('');
  }
  if (summary.tests.failures.length) {
    lines.push('### Failed tests');
    lines.push('');
    for (const f of summary.tests.failures) {
      lines.push(`- **${f.title}**: ${(f.error || 'no error message').split('\n')[0]}`);
    }
    lines.push('');
  }

  lines.push('## Browser metrics (Playwright, browser-observed)');
  lines.push('');
  if (summary.browserMetrics.length) {
    const m = summary.browserMetrics[0];
    const nav = m.metrics.navigation || {};
    lines.push('| Metric | Value | Available |');
    lines.push('| --- | --- | --- |');
    lines.push(`| FCP (ms) | ${fmt(m.metrics.firstContentfulPaintMs)} | ${m.metrics.firstContentfulPaintMs !== null} |`);
    lines.push(`| LCP (ms) | ${fmt(m.metrics.largestContentfulPaintMs)} | ${m.metrics.largestContentfulPaintMs !== null} |`);
    lines.push(`| CLS | ${fmt(m.metrics.cumulativeLayoutShift)} | ${m.metrics.cumulativeLayoutShift !== null} |`);
    lines.push(`| TTFB approx (ms) | ${fmt(nav.ttfbApprox)} | ${nav.ttfbApprox !== null && nav.ttfbApprox !== undefined} |`);
    lines.push(`| DNS lookup (ms) | ${fmt(nav.dnsLookupDuration)} | ${nav.dnsLookupDuration !== null && nav.dnsLookupDuration !== undefined} |`);
    lines.push(`| TCP connect (ms) | ${fmt(nav.tcpConnectionDuration)} | ${nav.tcpConnectionDuration !== null && nav.tcpConnectionDuration !== undefined} |`);
    lines.push('');
    lines.push('### Interaction timings');
    lines.push('');
    lines.push('| Interaction | Duration (ms) |');
    lines.push('| --- | --- |');
    for (const [k, v] of Object.entries(m.metrics.interactionTimings || {})) {
      // The overview-* entries are captured values (price/subtotal), not timings.
      if (k.startsWith('overview-')) continue;
      lines.push(`| ${k} | ${fmt(v)} |`);
    }
    lines.push('');
    lines.push('> These are custom click-to-visible measurements, NOT INP. INP is not measured.');
    lines.push('');
  } else {
    lines.push('_No browser metrics artifacts found._');
    lines.push('');
  }

  lines.push('## Lighthouse (lab audit, per page)');
  lines.push('');
  const lhPages = summary.lighthouse ? summary.lighthouse.pages || [] : [];
  if (lhPages.length) {
    lines.push('| Page | Auth | Performance | Accessibility | Best practices | SEO |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const p of lhPages) {
      const c = p.categories || {};
      lines.push(
        `| ${p.name} | ${p.authenticated ? 'yes' : 'no'} | ${fmt(c.performance)} | ${fmt(c.accessibility)} | ${fmt(c['best-practices'])} | ${fmt(c.seo)} |`
      );
    }
    lines.push('');
    for (const p of lhPages) {
      if (p.status === 'failed') {
        lines.push(`- **${p.name}** failed: ${p.error || 'unknown error'}`);
      }
    }
    lines.push(`Lighthouse version: ${summary.lighthouse.version || 'n/a'}`);
    lines.push('');
    lines.push('> Lab audit - not real-user monitoring; not comparable to journey timings.');
    lines.push('');
  } else {
    lines.push(`_Lighthouse summary unavailable${summary.lighthouse && summary.lighthouse.error ? `: ${summary.lighthouse.error}` : ''}._`);
    lines.push('');
  }

  lines.push('## Performance thresholds');
  lines.push('');
  if (!summary.thresholds.enabled) {
    lines.push('_Disabled (observation mode). No threshold can fail this build._');
  } else {
    for (const c of summary.thresholds.checks) {
      lines.push(`- ${c.metric}: actual=${fmt(c.actual)} max=${fmt(c.max)} -> ${c.status}`);
    }
  }
  lines.push('');

  lines.push('## Report artifacts');
  lines.push('');
  for (const [label, rel] of Object.entries(summary.reports)) {
    if (!rel) continue;
    lines.push(`- ${label}: \`${rel}\``);
  }
  lines.push('');

  if (summary.baseline && summary.baseline.attempted) {
    lines.push('## Baseline comparison');
    lines.push('');
    if (!summary.baseline.comparable) {
      lines.push('_Baseline file present but not comparable._');
    } else {
      lines.push('| Metric | Baseline | Current | Delta |');
      lines.push('| --- | --- | --- | --- |');
      for (const d of summary.baseline.deltas) {
        lines.push(`| ${d.metric} | ${d.baseline} | ${d.current} | ${d.delta} |`);
      }
      for (const w of summary.baseline.warnings) lines.push(`- WARNING: ${w}`);
    }
    lines.push('');
  }

  lines.push('## Notes & limitations');
  lines.push('');
  lines.push('- Single-user browser POC; complements JMeter, does not replace load/stress/soak testing.');
  lines.push('- A single local run is not statistically reliable performance evidence.');
  lines.push('- Browser-observed timings differ from server-side and Lighthouse lab metrics.');
  lines.push('');
  return lines.join('\n');
}

function rel(p) {
  if (!p) return null;
  return path.relative(config.projectRoot, p).replace(/\\/g, '/');
}

function main() {
  try {
    const runId = resolveRunId();
    logger.info(`Generating consolidated summary for run: ${runId || '(none found)'}`);

    const playwrightReport = readJsonIfExists(config.paths.playwright.json);
    const tests = { summary: { passed: 0, failed: 0, flaky: 0, skipped: 0, total: 0 }, details: [], failures: [] };
    if (playwrightReport) {
      tests.details = flattenPlaywrightSpecs(playwrightReport);
      for (const t of tests.details) {
        if (t.status === 'passed') tests.summary.passed += 1;
        else if (t.status === 'skipped') tests.summary.skipped += 1;
        else if (t.status === 'flaky') tests.summary.flaky += 1;
        else {
          tests.summary.failed += 1;
          tests.failures.push({ title: t.title, error: t.error });
        }
      }
      tests.summary.total = tests.details.length;
    }

    const metricsList = collectBrowserMetrics(runId);
    writeMergedMetrics(metricsList);

    const lhSummary = readJsonIfExists(path.join(config.paths.lighthouse, 'summary.json'));
    const lhPages = lhSummary && Array.isArray(lhSummary.pages) ? lhSummary.pages : [];
    const lighthouse = {
      available: !!lhSummary && lhSummary.status !== 'failed',
      version: lhSummary ? lhSummary.lighthouseVersion : null,
      pages: lhPages.map((p) => ({
        name: p.name,
        status: p.status,
        url: p.finalUrl || p.requestedUrl,
        authenticated: !!p.authenticated,
        categories: p.categories
          ? Object.fromEntries(Object.entries(p.categories).map(([k, v]) => [k, v.score]))
          : {},
        error: p.error || null,
      })),
      error: lhSummary && lhSummary.error ? lhSummary.error : null,
    };

    const thresholds = evaluateThresholds(metricsList);

    const summary = {
      schemaVersion: '1.0',
      generatedAt: new Date().toISOString(),
      runId,
      baseUrl: config.baseUrl,
      environment: {
        nodeVersion: process.version,
        os: `${require('os').type()} ${require('os').release()}`,
        platform: process.platform,
        browser: metricsList[0] ? metricsList[0].environment.browser : null,
        playwright: metricsList[0]
          ? `${metricsList[0].environment.browser} ${metricsList[0].environment.browserVersion || ''}`.trim()
          : null,
        lighthouseVersion: lighthouse.version,
      },
      tests,
      browserMetrics: metricsList,
      lighthouse,
      thresholds,
      status: 'unknown',
      failureTypes: [],
      reports: {
        playwrightHtml: rel(config.paths.playwright.html),
        playwrightJson: rel(config.paths.playwright.json),
        junitXml: rel(config.paths.junit),
        browserMetrics: rel(config.paths.browserMetrics),
        lighthouseReports: rel(config.paths.lighthouse),
        lighthouseSummary: rel(path.join(config.paths.lighthouse, 'summary.json')),
      },
    };

    summary.baseline = compareBaseline(summary);

    const functionalFailed = tests.summary.failed > 0;
    const thresholdFailed = thresholds.enabled && thresholds.failures.length > 0;
    if (functionalFailed) summary.failureTypes.push('functional-test-failure');
    if (thresholdFailed) summary.failureTypes.push('performance-threshold-failure');
    if (lhSummary && lhSummary.status === 'failed') summary.failureTypes.push('infrastructure/tool-failure (lighthouse)');

    if (functionalFailed || thresholdFailed) summary.status = 'failed';
    else if (summary.failureTypes.length) summary.status = 'unstable';
    else if (!playwrightReport && !metricsList.length) summary.status = 'no-data';
    else summary.status = 'passed';

    fs.mkdirSync(path.dirname(config.paths.summaryJson), { recursive: true });
    fs.writeFileSync(config.paths.summaryJson, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    fs.writeFileSync(config.paths.summaryMarkdown, `${buildMarkdown(summary)}\n`, 'utf8');

    logger.info(`Wrote ${rel(config.paths.summaryJson)} and ${rel(config.paths.summaryMarkdown)}`);
    logger.info(`Overall status: ${summary.status}`);

    if (functionalFailed || thresholdFailed) process.exitCode = 1;
  } catch (err) {
    logger.error(`Summary generation failed: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main();
}

module.exports = { main, flattenPlaywrightSpecs, evaluateThresholds };
