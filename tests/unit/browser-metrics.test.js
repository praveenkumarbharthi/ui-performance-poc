'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const bm = require('../../src/browser-metrics');

function snapshot(name, { timeOrigin, navigation = { ttfbApprox: 100 }, fcp = 120, lcp = 300, cls = 0.01 } = {}) {
  return {
    name,
    pageUrl: `https://example.test/${name}`,
    documentUrl: 'https://example.test/',
    documentTimeOrigin: timeOrigin,
    navigation,
    firstContentfulPaintMs: fcp,
    largestContentfulPaintMs: lcp,
    cumulativeLayoutShift: cls,
    clsShiftCount: 1,
    lcpCandidateCount: 1,
    environment: { browser: 'chromium', browserVersion: '1', viewport: { width: 1280, height: 720 } },
  };
}

test('buildMetricsReport marks single-page route changes as same-document', () => {
  const pages = {
    login: snapshot('login', { timeOrigin: 1000 }),
    inventory: snapshot('inventory', { timeOrigin: 1000 }),
    cart: snapshot('cart', { timeOrigin: 1000 }),
  };
  const report = bm.buildMetricsReport({ pages, primaryPage: 'login', runId: 'r1' });

  const [login, inventory, cart] = report.metrics.pages;
  assert.equal(login.sameDocument, false);
  assert.ok(login.navigation, 'initial document keeps navigation timing');
  assert.equal(login.firstContentfulPaintMs, 120);

  assert.equal(inventory.sameDocument, true);
  assert.equal(inventory.navigation, null, 'no new document navigation');
  assert.equal(inventory.firstContentfulPaintMs, null, 'FCP is per-document');
  assert.match(inventory.note, /route change/i);

  assert.equal(cart.sameDocument, true);
  assert.equal(cart.navigation, null);
});

test('buildMetricsReport keeps metrics for genuine multi-document navigations', () => {
  const pages = {
    login: snapshot('login', { timeOrigin: 1000 }),
    inventory: snapshot('inventory', { timeOrigin: 2000 }),
  };
  const report = bm.buildMetricsReport({ pages, primaryPage: 'login', runId: 'r1' });

  for (const page of report.metrics.pages) {
    assert.equal(page.sameDocument, false);
    assert.ok(page.navigation, `${page.name} keeps its own navigation timing`);
    assert.equal(page.firstContentfulPaintMs, 120);
  }
});

test('buildMetricsReport treats unknown document identity conservatively', () => {
  const pages = {
    login: snapshot('login', { timeOrigin: null }),
    inventory: snapshot('inventory', { timeOrigin: null }),
  };
  const report = bm.buildMetricsReport({ pages, primaryPage: 'login', runId: 'r1' });

  for (const page of report.metrics.pages) {
    assert.equal(page.sameDocument, false, 'unknown identity must not be collapsed');
    assert.ok(page.navigation);
  }
});
