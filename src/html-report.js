'use strict';

const fs = require('fs');
const path = require('path');
const gate = require('./quality-gate');

// Pure renderer: takes the consolidated summary object and returns one
// self-contained HTML string (inline CSS, no scripts, no CDN) so it works
// offline and in any CI artifact viewer. Side-effect free for unit testing.

const CATEGORY_ORDER = ['performance', 'accessibility', 'best-practices', 'seo'];
const CATEGORY_LABELS = {
  performance: 'Performance',
  accessibility: 'Accessibility',
  'best-practices': 'Best practices',
  seo: 'SEO',
};

const STYLE =
  'body{font-family:Segoe UI,Arial,sans-serif;margin:0;padding:24px;background:#f4f6f8;color:#1f2933}' +
  '.wrap{max-width:1080px;margin:0 auto}' +
  'h1{font-size:20px;margin:0 0 8px}h2{font-size:15px;margin:28px 0 10px;border-bottom:1px solid #d7dbe0;padding-bottom:5px}' +
  '.hint{color:#7b8794;font-weight:400;font-size:12px}' +
  '.badge{display:inline-block;padding:2px 10px;border-radius:10px;font-size:12px;font-weight:600;color:#fff}' +
  '.ok{background:#1f9d55}.bad{background:#c0392b}.warn{background:#b7791f}.muted{background:#6b7280}' +
  '.tag{display:inline-block;padding:1px 7px;border-radius:9px;font-size:11px;background:#e3e8ee;color:#52606d;font-weight:600}' +
  '.head{display:flex;flex-wrap:wrap;align-items:center;gap:10px}' +
  '.meta{color:#52606d;font-size:13px;margin:4px 0}' +
  '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}' +
  '.card{background:#fff;border:1px solid #d7dbe0;border-radius:8px;padding:12px 14px}' +
  '.card-label{font-size:12px;color:#7b8794;text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px}' +
  '.card-value{font-size:24px;font-weight:700;line-height:1.15}' +
  '.card-sub{font-size:12px;color:#52606d;margin-top:6px}' +
  '.meter{height:7px;border-radius:4px;background:#e6eaee;overflow:hidden;margin:7px 0}' +
  '.meter>span{display:block;height:100%;border-radius:4px}' +
  '.meter>span.ok{background:#1f9d55}.meter>span.bad{background:#c0392b}.meter>span.warn{background:#b7791f}' +
  '.meter>span.muted{background:#9aa5b1}.meter>span.accent{background:#2b6cb0}' +
  '.score{display:flex;align-items:baseline;gap:8px}.score .value{font-size:30px;font-weight:700}' +
  '.score .value.ok{color:#1f9d55}.score .value.bad{color:#c0392b}.score .value.warn{color:#b7791f}' +
  '.cats{list-style:none;margin:10px 0 0;padding:0}' +
  '.cats li{font-size:12px;color:#3e4c59;margin:4px 0}' +
  '.cats .meter{display:inline-block;width:120px;vertical-align:middle;margin:0 8px}' +
  '.chart-row{display:grid;grid-template-columns:220px 1fr 80px;align-items:center;gap:10px;margin:4px 0;font-size:13px}' +
  '.chart-row>span{overflow-wrap:anywhere}' +
  '.chart-row .meter{margin:0}.chart-row .val{text-align:right;color:#3e4c59}' +
  'table{border-collapse:collapse;width:100%;background:#fff;font-size:13px;margin-top:6px}' +
  'th,td{border:1px solid #d7dbe0;padding:6px 8px;text-align:left}th{background:#eef1f4}' +
  'code{background:#eef1f4;padding:1px 4px;border-radius:3px;font-size:12px}' +
  '.callout{border-left:4px solid #6b7280;background:#fff;padding:10px 12px;border-radius:4px;font-size:13px;margin:10px 0}' +
  '.callout.warn{border-color:#b7791f;background:#fffaf0}.callout.bad{border-color:#c0392b;background:#fff5f4}' +
  'details{background:#fff;border:1px solid #d7dbe0;border-radius:8px;padding:8px 14px;margin:12px 0}' +
  'summary{cursor:pointer;font-weight:600;font-size:13px}' +
  'ul{margin:8px 0 0 18px;padding:0}li{margin:3px 0;font-size:13px}' +
  '.foot{color:#7b8794;font-size:12px;margin-top:24px}' +
  // Narrow screens: the fixed label/value columns overflow, so stack the chart
  // row (label + value, then the meter full-width) and let long labels wrap.
  '@media (max-width:680px){' +
  '.grid{grid-template-columns:1fr}' +
  '.chart-row{grid-template-columns:1fr auto}' +
  '.chart-row .meter{grid-column:1 / -1}' +
  '.cats .meter{width:90px}' +
  'body{padding:12px}' +
  '}';

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

function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function ms(value) {
  return isNum(value) ? `${Math.round(value)} ms` : 'n/a';
}

function secs(value) {
  return isNum(value) ? `${(value / 1000).toFixed(2)} s` : 'n/a';
}

function clsVal(value) {
  return isNum(value) ? value.toFixed(4) : 'n/a';
}

function statusClass(status) {
  switch (status) {
    case 'passed':
    case 'completed':
      return 'ok';
    case 'failed':
      return 'bad';
    case 'unstable':
    case 'incomplete':
      return 'warn';
    default:
      return 'muted';
  }
}

// Lighthouse scores are 0..1; everything user-facing is shown as 0..100 with the
// standard threshold bands so a low score cannot read as "fine".
function percent(score) {
  return isNum(score) ? Math.round(score * 100) : null;
}

function scoreClass(pct) {
  if (!isNum(pct)) return 'muted';
  if (pct >= 90) return 'ok';
  if (pct >= 50) return 'warn';
  return 'bad';
}

function badge(text, cls) {
  return `<span class="badge ${cls || 'muted'}">${esc(text)}</span>`;
}

function meter(pct, cls) {
  const width = isNum(pct) ? Math.max(2, Math.min(100, pct)) : 0;
  return `<div class="meter"><span class="${cls || 'muted'}" style="width:${width}%"></span></div>`;
}

function table(headers, rows) {
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function card(label, value, sub) {
  return (
    `<div class="card"><div class="card-label">${esc(label)}</div>` +
    `<div class="card-value">${esc(value)}</div>` +
    (sub ? `<div class="card-sub">${esc(sub)}</div>` : '') +
    '</div>'
  );
}

function verdictCard(label, status, detail) {
  return (
    `<div class="card"><div class="card-label">${esc(label)}</div>` +
    `<div>${badge(status, statusClass(status))}</div>` +
    `<div class="card-sub">${esc(detail)}</div></div>`
  );
}

function dateOnly(iso) {
  if (!iso) return 'n/a';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : String(iso);
}

function environmentLine(env) {
  const e = env || {};
  const bits = [];
  if (e.browser) bits.push(`${e.browser}${e.browserVersion ? ` ${e.browserVersion}` : ''}`);
  if (e.viewport && isNum(e.viewport.width)) bits.push(`${e.viewport.width}x${e.viewport.height}`);
  if (e.os) bits.push(e.os);
  if (e.nodeVersion) bits.push(`Node ${e.nodeVersion}`);
  if (e.lighthouseVersion) bits.push(`Lighthouse ${e.lighthouseVersion}`);
  if (e.lighthouseAudit) {
    const a = e.lighthouseAudit;
    bits.push(`${fmt(a.formFactor)} / ${fmt(a.throttlingMethod)}`);
  }
  return bits.length ? bits.join(' · ') : 'n/a';
}

function metricSummary(metrics) {
  const m = metrics || {};
  const nav = m.navigation || {};
  const timings = m.interactionTimings || {};
  return {
    fcp: m.firstContentfulPaintMs,
    lcp: m.largestContentfulPaintMs,
    cls: m.cumulativeLayoutShift,
    ttfb: nav.ttfbApprox,
    journey: timings['total-journey-duration'],
  };
}

// Lowest per-page Lighthouse performance score (0..1 -> 0..100), used to state
// score quality separately from audit completion.
function lowestPerformance(pages) {
  const scores = (pages || [])
    .map((p) => percent((p.categories || {}).performance))
    .filter(isNum);
  return scores.length ? Math.min(...scores) : null;
}

function sectionVerdicts(s) {
  const ss = s.sectionStatuses || gate.sectionStatuses(s);
  const t = (s.tests && s.tests.summary) || {};
  const lh = s.lighthouse || {};
  const th = s.thresholds || {};

  let functionalDetail;
  if ((t.total || 0) === 0) functionalDetail = 'No functional test results found';
  else functionalDetail = `${t.passed || 0} passed · ${t.failed || 0} failed${t.skipped ? ` · ${t.skipped} skipped` : ''}`;

  let lighthouseDetail;
  if (!lh.available) lighthouseDetail = 'No Lighthouse summary available';
  else if (lh.outcomes) {
    const o = lh.outcomes;
    const lowest = lowestPerformance(lh.pages);
    lighthouseDetail =
      `${o.ok || 0}/${o.total || 0} pages audited` +
      `${o.failed ? ` · ${o.failed} failed` : ''}${o.skipped ? ` · ${o.skipped} skipped` : ''}` +
      (isNum(lowest) ? ` · lowest performance ${lowest}/100` : '');
  } else lighthouseDetail = fmt(lh.status);

  let thresholdDetail;
  if (!th.enabled) thresholdDetail = 'Disabled (observation mode) — cannot fail this build';
  else if ((th.unavailable || []).length) {
    thresholdDetail = `${(th.unavailable || []).length} enforced check(s) could not be evaluated`;
  } else thresholdDetail = `${(th.checks || []).length} configured check(s)${th.strict ? ' · strict' : ''}`;

  return [
    ['Functional tests', ss.functional, functionalDetail],
    ['Lighthouse audits', ss.lighthouse, lighthouseDetail],
    ['Performance thresholds', ss.thresholds, thresholdDetail],
  ];
}

function renderHeadline(s) {
  const run = (s.browserMetrics || [])[0] || {};
  const m = metricSummary(run.metrics);
  const parts = [];
  parts.push('<h2>Headline metrics <span class="hint">(browser-observed, single session)</span></h2>');
  parts.push(
    '<div class="grid">' +
      card('FCP', ms(m.fcp), 'First Contentful Paint') +
      card('LCP', ms(m.lcp), 'Largest Contentful Paint') +
      card('CLS', clsVal(m.cls), 'Layout stability') +
      card('Total journey', secs(m.journey), 'Single-user purchase flow') +
      '</div>'
  );
  return parts.join('\n');
}

function renderLighthouse(s) {
  const lh = s.lighthouse || {};
  const parts = [];
  parts.push('<h2>Lighthouse scores <span class="hint">(lab audit, per page · 0-100)</span></h2>');
  if (!lh.available) {
    parts.push(
      `<p class="meta">Lighthouse summary unavailable${lh.error ? `: ${esc(lh.error)}` : ''}.</p>`
    );
    return parts.join('\n');
  }
  const o = lh.outcomes;
  parts.push(
    `<p class="meta">Audit execution: ${esc(fmt(lh.status))}${
      lh.stale ? ' · stale artifact ignored' : ''
    }${o ? ` · ok=${o.ok || 0} failed=${o.failed || 0} skipped=${o.skipped || 0} of ${o.total || 0}` : ''}</p>`
  );
  parts.push(
    '<p class="meta">Audit completion is separate from score quality: the scores below are ' +
      'informational and are not gated unless a threshold is configured for them.</p>'
  );
  if (lh.status === 'unstable') {
    parts.push(
      '<p class="callout warn">Partial audit: some configured pages were skipped or failed, so these ' +
        'scores do not cover every page. This is not a complete audit.</p>'
    );
  }
  const pages = lh.pages || [];
  if (!pages.length) {
    parts.push('<p class="meta">No page results in the Lighthouse summary.</p>');
    return parts.join('\n');
  }
  const cards = pages.map((p) => {
    const perf = percent((p.categories || {}).performance);
    const cls = scoreClass(perf);
    const catRows = CATEGORY_ORDER.filter((k) => (p.categories || {})[k] !== undefined)
      .map((k) => {
        const c = percent(p.categories[k]);
        return `<li>${esc(CATEGORY_LABELS[k])}${meter(c, scoreClass(c))}${esc(fmt(c))}</li>`;
      })
      .join('');
    return (
      '<div class="card">' +
      `<div class="card-label">${esc(p.name)} <span class="tag">${esc(
        p.authenticated ? 'authenticated' : 'anonymous'
      )}</span></div>` +
      `<div class="score"><span class="value ${cls}">${esc(fmt(perf))}</span>` +
      `<span class="card-sub">Performance</span></div>` +
      (catRows ? `<ul class="cats">${catRows}</ul>` : '') +
      `<div class="card-sub">${esc(p.status)}${p.error ? `: ${esc(p.error)}` : ''}</div>` +
      '</div>'
    );
  });
  parts.push(`<div class="grid">${cards.join('')}</div>`);
  return parts.join('\n');
}

function renderJourney(s) {
  const run = (s.browserMetrics || [])[0] || {};
  const timings = (run.metrics && run.metrics.interactionTimings) || {};
  const rows = Object.entries(timings).filter(([k, v]) => !k.startsWith('overview-') && isNum(v));
  const parts = [];
  parts.push('<h2>User journey timings <span class="hint">(NOT INP)</span></h2>');
  if (!rows.length) {
    parts.push('<p class="meta">No interaction timings found.</p>');
    return parts.join('\n');
  }
  parts.push(
    '<p class="meta">Custom click-to-visible measurements for the single-user flow. INP is not measured.</p>'
  );
  const max = Math.max(...rows.map(([, v]) => v));
  for (const [name, value] of rows) {
    const pct = max > 0 ? (value / max) * 100 : 0;
    parts.push(
      `<div class="chart-row"><span>${esc(name)}</span>${meter(pct, 'accent')}` +
        `<span class="val">${esc(ms(value))}</span></div>`
    );
  }
  return parts.join('\n');
}

function renderBrowserMetrics(s) {
  const runs = s.browserMetrics || [];
  const parts = [];
  parts.push('<h2>Browser metrics <span class="hint">(Playwright, browser-observed)</span></h2>');
  if (!runs.length) {
    parts.push('<p class="meta">No browser metrics artifacts found.</p>');
    return parts.join('\n');
  }
  const m = metricSummary(runs[0].metrics);
  parts.push(
    table(
      ['Metric', 'Value', 'Notes'],
      [
        ['FCP (ms)', esc(fmt(isNum(m.fcp) ? Math.round(m.fcp) : null)), 'Initial document only'],
        ['LCP (ms)', esc(fmt(isNum(m.lcp) ? Math.round(m.lcp) : null)), 'Session-cumulative'],
        ['CLS', esc(clsVal(m.cls)), 'Session-cumulative'],
        ['TTFB approx (ms)', esc(fmt(isNum(m.ttfb) ? Math.round(m.ttfb) : null)), 'Includes redirect + network'],
      ]
    )
  );

  const pages = (runs[0].metrics && runs[0].metrics.pages) || [];
  if (pages.length) {
    parts.push('<h3 class="hint">Checkpoints</h3>');
    const hasRoutes = pages.some((p) => p.sameDocument);
    if (hasRoutes) {
      parts.push(
        '<p class="callout warn"><strong>Session-cumulative values:</strong> checkpoints reached by a ' +
          'client-side route change have no new document load, so their LCP/CLS repeat the session ' +
          'totals above — they are <strong>not</strong> separate per-page measurements. Per-step cost ' +
          'is in the journey timings.</p>'
      );
    }
    parts.push(
      table(
        ['Checkpoint', 'Load type', 'FCP (ms)', 'LCP session (ms)', 'CLS session', 'TTFB approx (ms)'],
        pages.map((p) => [
          esc(p.name),
          esc(p.sameDocument ? 'route (SPA)' : 'document'),
          esc(fmt(isNum(p.firstContentfulPaintMs) ? Math.round(p.firstContentfulPaintMs) : null)),
          esc(p.sameDocument ? 'session' : fmt(isNum(p.largestContentfulPaintMs) ? Math.round(p.largestContentfulPaintMs) : null)),
          esc(p.sameDocument ? 'session' : clsVal(p.cumulativeLayoutShift)),
          esc(fmt(isNum(p.navigation && p.navigation.ttfbApprox) ? Math.round(p.navigation.ttfbApprox) : null)),
        ])
      )
    );
  }
  return parts.join('\n');
}

function renderThresholds(s) {
  const th = s.thresholds || {};
  const parts = [];
  parts.push('<h2>Performance thresholds</h2>');
  if (!th.enabled) {
    parts.push(
      '<p class="callout warn">Disabled (observation mode): no threshold is enforced, so this run ' +
        'passing does not prove any performance target was met.</p>'
    );
    return parts.join('\n');
  }
  if (th.strict) {
    parts.push(
      '<p class="meta">Strict mode: a configured threshold with an unavailable metric fails the build.</p>'
    );
  }
  if ((th.checks || []).length) {
    parts.push(
      table(
        ['Metric', 'Actual', 'Max', 'Status'],
        th.checks.map((c) => [
          esc(c.metric),
          esc(fmt(c.actual)),
          esc(fmt(c.max)),
          badge(c.status, statusClass(c.status === 'passed' ? 'passed' : c.status === 'failed' ? 'failed' : 'unstable')),
        ])
      )
    );
  } else {
    parts.push('<p class="meta">Enabled but no threshold value configured.</p>');
  }
  if ((th.unavailable || []).length) {
    parts.push(
      `<p class="callout warn">${esc(
        th.unavailable.length
      )} enforced threshold(s) could not be evaluated because their metric was unavailable; the run cannot pass.</p>`
    );
  }
  return parts.join('\n');
}

function renderBaseline(s) {
  const b = s.baseline || {};
  const parts = [];
  parts.push('<h2>Baseline comparison</h2>');
  if (!b.attempted) {
    parts.push(
      '<p class="meta">Baseline not configured: no baseline file was found, so no current-vs-baseline ' +
        'comparison was performed.</p>'
    );
    return parts.join('\n');
  }
  if (!b.comparable) {
    parts.push(
      '<p class="callout warn">Baseline present but <strong>inconclusive</strong>: the environments are ' +
        'not comparable, so no regression or improvement is claimed.</p>'
    );
    for (const blocked of b.blockers || []) parts.push(`<p class="meta">Blocked: ${esc(blocked)}</p>`);
  } else {
    parts.push(
      table(
        ['Metric', 'Baseline', 'Current', 'Delta', 'Change %', 'Verdict'],
        (b.deltas || []).map((d) => [
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
  for (const w of b.warnings || []) parts.push(`<p class="meta">Warning: ${esc(w)}</p>`);
  return parts.join('\n');
}

function renderTestDetails(s) {
  const tests = s.tests || {};
  const rows = tests.details || [];
  const parts = [];
  parts.push('<h2>Functional test outcomes</h2>');
  const t = tests.summary || {};
  parts.push(
    table(
      ['Passed', 'Failed', 'Flaky', 'Skipped', 'Total'],
      [[t.passed || 0, t.failed || 0, t.flaky || 0, t.skipped || 0, t.total || 0].map((v) => esc(fmt(v)))]
    )
  );
  if (rows.length) {
    parts.push('<details><summary>Per-test details</summary>');
    parts.push(
      table(
        ['Test', 'Status', 'Duration (ms)'],
        rows.map((d) => [esc(d.title), esc(d.status), esc(fmt(d.durationMs))])
      )
    );
    parts.push('</details>');
  }
  return parts.join('\n');
}

function renderArtifacts(s) {
  const parts = ['<details><summary>Report artifacts</summary><ul>'];
  for (const [label, rel] of Object.entries(s.reports || {})) {
    if (!rel) continue;
    parts.push(`<li>${esc(label)}: <code>${esc(rel)}</code></li>`);
  }
  parts.push('</ul></details>');
  return parts.join('\n');
}

function renderTroubleshooting(s) {
  const failureTypes = s.failureTypes || [];
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
  const parts = ['<details><summary>Troubleshooting</summary><ul>'];
  for (const tip of tips) parts.push(`<li>${esc(tip)}</li>`);
  parts.push('</ul></details>');
  return parts.join('\n');
}

function renderDashboard(summary) {
  const s = summary || {};
  const env = s.environment || {};
  const parts = [];

  parts.push('<!doctype html>');
  parts.push('<html lang="en"><head><meta charset="utf-8">');
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  parts.push('<title>UI Performance PoC - Run Dashboard</title>');
  parts.push(`<style>${STYLE}</style>`);
  parts.push('</head><body><div class="wrap">');

  parts.push('<h1>UI Performance PoC - Run Dashboard</h1>');
  parts.push(
    '<div class="head">' +
      badge(s.status || 'unknown', statusClass(s.status)) +
      `<span class="meta">SauceDemo · Run on ${esc(dateOnly(s.runStartedAt || s.generatedAt))}</span>` +
      `</div>`
  );
  parts.push(`<p class="meta">Run ID: <code>${esc(fmt(s.runId))}</code></p>`);
  parts.push(`<p class="meta">Generated: ${esc(fmt(s.generatedAt))}</p>`);
  parts.push(`<p class="meta">Base URL: ${esc(fmt(s.baseUrl))}</p>`);
  parts.push(`<p class="meta">Environment: ${esc(environmentLine(env))}</p>`);
  parts.push(
    `<p class="meta">Failure reasons: ${esc(
      (s.failureTypes || []).length ? s.failureTypes.join(', ') : 'none'
    )}</p>`
  );

  parts.push('<h2>Run verdicts</h2>');
  parts.push(
    '<div class="grid">' +
      sectionVerdicts(s)
        .map(([label, status, detail]) => verdictCard(label, status, detail))
        .join('') +
      '</div>'
  );
  const th = s.thresholds || {};
  if (!th.enabled) {
    parts.push(
      '<p class="callout warn">This run passed its functional journey and Lighthouse audits, but ' +
        'performance thresholds are disabled, so it does not yet prove the application meets defined ' +
        'performance targets. The result is a single observation.</p>'
    );
  }

  parts.push(renderHeadline(s));
  if ((s.browserMetrics || []).length) parts.push(renderJourney(s));
  parts.push(renderLighthouse(s));
  parts.push(renderBrowserMetrics(s));
  parts.push(renderThresholds(s));
  parts.push(renderBaseline(s));
  parts.push(renderTestDetails(s));
  parts.push(renderArtifacts(s));
  parts.push(renderTroubleshooting(s));

  parts.push(
    '<p class="foot">Lab audit and browser-observed timings are single-session measurements; they ' +
      'complement JMeter load/stress/soak testing and are not real-user monitoring.</p>'
  );
  parts.push('</div></body></html>');
  return `${parts.join('\n')}\n`;
}

function writeDashboard(summary, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderDashboard(summary), 'utf8');
  return file;
}

module.exports = { renderDashboard, writeDashboard };
