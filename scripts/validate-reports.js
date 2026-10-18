'use strict';

// Quality gate for the expected report artifacts: exist, non-empty, and parse
// as JSON / XML / HTML. Exit codes: 0 = all required checks pass, 1 = a required
// check failed. Optional artifacts only warn unless --strict is passed.

const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const logger = require('../src/logger');

const STRICT = process.argv.includes('--strict');

function checkFile(label, file, { optional = false } = {}) {
  if (!fs.existsSync(file)) {
    return { label, file, ok: optional, optional, reason: 'missing' };
  }
  const stat = fs.statSync(file);
  if (stat.size === 0) {
    return { label, file, ok: optional, optional, reason: 'empty' };
  }
  return { label, file, ok: true, optional, reason: 'ok', size: stat.size };
}

function checkJson(label, file, { optional = false } = {}) {
  const base = checkFile(label, file, { optional });
  if (!base.ok) return base;
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...base, reason: 'valid-json' };
  } catch (err) {
    return { ...base, ok: false, reason: `invalid-json: ${err.message}` };
  }
}

function checkXml(label, file, { optional = false } = {}) {
  const base = checkFile(label, file, { optional });
  if (!base.ok) return base;
  const text = fs.readFileSync(file, 'utf8').trim();
  const looksXml = text.startsWith('<?xml') || /<testsuites[\s>]/.test(text) || /<testsuite[\s>]/.test(text);
  return { ...base, ok: looksXml, reason: looksXml ? 'valid-xml' : 'not-xml' };
}

function checkHtml(label, file, { optional = false } = {}) {
  const base = checkFile(label, file, { optional });
  if (!base.ok) return base;
  const text = fs.readFileSync(file, 'utf8').trim().toLowerCase();
  const looksHtml = text.includes('<html') || text.startsWith('<!doctype');
  return { ...base, ok: looksHtml, reason: looksHtml ? 'valid-html' : 'not-html' };
}

function checkHtmlDir(label, dir, { optional = false } = {}) {
  const index = path.join(dir, 'index.html');
  return checkHtml(label, index, { optional });
}

// Validates the Lighthouse summary plus every per-page report it references.
// Artifact validity (files exist and parse) is deliberately kept separate from
// test success (whether the audits passed): failed/skipped pages are reported in
// the counts but do not by themselves fail this check.
function checkLighthouse(label, dir, options = {}) {
  const {
    optional = false,
    root = config.projectRoot,
    expectedPages = config.lighthouse.pages.map((p) => p.name),
  } = options;

  const summaryFile = path.join(dir, 'summary.json');
  const base = checkJson(label, summaryFile, { optional });
  if (!base.ok) return base;

  let summary;
  try {
    summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  } catch (err) {
    return { ...base, ok: false, reason: `invalid-json: ${err.message}` };
  }

  const pages = Array.isArray(summary.pages) ? summary.pages : [];
  const successful = pages.filter((pg) => pg.status === 'ok');
  const failed = pages.filter((pg) => pg.status === 'failed');
  const skipped = pages.filter((pg) => pg.status === 'skipped');
  const reported = new Set(pages.map((pg) => pg.name));
  const missingPages = expectedPages.filter((name) => !reported.has(name));

  // Counts are always reported so partial completion is explicit rather than
  // hidden behind a single "ok" flag.
  const counts =
    `expected=${expectedPages.length}, successful=${successful.length}, ` +
    `failed=${failed.length}, skipped=${skipped.length}` +
    (missingPages.length ? `, missing=${missingPages.length}` : '');

  if (pages.length === 0) {
    return { ...base, ok: false, reason: `no page results in summary (${counts})` };
  }
  if (missingPages.length > 0) {
    // No evidence at all for a configured page: an artifact-validity problem,
    // distinct from a page that ran and failed.
    return {
      ...base,
      ok: false,
      reason: `configured page(s) not reported: ${missingPages.join(', ')} (${counts})`,
    };
  }
  if (successful.length === 0) {
    return { ...base, ok: false, reason: `no successful page audit (${counts})` };
  }

  const missingFiles = [];
  for (const pg of successful) {
    for (const kind of ['html', 'json']) {
      const relPath = pg.reports && pg.reports[kind];
      if (!relPath) continue;
      const abs = path.isAbsolute(relPath) ? relPath : path.join(root, relPath);
      if (!fs.existsSync(abs) || fs.statSync(abs).size === 0) missingFiles.push(relPath);
    }
  }
  if (missingFiles.length > 0) {
    return { ...base, ok: false, reason: `missing page report(s): ${missingFiles.join(', ')} (${counts})` };
  }

  return { ...base, reason: `valid-json (${counts})` };
}

// Validates the consolidated summary's structure, status vocabulary, and that
// every configured Lighthouse page is accounted for. This checks report *validity*
// only; it deliberately does not assert test/audit success (that is the summary's
// job, so the two concerns stay separate).
function checkConsolidatedSummary(label, file) {
  const base = checkJson(label, file);
  if (!base.ok) return base;

  let summary;
  try {
    summary = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { ...base, ok: false, reason: `invalid-json: ${err.message}` };
  }

  const problems = [];
  for (const key of ['schemaVersion', 'status', 'tests', 'thresholds', 'lighthouse', 'browserMetrics', 'failureTypes']) {
    if (summary[key] === undefined) problems.push(`missing key "${key}"`);
  }
  const validStatus = ['passed', 'failed', 'unstable', 'no-data'];
  if (summary.status && !validStatus.includes(summary.status)) {
    problems.push(`invalid status "${summary.status}"`);
  }

  const expectedPages = config.lighthouse.pages.map((p) => p.name);
  const reported = new Set(
    summary.lighthouse && Array.isArray(summary.lighthouse.pages)
      ? summary.lighthouse.pages.map((p) => p.name)
      : []
  );
  if (summary.lighthouse && summary.lighthouse.available) {
    for (const name of expectedPages) {
      if (!reported.has(name)) problems.push(`configured Lighthouse page "${name}" not reported`);
    }
  }

  if (problems.length > 0) {
    return { ...base, ok: false, reason: `summary issues: ${problems.join('; ')}` };
  }
  return { ...base, reason: `valid-json (status=${summary.status})` };
}

function main() {
  const p = config.paths;
  const checks = [
    checkHtmlDir('Playwright HTML report', p.playwright.html, { optional: true }),
    checkJson('Playwright JSON report', p.playwright.json),
    checkXml('JUnit XML report', p.junit),
    checkJson('Merged browser metrics JSON', p.browserMetrics),
    checkLighthouse('Lighthouse page audit', p.lighthouse, { optional: true }),
    checkConsolidatedSummary('Consolidated summary JSON', p.summaryJson),
    checkFile('Markdown summary', p.summaryMarkdown),
    checkHtml('Run dashboard HTML', p.dashboard),
  ];

  let failures = 0;
  let warnings = 0;

  logger.info('Report validation results:');
  for (const c of checks) {
    const rel = path.relative(config.projectRoot, c.file).replace(/\\/g, '/');
    if (c.ok) {
      logger.info(`  PASS  ${c.label} (${c.reason}) -> ${rel}`);
    } else if (c.optional && !STRICT) {
      warnings += 1;
      logger.warn(`  WARN  ${c.label} (${c.reason}) -> ${rel}`);
    } else {
      failures += 1;
      logger.error(`  FAIL  ${c.label} (${c.reason}) -> ${rel}`);
    }
  }

  logger.info(`Validation complete: ${checks.length - failures - warnings} passed, ${warnings} warnings, ${failures} failures.`);
  if (failures > 0) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = { main, checkLighthouse, checkConsolidatedSummary };
