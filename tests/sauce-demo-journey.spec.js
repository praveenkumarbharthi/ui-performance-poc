'use strict';

const { test, expect } = require('@playwright/test');
const config = require('../src/config');
const logger = require('../src/logger');
const bm = require('../src/browser-metrics');
const gate = require('../src/quality-gate');

const PRODUCT_NAME = 'Sauce Labs Backpack';
const PRODUCT_SLUG = 'sauce-labs-backpack';

test.describe('SauceDemo UI performance journey', () => {
  test('single-user purchase journey with browser metrics', async ({ page }, testInfo) => {
    await bm.attachMetricsCollector(page);

    const timings = {};
    const pages = {};
    const errors = [];
    const journeyStart = Date.now();
    let testStatus = 'passed';

    try {
      await bm.measureInteraction(timings, 'goto-login-page', async () => {
        const response = await page.goto('/', { waitUntil: 'load' });
        expect(response, 'login page navigation should return a response').toBeTruthy();
        expect(response.ok(), `login page HTTP status ${response && response.status()}`).toBeTruthy();
      });

      await expect(page.getByTestId('username')).toBeVisible();
      await expect(page.getByTestId('password')).toBeVisible();
      await expect(page.getByTestId('login-button')).toBeVisible();

      // LCP is only final after user input or page hide, so the primary page is
      // sampled after its documented settle window. Later checkpoints are reached
      // by client-side route change (SauceDemo is a single-page app), so their
      // snapshots are flagged sameDocument by buildMetricsReport and their real
      // cost is captured by the interaction timings below.
      await page.waitForTimeout(config.metrics.lcpObservationMs);
      pages.login = await bm.collectPageLoadSnapshot(page, 'login');

      await page.getByTestId('username').fill(config.credentials.username);
      await page.getByTestId('password').fill(config.credentials.password);

      await bm.measureInteraction(timings, 'login-to-inventory-ready', async () => {
        await page.getByTestId('login-button').click();
        await expect(page.getByTestId('inventory-item').first()).toBeVisible();
      });
      await expect(page).toHaveURL(/\/inventory\.html/);

      await bm.measureInteraction(timings, 'add-to-cart-to-badge-updated', async () => {
        await page.getByTestId(`add-to-cart-${PRODUCT_SLUG}`).click();
        await expect(page.getByTestId('shopping-cart-badge')).toHaveText('1');
      });
      pages.inventory = await bm.collectPageLoadSnapshot(page, 'inventory');

      await bm.measureInteraction(timings, 'open-cart-to-item-verified', async () => {
        await page.getByTestId('shopping-cart-link').click();
        await expect(page.locator('.cart_item')).toHaveCount(1);
        await expect(page.getByTestId('inventory-item-name')).toHaveText(PRODUCT_NAME);
        await expect(page.getByTestId('item-quantity')).toHaveText('1');
      });
      pages.cart = await bm.collectPageLoadSnapshot(page, 'cart');

      await bm.measureInteraction(timings, 'open-checkout-form', async () => {
        await page.getByTestId('checkout').click();
        await expect(page.getByTestId('firstName')).toBeVisible();
      });
      await page.getByTestId('firstName').fill('Perf');
      await page.getByTestId('lastName').fill('Tester');
      await page.getByTestId('postalCode').fill('560001');
      pages['checkout-form'] = await bm.collectPageLoadSnapshot(page, 'checkout-form');

      await bm.measureInteraction(timings, 'checkout-form-to-overview', async () => {
        await page.getByTestId('continue').click();
        await expect(page.locator('.cart_item')).toHaveCount(1);
      });

      await expect(page.getByTestId('inventory-item-name')).toHaveText(PRODUCT_NAME);
      const itemPrice = await page.getByTestId('inventory-item-price').first().textContent();
      timings['overview-item-price'] = itemPrice ? itemPrice.trim() : null;
      const subtotal = await page.getByTestId('subtotal-label').textContent();
      timings['overview-subtotal'] = subtotal ? subtotal.trim() : null;
      pages['checkout-overview'] = await bm.collectPageLoadSnapshot(page, 'checkout-overview');

      await bm.measureInteraction(timings, 'checkout-submit-to-confirmation-visible', async () => {
        await page.getByTestId('finish').click();
        await expect(page.getByTestId('complete-header')).toBeVisible();
      });
      await expect(page.getByTestId('complete-header')).toHaveText(/thank you for your order/i);
      pages.confirmation = await bm.collectPageLoadSnapshot(page, 'confirmation');
    } catch (err) {
      testStatus = 'failed';
      const message = err && err.message ? err.message : String(err);
      errors.push(message);
      logger.error(`Journey failed: ${message}`);
      throw err;
    } finally {
      timings['total-journey-duration'] = Date.now() - journeyStart;

      // Persist metrics even on failure so the run still leaves usable evidence.
      try {
        const metrics = bm.buildMetricsReport({
          pages,
          primaryPage: 'login',
          runId: config.runId,
          label: 'sauce-demo-journey',
          timings,
          testStatus,
          baseUrl: config.baseUrl,
          errors,
        });
        const file = bm.writeMetricsFile(metrics, 'sauce-demo-journey');

        await testInfo.attach('browser-metrics', {
          path: file,
          contentType: 'application/json',
        });

        annotateThresholds(metrics, testInfo);
      } catch (collectErr) {
        logger.error(`Failed to collect/write browser metrics: ${collectErr.message}`);
      }
    }
  });
});

// Enforcement lives in report-summary.js (it fails the build). Here a breach is
// only recorded as an annotation so the functional journey result stays the
// authoritative pass/fail signal for the test itself.
function annotateThresholds(metrics, testInfo) {
  const result = gate.evaluateThresholds(config.thresholds, metrics.metrics);
  for (const warning of result.warnings) logger.warn(warning);

  for (const check of result.checks) {
    const detail = `${check.metric}: actual=${check.actual} max=${check.max}`;
    if (check.status === 'failed') {
      const message = `Performance threshold FAILED: ${detail} (overshoot ${check.overshoot})`;
      logger.error(message);
      testInfo.annotations.push({ type: 'performance-threshold', description: message });
    } else {
      logger.info(`Performance threshold ${check.status}: ${detail}`);
    }
  }
}
