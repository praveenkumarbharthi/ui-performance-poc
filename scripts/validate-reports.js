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
function checkLighthouse(label, dir, { optional = false } = {}) {
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
  if (pages.length === 0) {
    return { ...base, ok: false, reason: 'no page results in summary' };
  }

  const ok = pages.filter((pg) => pg.status === 'ok');
  if (ok.length === 0) {
    return { ...base, ok: false, reason: `all ${pages.length} page audit(s) failed` };
  }

  const missing = [];
  for (const pg of ok) {
    for (const kind of ['html', 'json']) {
      const relPath = pg.reports && pg.reports[kind];
      if (!relPath) continue;
      const abs = path.join(config.projectRoot, relPath);
      if (!fs.existsSync(abs) || fs.statSync(abs).size === 0) missing.push(relPath);
    }
  }
  if (missing.length > 0) {
    return { ...base, ok: false, reason: `missing page report(s): ${missing.join(', ')}` };
  }

  return { ...base, reason: `valid-json (${ok.length}/${pages.length} pages, reports present)` };
}

function main() {
  const p = config.paths;
  const checks = [
    checkHtmlDir('Playwright HTML report', p.playwright.html, { optional: true }),
    checkJson('Playwright JSON report', p.playwright.json),
    checkXml('JUnit XML report', p.junit),
    checkJson('Merged browser metrics JSON', p.browserMetrics),
    checkLighthouse('Lighthouse page audit', p.lighthouse, { optional: true }),
    checkJson('Consolidated summary JSON', p.summaryJson),
    checkFile('Markdown summary', p.summaryMarkdown),
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

module.exports = { main };
