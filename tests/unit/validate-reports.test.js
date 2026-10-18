'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkLighthouse } = require('../../scripts/validate-reports');

const EXPECTED = ['login', 'cart', 'product-detail'];

function page(name, status) {
  return {
    name,
    status,
    reports: {
      html: `reports/lighthouse/${name}.report.html`,
      json: `reports/lighthouse/${name}.report.json`,
    },
  };
}

// Builds an isolated reports tree and returns the check result for it.
function run(pages, { writeReports = true, expectedPages = EXPECTED } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'valrep-'));
  try {
    const dir = path.join(root, 'reports', 'lighthouse');
    fs.mkdirSync(dir, { recursive: true });

    for (const pg of pages) {
      for (const [kind, rel] of Object.entries(pg.reports || {})) {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const body = writeReports ? (kind === 'json' ? '{}' : '<html></html>') : '';
        fs.writeFileSync(abs, body, 'utf8');
      }
    }

    fs.writeFileSync(
      path.join(dir, 'summary.json'),
      JSON.stringify({ status: 'ok', pages }),
      'utf8'
    );

    return checkLighthouse('Lighthouse page audit', dir, { root, expectedPages });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('checkLighthouse passes when every configured page succeeds', () => {
  const result = run(EXPECTED.map((n) => page(n, 'ok')));
  assert.equal(result.ok, true);
  assert.match(result.reason, /expected=3, successful=3, failed=0, skipped=0/);
});

test('checkLighthouse reports partial success explicitly but keeps artifact validity', () => {
  const result = run([page('login', 'ok'), page('cart', 'skipped'), page('product-detail', 'ok')]);
  assert.equal(result.ok, true, 'partial completion is still a valid artifact set');
  assert.match(result.reason, /expected=3, successful=2, failed=0, skipped=1/);
});

test('checkLighthouse fails when no page succeeded', () => {
  const result = run(EXPECTED.map((n) => page(n, 'failed')));
  assert.equal(result.ok, false);
  assert.match(result.reason, /no successful page audit/);
  assert.match(result.reason, /expected=3, successful=0, failed=3, skipped=0/);
});

test('checkLighthouse fails when a configured page is entirely missing', () => {
  const result = run([page('login', 'ok')]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /configured page\(s\) not reported: cart, product-detail/);
  assert.match(result.reason, /missing=2/);
});

test('checkLighthouse fails when a successful page report file is empty', () => {
  const result = run([page('login', 'ok')], { writeReports: false, expectedPages: ['login'] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing page report\(s\)/);
});

test('checkLighthouse fails when the summary has no page results', () => {
  const result = run([], { expectedPages: [] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no page results in summary/);
});
