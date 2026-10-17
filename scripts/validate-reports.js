'use strict';

/**
 * Validates that the expected report artifacts exist, are non-empty, and parse
 * correctly as JSON / XML / HTML. Used as a quality gate in `npm run all`.
 *
 * Exit code: 0 when all checks pass, 1 when any required check fails.
 * Optional artifacts (e.g. Lighthouse when the audit could not run) produce a
 * warning but do not fail the build unless --strict is passed.
 */

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

function main() {
  const p = config.paths;
  const checks = [
    checkHtmlDir('Playwright HTML report', p.playwright.html, { optional: true }),
    checkJson('Playwright JSON report', p.playwright.json),
    checkXml('JUnit XML report', p.junit),
    checkJson('Merged browser metrics JSON', p.browserMetrics),
    checkHtml('Lighthouse HTML report', path.join(p.lighthouse, 'lighthouse-report.html'), { optional: true }),
    checkJson('Lighthouse JSON report', path.join(p.lighthouse, 'lighthouse-report.json'), { optional: true }),
    checkJson('Lighthouse summary JSON', path.join(p.lighthouse, 'summary.json'), { optional: true }),
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
