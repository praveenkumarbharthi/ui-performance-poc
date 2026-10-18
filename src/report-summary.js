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
const gate = require('./quality-gate');
const htmlReport = require('./html-report');
const baseline = require('./baseline');

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

function readTextIfExists(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, 'utf8').trim();
    return text || null;
  } catch (err) {
    return null;
  }
}

// A re-used artifact from an earlier run must never be presented as current
// evidence. `runStartedAtMs` comes from RUN_STARTED_AT (set by the pipeline or a
// run-started-at.txt marker); without it the check is skipped rather than guessed.
function isStaleArtifact(isoTime, runStartedAtMs, label) {
  if (!isoTime || !Number.isFinite(runStartedAtMs)) return false;
  const t = Date.parse(isoTime);
  if (!Number.isFinite(t)) return false;
  if (t < runStartedAtMs - 1000) {
    logger.warn(
      `Ignoring stale ${label}: generated ${isoTime}, before run start ` +
        `${new Date(runStartedAtMs).toISOString()}.`
    );
    return true;
  }
  return false;
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

// Thin adapter: threshold rules live in src/quality-gate.js so the exact same
// logic (and unit tests) apply to the Playwright spec and this aggregator.
function evaluateThresholds(metricsList) {
  const first = metricsList[0];
  return gate.evaluateThresholds(config.thresholds, first ? first.metrics : {});
}

// Optional baseline comparison - only when a valid, comparable baseline exists.
// All rules live in src/baseline.js (pure + unit tested).
function compareBaseline(currentSummary) {
  const file = config.baseline.file;
  if (!fs.existsSync(file)) {
    return { attempted: false, comparable: false, warnings: [], blockers: [], deltas: [] };
  }
  const saved = readJsonIfExists(file);
  if (!saved) {
    return { attempted: true, comparable: false, warnings: ['baseline file unreadable'], blockers: [], deltas: [] };
  }
  return baseline.compareBaseline(currentSummary, saved, {
    noisePct: config.baseline.noisePct,
    variabilityPct: config.baseline.variabilityPct,
  });
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
  lines.push(
    `- **Failure reasons:** ${
      summary.failureTypes && summary.failureTypes.length ? summary.failureTypes.join(', ') : 'none'
    }`
  );
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
    const routeChanges = (m.metrics.pages || [])
      .filter((p) => p.sameDocument)
      .map((p) => p.name);
    if (routeChanges.length) {
      lines.push(
        `> Checkpoints reached by client-side route change (no new document load): ${routeChanges.join(
          ', '
        )}. Navigation timing and FCP apply only to the initial document; the per-step cost of those ` +
          'checkpoints is in the interaction timings above.'
      );
      lines.push('');
    }
  } else {
    lines.push('_No browser metrics artifacts found._');
    lines.push('');
  }

  lines.push('## Lighthouse (lab audit, per page)');
  lines.push('');
  const lh = summary.lighthouse || {};
  const lhPages = lh.pages || [];
  if (lhPages.length || lh.available) {
    lines.push(`- Lighthouse status: ${fmt(lh.status)}`);
    if (lh.outcomes) {
      lines.push(
        `- Outcomes: ok=${lh.outcomes.ok} failed=${lh.outcomes.failed} skipped=${lh.outcomes.skipped} of ${lh.outcomes.total}`
      );
    }
    lines.push('');
    lines.push('| Page | Status | Auth | Performance | Accessibility | Best practices | SEO |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const p of lhPages) {
      const c = p.categories || {};
      lines.push(
        `| ${p.name} | ${p.status} | ${p.authenticated ? 'yes' : 'no'} | ${fmt(c.performance)} | ${fmt(c.accessibility)} | ${fmt(c['best-practices'])} | ${fmt(c.seo)} |`
      );
    }
    lines.push('');
    for (const p of lhPages) {
      if (p.status === 'failed') lines.push(`- **${p.name}** failed: ${p.error || 'unknown error'}`);
      if (p.status === 'skipped') lines.push(`- **${p.name}** skipped: ${p.error || 'not audited'}`);
    }
    lines.push('');
    lines.push(`Lighthouse version: ${lh.version || 'n/a'}`);
    lines.push('');
    lines.push(
      '> Lab audit - not real-user monitoring; not comparable to journey timings. A partial run (skipped pages) is not complete success.'
    );
    lines.push('');
  } else {
    lines.push(`_Lighthouse summary unavailable${lh.error ? `: ${lh.error}` : ''}._`);
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
    for (const b of summary.baseline.blockers || []) lines.push(`- BLOCKED: ${b}`);
    if (!summary.baseline.comparable) {
      lines.push('_Baseline file present but not comparable (see blocked reasons above)._');
    } else {
      lines.push('| Metric | Baseline | Current | Delta | Change % | Verdict |');
      lines.push('| --- | --- | --- | --- | --- | --- |');
      for (const d of summary.baseline.deltas) {
        lines.push(
          `| ${d.metric} | ${d.baseline} | ${d.current} | ${d.delta} | ${d.deltaPct} | ${d.verdict} |`
        );
      }
      lines.push('');
      lines.push(
        '> `within-noise` and `inconclusive` are not regressions. A single noisy run is never reported as a regression.'
      );
    }
    for (const w of summary.baseline.warnings) lines.push(`- WARNING: ${w}`);
    lines.push('');
  }

  lines.push('## Notes & limitations');
  lines.push('');
  lines.push('- Single-user browser POC; complements JMeter, does not replace load/stress/soak testing.');
  lines.push('- A single local run is not statistically reliable performance evidence.');
  lines.push('- Browser-observed timings differ from server-side and Lighthouse lab metrics.');
  lines.push('');

  lines.push('## Troubleshooting');
  lines.push('');
  const failureTypes = summary.failureTypes || [];
  if (failureTypes.length === 0) {
    lines.push('- No failures recorded for this run.');
  }
  if (failureTypes.includes('functional-test-failure')) {
    lines.push('- Functional failure: open the Playwright HTML report and JUnit XML; screenshots/traces are under reports/.');
  }
  if (failureTypes.includes('performance-threshold-failure')) {
    lines.push('- Threshold breach: see the Performance thresholds section; adjust the target only with an agreed baseline.');
  }
  if (failureTypes.includes('lighthouse-audit-failure')) {
    lines.push('- Lighthouse failure: check reports/lighthouse/summary.json; Chrome/network issues and auth skips are common causes.');
  }
  if (failureTypes.includes('lighthouse-partial-audit')) {
    lines.push('- Lighthouse partial: some pages were skipped or failed. Results are incomplete and must not be read as a full pass.');
  }
  if (failureTypes.includes('missing-data')) {
    lines.push('- Missing data: a required artifact was absent. Re-run the full pipeline so every stage produces evidence.');
  }
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

    const startedAtRaw =
      process.env.RUN_STARTED_AT || readTextIfExists(config.paths.runStartedMarker);
    const runStartedAt = startedAtRaw ? Date.parse(startedAtRaw) : NaN;
    const playwrightReportRaw = readJsonIfExists(config.paths.playwright.json);
    const playwrightStale = isStaleArtifact(
      playwrightReportRaw && playwrightReportRaw.stats && playwrightReportRaw.stats.startTime,
      runStartedAt,
      'Playwright results'
    );
    const playwrightReport = playwrightStale ? null : playwrightReportRaw;
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

    const lhSummaryRaw = readJsonIfExists(path.join(config.paths.lighthouse, 'summary.json'));
    // Lighthouse's summary.json is overwritten in place, so a run that skipped the
    // audit would otherwise reuse the previous run's file. When the run id is known
    // and disagrees, the artifact is stale and must not count as current evidence.
    const lighthouseRunId = lhSummaryRaw ? lhSummaryRaw.runId || null : null;
    const lighthouseStale = !!(lhSummaryRaw && runId && lighthouseRunId && lighthouseRunId !== runId);
    if (lighthouseStale) {
      logger.warn(
        `Ignoring stale Lighthouse summary: runId=${lighthouseRunId} does not match current run ${runId}.`
      );
    }
    const lhSummary = lighthouseStale ? null : lhSummaryRaw;
    const lhPages = lhSummary && Array.isArray(lhSummary.pages) ? lhSummary.pages : [];
    const lhStatus = lhSummary ? lhSummary.status || null : null;
    const lighthouse = {
      available: !!lhSummary,
      stale: lighthouseStale,
      status: lhStatus,
      outcomes: (lhSummary && lhSummary.outcomes) || null,
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
      error: lighthouseStale
        ? `stale artifact ignored (runId=${lighthouseRunId} != ${runId})`
        : lhSummaryRaw && lhSummaryRaw.error
          ? lhSummaryRaw.error
          : null,
    };

    const thresholds = evaluateThresholds(metricsList);

    const firstMetrics = metricsList[0];
    const lighthouseAuditSettings =
      (lhSummary &&
        lhSummary.environment &&
        lhSummary.environment.configSettings &&
        lhSummary.environment.configSettings) ||
      null;

    const summary = {
      schemaVersion: '1.0',
      generatedAt: new Date().toISOString(),
      runId,
      runStartedAt: Number.isFinite(runStartedAt) ? new Date(runStartedAt).toISOString() : null,
      staleArtifacts: { playwright: playwrightStale, lighthouse: lighthouseStale },
      baseUrl: config.baseUrl,
      environment: {
        nodeVersion: process.version,
        os: `${require('os').type()} ${require('os').release()}`,
        platform: process.platform,
        browser: firstMetrics ? firstMetrics.environment.browser : null,
        browserVersion: firstMetrics ? firstMetrics.environment.browserVersion : null,
        viewport: firstMetrics ? firstMetrics.environment.viewport || null : null,
        lighthouseVersion: lighthouse.version,
        lighthouseAudit: lighthouseAuditSettings
          ? {
              formFactor: lighthouseAuditSettings.formFactor || null,
              throttlingMethod: lighthouseAuditSettings.throttlingMethod || null,
            }
          : null,
      },
      tests,
      browserMetrics: metricsList,
      lighthouse,
      thresholds,
      status: 'unknown',
      failureTypes: [],
      reports: {
        dashboard: rel(config.paths.dashboard),
        playwrightHtml: rel(config.paths.playwright.html),
        playwrightJson: rel(config.paths.playwright.json),
        junitXml: rel(config.paths.junit),
        browserMetrics: rel(config.paths.browserMetrics),
        lighthouseReports: rel(config.paths.lighthouse),
        lighthouseSummary: rel(path.join(config.paths.lighthouse, 'summary.json')),
      },
    };

    summary.baseline = compareBaseline(summary);

    const functionalFailures = tests.summary.failed;
    const thresholdFailed = thresholds.enabled && thresholds.failures.length > 0;
    const decision = gate.determineStatus({
      functionalFailures,
      metricsCount: metricsList.length,
      thresholdFailed,
      lighthousePresent: !!lhSummary,
      lighthouseFailed: lhStatus === 'failed',
      lighthousePartial: lhStatus === 'unstable',
      playwrightReportPresent: !!playwrightReport,
    });
    summary.status = decision.status;
    summary.failureTypes = decision.failureTypes;
    summary.functionalFailures = functionalFailures;
    summary.thresholdFailed = thresholdFailed;

    fs.mkdirSync(path.dirname(config.paths.summaryJson), { recursive: true });
    fs.writeFileSync(config.paths.summaryJson, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    fs.writeFileSync(config.paths.summaryMarkdown, `${buildMarkdown(summary)}\n`, 'utf8');
    htmlReport.writeDashboard(summary, config.paths.dashboard);

    logger.info(
      `Wrote ${rel(config.paths.summaryJson)}, ${rel(config.paths.summaryMarkdown)} and ${rel(
        config.paths.dashboard
      )}`
    );
    logger.info(`Overall status: ${summary.status} (${summary.failureTypes.join(', ') || 'no failures'})`);

    // Exit code reflects only build-failing gates. Missing/partial data downgrades
    // the report to `unstable` (surfaced in the report) but does not by itself fail
    // the build; the Jenkins Lighthouse stage handles that separately.
    if (summary.status === 'failed') process.exitCode = 1;
  } catch (err) {
    logger.error(`Summary generation failed: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main();
}

module.exports = { main, flattenPlaywrightSpecs, evaluateThresholds };
