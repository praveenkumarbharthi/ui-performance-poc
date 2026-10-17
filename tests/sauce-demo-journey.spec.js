'use strict';

/**
 * SauceDemo single-user UI journey with browser performance metrics.
 *
 * This is a functional UI journey (not a load test). It exercises the
 * documented public demo account only and never generates concurrent load.
 *
 * Journey steps:
 *   1.  Open login page and record navigation/browser timings.
 *   2.  Verify the login form is visible.
 *   3.  Sign in with the public demo credentials.
 *   4.  Verify the inventory page loads.
 *   5.  Record login-action -> inventory-ready duration.
 *   6.  Add "Sauce Labs Backpack" to cart and verify the cart badge.
 *   7.  Open the cart and verify product + quantity.
 *   8.  Checkout, fill customer details, continue.
 *   9.  Verify order overview (product/price where stable).
 *   10. Finish checkout and assert confirmation message is visible.
 *   11. Record per-interaction durations and the overall journey duration.
 *   12. Screenshot + trace are captured automatically on failure (config).
 */

const { test, expect } = require('@playwright/test');
const config = require('../src/config');
const logger = require('../src/logger');
const bm = require('../src/browser-metrics');

const PRODUCT_NAME = 'Sauce Labs Backpack';
const PRODUCT_SLUG = 'sauce-labs-backpack';

test.describe('SauceDemo UI performance journey', () => {
  test('single-user purchase journey with browser metrics', async ({ page }, testInfo) => {
    // Register performance observers BEFORE any navigation.
    await bm.attachMetricsCollector(page);

    const timings = {};
    const errors = [];
    const journeyStart = Date.now();
    let testStatus = 'passed';
    let pageLoadSnapshot = null;

    try {
      // 1. Open the login page and record navigation timing.
      await bm.measureInteraction(timings, 'goto-login-page', async () => {
        const response = await page.goto('/', { waitUntil: 'load' });
        expect(response, 'login page navigation should return a response').toBeTruthy();
        expect(response.ok(), `login page HTTP status ${response && response.status()}`).toBeTruthy();
      });

      // 2. Verify the login form is visible.
      await expect(page.locator('#user-name')).toBeVisible();
      await expect(page.locator('#password')).toBeVisible();
      await expect(page.locator('#login-button')).toBeVisible();

      // Documented observation window so FCP/LCP/CLS can settle before reading.
      // The login page is the "page readiness point" for the page-load metrics.
      await page.waitForTimeout(config.metrics.lcpObservationMs);
      pageLoadSnapshot = await bm.collectPageLoadSnapshot(page);

      // 3. Sign in and 4/5. measure login -> inventory ready.
      await page.fill('#user-name', config.credentials.username);
      await page.fill('#password', config.credentials.password);

      await bm.measureInteraction(timings, 'login-to-inventory-ready', async () => {
        await page.click('#login-button');
        await page.waitForSelector('#inventory_container', { state: 'visible' });
        await expect(page.locator('.inventory_item').first()).toBeVisible();
      });
      expect(page.url()).toContain('/inventory.html');

      // 6. Add a product by stable data-test locator and verify the badge.
      await bm.measureInteraction(timings, 'add-to-cart-to-badge-updated', async () => {
        await page.click(`[data-test="add-to-cart-${PRODUCT_SLUG}"]`);
        await expect(page.locator('.shopping_cart_badge')).toHaveText('1');
      });

      // 7. Open the cart and verify product + quantity.
      await bm.measureInteraction(timings, 'open-cart-to-item-verified', async () => {
        await page.click('.shopping_cart_link');
        await expect(page.locator('.cart_item')).toHaveCount(1);
        await expect(page.locator('.cart_item .inventory_item_name')).toHaveText(PRODUCT_NAME);
        await expect(page.locator('.cart_item .cart_quantity')).toHaveText('1');
      });

      // 8. Proceed to checkout, fill test customer details, continue.
      await bm.measureInteraction(timings, 'checkout-form-to-overview', async () => {
        await page.click('[data-test="checkout"]');
        await expect(page.locator('[data-test="firstName"]')).toBeVisible();
        await page.fill('[data-test="firstName"]', 'Perf');
        await page.fill('[data-test="lastName"]', 'Tester');
        await page.fill('[data-test="postalCode"]', '560001');
        await page.click('[data-test="continue"]');
      });

      // 9. Verify the order overview (product/price where stable).
      await expect(page.locator('.cart_item')).toHaveCount(1);
      await expect(page.locator('.cart_item .inventory_item_name')).toHaveText(PRODUCT_NAME);
      const itemPrice = await page.locator('.cart_item .inventory_item_price').first().textContent();
      timings['overview-item-price'] = itemPrice ? itemPrice.trim() : null;
      const subtotal = await page.locator('[data-test="subtotal-label"]').textContent();
      timings['overview-subtotal'] = subtotal ? subtotal.trim() : null;

      // 10. Finish checkout and assert confirmation is visible.
      await bm.measureInteraction(timings, 'checkout-submit-to-confirmation-visible', async () => {
        await page.click('[data-test="finish"]');
        await expect(page.locator('[data-test="complete-header"]')).toBeVisible();
      });
      await expect(page.locator('[data-test="complete-header"]')).toHaveText(
        /thank you for your order/i
      );
    } catch (err) {
      testStatus = 'failed';
      errors.push(err && err.message ? err.message : String(err));
      logger.error(`Journey failed: ${err && err.message ? err.message : String(err)}`);
      throw err;
    } finally {
      timings['total-journey-duration'] = Date.now() - journeyStart;

      // Always collect + persist metrics, even on failure, so the run leaves
      // usable evidence. Guard against the page being closed mid-collection.
      try {
        if (!pageLoadSnapshot) {
          // Failure happened before the login-page snapshot was taken; do a
          // best-effort read of whatever page is current.
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

        // Optional threshold evaluation (disabled by default -> cannot fail).
        evaluateThresholds(metrics, testInfo);
      } catch (collectErr) {
        logger.error(`Failed to collect/write browser metrics: ${collectErr.message}`);
      }
    }
  });
});

/**
 * Optional, disabled-by-default threshold evaluation.
 *
 * A disabled threshold can never fail the build. When enabled, invalid input is
 * rejected and each failing metric is reported explicitly with the overshoot.
 */
function evaluateThresholds(metrics, testInfo) {
  if (!config.thresholds.enabled) return;

  const checks = [];
  const lcp = metrics.metrics.largestContentfulPaintMs;
  const cls = metrics.metrics.cumulativeLayoutShift;
  const journey = metrics.metrics.interactionTimings['total-journey-duration'];

  if (config.thresholds.lcpMs !== null) {
    checks.push({ metric: 'lcpMs', actual: lcp, max: config.thresholds.lcpMs });
  }
  if (config.thresholds.cls !== null) {
    checks.push({ metric: 'cls', actual: cls, max: config.thresholds.cls });
  }
  if (config.thresholds.journeyMs !== null) {
    checks.push({ metric: 'journeyMs', actual: journey, max: config.thresholds.journeyMs });
  }

  for (const check of checks) {
    if (check.actual === null || check.actual === undefined) {
      logger.warn(`Threshold ${check.metric} enabled but metric unavailable; skipping.`);
      continue;
    }
    if (check.actual > check.max) {
      const overshoot = +(check.actual - check.max).toFixed(3);
      const message = `Performance threshold FAILED: ${check.metric}=${check.actual} exceeds max=${check.max} by ${overshoot}`;
      logger.error(message);
      testInfo.annotations.push({ type: 'performance-threshold', description: message });
    } else {
      logger.info(`Performance threshold OK: ${check.metric}=${check.actual} <= max=${check.max}`);
    }
  }
}
