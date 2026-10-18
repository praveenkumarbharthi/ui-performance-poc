'use strict';

const { test, expect } = require('@playwright/test');
const config = require('../src/config');
const logger = require('../src/logger');
const bm = require('../src/browser-metrics');

const PRODUCT_NAME = 'Sauce Labs Backpack';
const PRODUCT_SLUG = 'sauce-labs-backpack';

test.describe('SauceDemo UI performance journey', () => {
  test('single-user purchase journey with browser metrics', async ({ page }, testInfo) => {
    await bm.attachMetricsCollector(page);

    const timings = {};
    const errors = [];
    const journeyStart = Date.now();
    let testStatus = 'passed';
    let pageLoadSnapshot = null;

    try {
      await bm.measureInteraction(timings, 'goto-login-page', async () => {
        const response = await page.goto('/', { waitUntil: 'load' });
        expect(response, 'login page navigation should return a response').toBeTruthy();
        expect(response.ok(), `login page HTTP status ${response && response.status()}`).toBeTruthy();
      });

      await expect(page.getByTestId('username')).toBeVisible();
      await expect(page.getByTestId('password')).toBeVisible();
      await expect(page.getByTestId('login-button')).toBeVisible();

      // LCP is only final after user input or page hide, so the login page is
      // sampled after a documented settle window before the snapshot is read.
      await page.waitForTimeout(config.metrics.lcpObservationMs);
      pageLoadSnapshot = await bm.collectPageLoadSnapshot(page);

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

      await bm.measureInteraction(timings, 'open-cart-to-item-verified', async () => {
        await page.getByTestId('shopping-cart-link').click();
        await expect(page.locator('.cart_item')).toHaveCount(1);
        await expect(page.getByTestId('inventory-item-name')).toHaveText(PRODUCT_NAME);
        await expect(page.getByTestId('item-quantity')).toHaveText('1');
      });

      await bm.measureInteraction(timings, 'checkout-form-to-overview', async () => {
        await page.getByTestId('checkout').click();
        await expect(page.getByTestId('firstName')).toBeVisible();
        await page.getByTestId('firstName').fill('Perf');
        await page.getByTestId('lastName').fill('Tester');
        await page.getByTestId('postalCode').fill('560001');
        await page.getByTestId('continue').click();
      });

      await expect(page.locator('.cart_item')).toHaveCount(1);
      await expect(page.getByTestId('inventory-item-name')).toHaveText(PRODUCT_NAME);
      const itemPrice = await page.getByTestId('inventory-item-price').first().textContent();
      timings['overview-item-price'] = itemPrice ? itemPrice.trim() : null;
      const subtotal = await page.getByTestId('subtotal-label').textContent();
      timings['overview-subtotal'] = subtotal ? subtotal.trim() : null;

      await bm.measureInteraction(timings, 'checkout-submit-to-confirmation-visible', async () => {
        await page.getByTestId('finish').click();
        await expect(page.getByTestId('complete-header')).toBeVisible();
      });
      await expect(page.getByTestId('complete-header')).toHaveText(/thank you for your order/i);
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
        if (!pageLoadSnapshot) {
          pageLoadSnapshot = await bm.collectPageLoadSnapshot(page);
        }
        const metrics = bm.buildMetricsReport({
          pageLoad: pageLoadSnapshot,
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

        evaluateThresholds(metrics, testInfo);
      } catch (collectErr) {
        logger.error(`Failed to collect/write browser metrics: ${collectErr.message}`);
      }
    }
  });
});

// Thresholds are disabled by default. When enabled, a breach is recorded as a
// test annotation rather than thrown, so the functional journey result stays
// the authoritative pass/fail signal.
function evaluateThresholds(metrics, testInfo) {
  if (!config.thresholds.enabled) return;

  const checks = [
    { metric: 'lcpMs', actual: metrics.metrics.largestContentfulPaintMs, max: config.thresholds.lcpMs },
    { metric: 'cls', actual: metrics.metrics.cumulativeLayoutShift, max: config.thresholds.cls },
    {
      metric: 'journeyMs',
      actual: metrics.metrics.interactionTimings['total-journey-duration'],
      max: config.thresholds.journeyMs,
    },
  ];

  for (const check of checks) {
    if (check.max === null || check.max === undefined) continue;
    if (check.actual === null || check.actual === undefined) {
      logger.warn(`Threshold ${check.metric} enabled but metric unavailable; skipping.`);
      continue;
    }
    if (check.actual <= check.max) {
      logger.info(`Performance threshold OK: ${check.metric}=${check.actual} <= max=${check.max}`);
      continue;
    }
    const overshoot = +(check.actual - check.max).toFixed(3);
    const message = `Performance threshold FAILED: ${check.metric}=${check.actual} exceeds max=${check.max} by ${overshoot}`;
    logger.error(message);
    testInfo.annotations.push({ type: 'performance-threshold', description: message });
  }
}
