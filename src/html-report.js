'use strict';

const fs = require('fs');
const path = require('path');

// Pure renderer: takes the consolidated summary object and returns a single
// self-contained HTML string (no CDN, no scripts) so it works offline and in CI
// artifact viewers. Kept side-effect free for unit testing.
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmt(value) {
  return value === null || value === undefined ? 'n/a' : String(value);
}

function statusClass(status) {
  switch (status) {
    case 'passed':
      return 'ok';
    case 'failed':
      return 'bad';
    case 'unstable':
      return 'warn';
    default:
      return 'muted';
  }
}

function table(headers, rows) {
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderDashboard(summary) {
  const s = summary || {};
  const lh = s.lighthouse || {};
  const failureTypes = s.failureTypes || [];

  const parts = [];
  parts.push('<!doctype html>');
  parts.push('<html lang="en"><head><meta charset="utf-8">');
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  parts.push('<title>UI Performance PoC - Run Dashboard</title>');
  parts.push(
    '<style>' +
      'body{font-family:Segoe UI,Arial,sans-serif;margin:0;padding:24px;background:#f6f7f9;color:#1f2933}' +
      'h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:24px 0 8px;border-bottom:1px solid #d7dbe0;padding-bottom:4px}' +
      '.badge{display:inline-block;padding:2px 10px;border-radius:10px;font-size:12px;font-weight:600;color:#fff}' +
      '.ok{background:#1f9d55}.bad{background:#c0392b}.warn{background:#b7791f}.muted{background:#6b7280}' +
      'table{border-collapse:collapse;width:100%;background:#fff;font-size:13px}' +
      'th,td{border:1px solid #d7dbe0;padding:6px 8px;text-align:left}th{background:#eef1f4}' +
      '.meta{color:#52606d;font-size:13px;margin:2px 0}' +
      'code{background:#eef1f4;padding:1px 4px;border-radius:3px}' +
      'ul{margin:6px 0 0 18px;padding:0}li{margin:2px 0;font-size:13px}' +
      '</style>'
  );
  parts.push('</head><body>');

  parts.push('<h1>UI Performance PoC - Run Dashboard</h1>');
  parts.push(
    `<p class="meta"><span class="badge ${statusClass(s.status)}">${esc(
      s.status || 'unknown'
    )}</span></p>`
  );
  parts.push(`<p class="meta">Run ID: <code>${esc(fmt(s.runId))}</code></p>`);
  parts.push(`<p class="meta">Generated: ${esc(fmt(s.generatedAt))}</p>`);
  parts.push(`<p class="meta">Base URL: ${esc(fmt(s.baseUrl))}</p>`);
  parts.push(
    `<p class="meta">Failure reasons: ${esc(failureTypes.length ? failureTypes.join(', ') : 'none')}</p>`
  );

  // Test outcomes
  const t = (s.tests && s.tests.summary) || {};
  parts.push('<h2>Test outcomes</h2>');
  parts.push(
    table(
      ['Passed', 'Failed', 'Flaky', 'Skipped', 'Total'],
      [[t.passed || 0, t.failed || 0, t.flaky || 0, t.skipped || 0, t.total || 0].map(esc)]
    )
  );
  if (s.tests && s.tests.details && s.tests.details.length) {
    parts.push(
      table(
        ['Test', 'Status', 'Duration (ms)'],
        s.tests.details.map((d) => [esc(d.title), esc(d.status), esc(d.durationMs)])
      )
    );
  }

  // Browser metrics
  parts.push('<h2>Browser metrics (Playwright, browser-observed)</h2>');
  const runs = s.browserMetrics || [];
  if (runs.length) {
    const pages = (runs[0].metrics && runs[0].metrics.pages) || [];
    if (pages.length) {
      parts.push(
        table(
          ['Page', 'Load', 'FCP (ms)', 'LCP (ms)', 'CLS', 'TTFB approx (ms)'],
          pages.map((p) => [
            esc(p.name),
            esc(p.sameDocument ? 'route (SPA)' : 'document'),
            esc(fmt(p.firstContentfulPaintMs)),
            esc(fmt(p.largestContentfulPaintMs)),
            esc(fmt(p.cumulativeLayoutShift)),
            esc(fmt(p.navigation && p.navigation.ttfbApprox)),
          ])
        )
      );
      if (pages.some((p) => p.sameDocument)) {
        parts.push(
          '<p class="meta">"route (SPA)" checkpoints are client-side route changes with no new ' +
            'document load, so navigation timing and FCP do not apply. Their per-step cost is in ' +
            'the interaction timings below. LCP/CLS accumulate across the session.</p>'
        );
      }
    }
    const timings = (runs[0].metrics && runs[0].metrics.interactionTimings) || {};
    const timingRows = Object.entries(timings).filter(([k]) => !k.startsWith('overview-'));
    if (timingRows.length) {
      parts.push('<h2>Interaction timings (NOT INP)</h2>');
      parts.push(table(['Interaction', 'Duration (ms)'], timingRows.map(([k, v]) => [esc(k), esc(fmt(v))])));
    }
  } else {
    parts.push('<p class="meta">No browser metrics artifacts found.</p>');
  }

  // Lighthouse
  parts.push('<h2>Lighthouse (lab audit, per page)</h2>');
  parts.push(
    `<p class="meta">Status: ${esc(fmt(lh.status))} | available: ${esc(fmt(lh.available))}${
      lh.stale ? ' | stale artifact ignored' : ''
    }</p>`
  );
  if (lh.outcomes) {
    parts.push(
      `<p class="meta">Outcomes: ok=${esc(lh.outcomes.ok)} failed=${esc(lh.outcomes.failed)} skipped=${esc(
        lh.outcomes.skipped
      )} of ${esc(lh.outcomes.total)}</p>`
    );
  }
  const lhPages = lh.pages || [];
  if (lhPages.length) {
    parts.push(
      table(
        ['Page', 'Status', 'Auth', 'Performance', 'Accessibility', 'Best practices', 'SEO'],
        lhPages.map((p) => {
          const c = p.categories || {};
          return [
            esc(p.name),
            esc(p.status),
            esc(p.authenticated ? 'yes' : 'no'),
            esc(fmt(c.performance)),
            esc(fmt(c.accessibility)),
            esc(fmt(c['best-practices'])),
            esc(fmt(c.seo)),
          ];
        })
      )
    );
  } else {
    parts.push(`<p class="meta">Lighthouse summary unavailable${lh.error ? `: ${esc(lh.error)}` : ''}.</p>`);
  }

  // Thresholds
  parts.push('<h2>Performance thresholds</h2>');
  const th = s.thresholds || {};
  if (!th.enabled) {
    parts.push('<p class="meta">Disabled (observation mode). No threshold can fail this build.</p>');
  } else if ((th.checks || []).length) {
    parts.push(
      table(
        ['Metric', 'Actual', 'Max', 'Status'],
        th.checks.map((c) => [esc(c.metric), esc(fmt(c.actual)), esc(fmt(c.max)), esc(c.status)])
      )
    );
  } else {
    parts.push('<p class="meta">Enabled but no threshold value configured.</p>');
  }
  if (th.enabled && th.strict) {
    parts.push('<p class="meta">Strict mode: a configured threshold with an unavailable metric fails the build.</p>');
  }
  if (th.enabled && (th.unavailable || []).length) {
    parts.push(
      `<p class="meta">${esc(
        th.unavailable.length
      )} enforced threshold(s) could not be evaluated because their metric was unavailable; the run cannot pass.</p>`
    );
  }

  // Baseline
  if (s.baseline && s.baseline.attempted) {
    parts.push('<h2>Baseline comparison</h2>');
    if (!s.baseline.comparable) {
      parts.push(
        '<p class="meta">Baseline present but <strong>inconclusive</strong>: the environments are not comparable, so no regression/improvement is claimed.</p>'
      );
    } else {
      parts.push(
        table(
          ['Metric', 'Baseline', 'Current', 'Delta', 'Change %', 'Verdict'],
          s.baseline.deltas.map((d) => [
            esc(d.metric),
            esc(fmt(d.baseline)),
            esc(fmt(d.current)),
            esc(fmt(d.delta)),
            esc(fmt(d.deltaPct)),
            esc(fmt(d.verdict)),
          ])
        )
      );
    }
    for (const w of s.baseline.warnings || []) parts.push(`<p class="meta">Warning: ${esc(w)}</p>`);
  }

  // Artifacts
  parts.push('<h2>Report artifacts</h2><ul>');
  for (const [label, rel] of Object.entries(s.reports || {})) {
    if (!rel) continue;
    parts.push(`<li>${esc(label)}: <code>${esc(rel)}</code></li>`);
  }
  parts.push('</ul>');

  // Troubleshooting
  parts.push('<h2>Troubleshooting</h2><ul>');
  const tips = [];
  if (!failureTypes.length) tips.push('No failures recorded for this run.');
  if (failureTypes.includes('functional-test-failure'))
    tips.push('Functional failure: open the Playwright HTML report and JUnit XML; screenshots/traces are under reports/.');
  if (failureTypes.includes('performance-threshold-failure'))
    tips.push('Threshold breach: see the Performance thresholds section; only change targets with an agreed baseline.');
  if (failureTypes.includes('lighthouse-audit-failure'))
    tips.push('Lighthouse failure: check reports/lighthouse/summary.json; Chrome/network issues and auth skips are common causes.');
  if (failureTypes.includes('lighthouse-partial-audit'))
    tips.push('Lighthouse partial: some pages were skipped or failed; results are incomplete and are not a full pass.');
  if (failureTypes.includes('missing-data'))
    tips.push('Missing data: a required artifact was absent; re-run the full pipeline so every stage produces evidence.');
  for (const tip of tips) parts.push(`<li>${esc(tip)}</li>`);
  parts.push('</ul>');

  parts.push(
    '<p class="meta">Lab audit and browser-observed timings are single-session measurements; they complement JMeter load/stress/soak testing and are not real-user monitoring.</p>'
  );
  parts.push('</body></html>');
  return `${parts.join('\n')}\n`;
}

function writeDashboard(summary, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderDashboard(summary), 'utf8');
  return file;
}

module.exports = { renderDashboard, writeDashboard };
