'use strict';

// Fail-fast preflight for local runs and CI: validates the Node/npm toolchain,
// the resolved configuration, and that the Playwright dependency is installed.
// Exits non-zero with an actionable message so the pipeline stops before an
// expensive test run.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOLS_ONLY = process.argv.includes('--tools-only');
const problems = [];
const notes = [];

function parseMin(raw) {
  const m = /^>=\s*(\d+)\.(\d+)\.(\d+)/.exec(String(raw || '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function compare(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  return 0;
}

function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(text || '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function checkNode(engines) {
  const min = parseMin(engines && engines.node);
  const current = parseVersion(process.versions.node);
  if (!min) {
    notes.push(`No parseable "engines.node" requirement; skipping Node check (current ${process.versions.node}).`);
    return;
  }
  if (!current) {
    problems.push(`Could not parse the running Node version "${process.versions.node}".`);
    return;
  }
  const want = min.major + '.' + min.minor + '.' + min.patch;
  if (compare(current, min) < 0) {
    problems.push(`Node ${process.versions.node} is too old; this project requires >= ${want} (Lighthouse 13 requirement).`);
  } else {
    notes.push(`Node ${process.versions.node} satisfies >= ${want}.`);
  }
}

function checkNpm() {
  try {
    // On Windows npm is a .cmd shim, which Node refuses to spawn directly
    // (CVE-2024-27980 mitigation -> EINVAL). Invoke it through cmd.exe instead of
    // using shell:true, which also avoids the DEP0190 deprecation warning.
    const isWin = process.platform === 'win32';
    const file = isWin ? process.env.ComSpec || 'cmd.exe' : 'npm';
    const args = isWin ? ['/d', '/s', '/c', 'npm -v'] : ['-v'];
    const version = execFileSync(file, args, { encoding: 'utf8' }).trim();
    notes.push(`npm ${version} is available.`);
  } catch (err) {
    problems.push(`npm is not available on PATH: ${err.message}`);
  }
}

function checkDependency() {
  try {
    require.resolve('@playwright/test', { paths: [ROOT] });
    notes.push('@playwright/test is installed.');
  } catch (err) {
    problems.push('Dependencies are not installed; run "npm ci" (or "npm install") first.');
  }
}

function checkConfig() {
  let config;
  try {
    config = require('../src/config');
  } catch (err) {
    problems.push(`Configuration failed to load: ${err.message}`);
    return;
  }
  try {
    const url = new URL(config.baseUrl);
    if (!/^https?:$/.test(url.protocol)) {
      problems.push(`BASE_URL must use http/https (got "${config.baseUrl}").`);
    } else {
      notes.push(`Base URL resolves to ${config.baseUrl}.`);
    }
  } catch (err) {
    problems.push(`BASE_URL is not a valid URL: "${config.baseUrl}".`);
  }

  const t = config.thresholds;
  if (t.enabled) {
    const configured = [t.lcpMs, t.cls, t.journeyMs].filter((v) => v !== null && v !== undefined);
    if (configured.length === 0) {
      problems.push('PERF_THRESHOLDS_ENABLED=true but no threshold value (THRESHOLD_LCP_MS / THRESHOLD_CLS / THRESHOLD_JOURNEY_MS) is set.');
    }
    for (const [name, value] of [
      ['THRESHOLD_LCP_MS', t.lcpMs],
      ['THRESHOLD_CLS', t.cls],
      ['THRESHOLD_JOURNEY_MS', t.journeyMs],
    ]) {
      if (value !== null && value !== undefined && (!Number.isFinite(value) || value < 0)) {
        problems.push(`${name} must be a non-negative number (got "${value}").`);
      }
    }
  } else {
    notes.push('Performance thresholds are disabled (observation mode).');
  }

  if (!Array.isArray(config.lighthouse.pages) || config.lighthouse.pages.length === 0) {
    problems.push('No Lighthouse pages configured.');
  }
}

function main() {
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  } catch (err) {
    problems.push(`Could not read package.json: ${err.message}`);
  }

  checkNode(pkg.engines);
  checkNpm();
  if (!TOOLS_ONLY) {
    checkDependency();
    checkConfig();
  }

  for (const note of notes) console.log(`  ok   ${note}`);
  if (problems.length === 0) {
    console.log('Environment check passed.');
    return;
  }
  for (const problem of problems) console.error(`  FAIL ${problem}`);
  console.error(`Environment check failed with ${problems.length} problem(s).`);
  process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = { main, parseMin, parseVersion, compare };
