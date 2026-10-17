'use strict';

/**
 * Reusable browser performance metrics collector.
 *
 * Design notes
 * ------------
 * - Observers (LCP / CLS / FCP) are registered via `page.addInitScript` BEFORE
 *   navigation so that buffered entries are captured from the very beginning.
 * - Any metric that is unavailable in the current browser/environment is
 *   reported as `null`. Values are never invented or estimated.
 * - These are BROWSER-OBSERVED timings. They are NOT server-side timings and
 *   they are NOT the same as Lighthouse lab metrics.
 * - We deliberately do NOT label a custom click-to-visible duration as "INP".
 *   INP is not measured here; that is stated explicitly in the output.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');
const logger = require('./logger');

/**
 * Init script injected into every page/frame before any navigation.
 * Must be self-contained (it is serialized and executed inside the browser),
 * so it cannot reference anything from this module's scope.
 */
function browserMetricsInitScript() {
  try {
    window.__uiPerf = { lcp: null, lcpCandidates: [], cls: 0, clsEntries: [], fcp: null };
  } catch (e) {
    return;
  }

  // Largest Contentful Paint (candidate values are emitted over time).
  try {
    const lcpObserver = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) {
        window.__uiPerf.lcp = last.startTime;
        window.__uiPerf.lcpCandidates.push({
          startTime: last.startTime,
          renderTime: typeof last.renderTime === 'number' ? last.renderTime : null,
          element: last.element ? last.element.tagName : null,
          url: last.url || null,
          size: typeof last.size === 'number' ? last.size : null,
        });
      }
    });
    lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) {
    /* LCP unsupported in this browser */
  }

  // Cumulative Layout Shift (standard calculation excludes shifts with recent input).
  try {
    const clsObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) {
          window.__uiPerf.cls += entry.value;
          window.__uiPerf.clsEntries.push({ value: entry.value, startTime: entry.startTime });
        }
      }
    });
    clsObserver.observe({ type: 'layout-shift', buffered: true });
  } catch (e) {
    /* layout-shift unsupported in this browser */
  }

  // First Contentful Paint (paint timing).
  try {
    const paintObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === 'first-contentful-paint') {
          window.__uiPerf.fcp = entry.startTime;
        }
      }
    });
    paintObserver.observe({ type: 'paint', buffered: true });
  } catch (e) {
    /* paint timing unsupported in this browser */
  }
}

/** Register the performance observers before navigation. */
async function attachMetricsCollector(page) {
  await page.addInitScript(browserMetricsInitScript);
}

/**
 * Small helper: measure the wall-clock duration of an async interaction and
 * record it (rounded to whole ms) into a timings object under a stable key.
 */
async function measureInteraction(timings, key, fn) {
  const start = Date.now();
  const result = await fn();
  timings[key] = Date.now() - start;
  return result;
}

/**
 * Read a browser-observed page-load snapshot from the CURRENT page.
 *
 * Call this after an explicit readiness point + documented observation window
 * (see config.metrics.lcpObservationMs) so that FCP/LCP/CLS have settled.
 * Returns `null` for any unavailable metric - values are never invented.
 */
async function collectPageLoadSnapshot(page) {
  const raw = await page.evaluate(() => {
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

    const navEntries = performance.getEntriesByType('navigation') || [];
    const nav = navEntries.length ? navEntries[0] : null;
    const paints = performance.getEntriesByType('paint') || [];
    const fcpEntry = paints.find((p) => p.name === 'first-contentful-paint') || null;
    const ui = window.__uiPerf || null;

    let navigation = null;
    if (nav) {
      const start = nav.startTime || 0;
      navigation = {
        // All values below are ms relative to navigation start (time origin).
        navigationStart: num(start),
        responseStart: num(nav.responseStart),
        domInteractive: num(nav.domInteractive),
        domContentLoaded: num(nav.domContentLoadedEventEnd),
        loadEvent: num(nav.loadEventEnd),
        totalNavigationDuration:
          nav.loadEventEnd > 0 ? num(nav.loadEventEnd - start) : null,
        dnsLookupDuration: num(nav.domainLookupEnd - nav.domainLookupStart),
        tcpConnectionDuration: num(nav.connectEnd - nav.connectStart),
        tlsNegotiationDuration:
          nav.secureConnectionStart > 0
            ? num(nav.connectEnd - nav.secureConnectionStart)
            : null,
        // Approximate TTFB = responseStart - navigationStart.
        // Limitation: includes redirect time and does not isolate server
        // processing from network latency. See docs/metrics-glossary.md.
        ttfbApprox: num(nav.responseStart - start),
        transferSize: num(nav.transferSize),
        encodedBodySize: num(nav.encodedBodySize),
        nextHopProtocol: nav.nextHopProtocol || null,
      };
    }

    return {
      navigation,
      firstContentfulPaintMs: fcpEntry ? num(fcpEntry.startTime) : null,
      largestContentfulPaintMs: ui ? num(ui.lcp) : null,
      cumulativeLayoutShift: ui ? num(ui.cls) : null,
      clsShiftCount: ui && Array.isArray(ui.clsEntries) ? ui.clsEntries.length : null,
      lcpCandidateCount: ui && Array.isArray(ui.lcpCandidates) ? ui.lcpCandidates.length : null,
      observedUserAgent: navigator.userAgent,
      deviceMemoryGb: typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : null,
      hardwareConcurrency:
        typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : null,
      pageUrl: location.href,
    };
  });

  const browser = page.context().browser();
  const browserName = browser ? browser.browserType().name() : null;
  const browserVersion = browser ? browser.version() : null;

  return {
    pageUrl: raw.pageUrl,
    navigation: raw.navigation,
    firstContentfulPaintMs: raw.firstContentfulPaintMs,
    largestContentfulPaintMs: raw.largestContentfulPaintMs,
    cumulativeLayoutShift: raw.cumulativeLayoutShift,
    clsShiftCount: raw.clsShiftCount,
    lcpCandidateCount: raw.lcpCandidateCount,
    environment: {
      browser: browserName,
      browserVersion,
      userAgent: raw.observedUserAgent,
      os: {
        type: os.type(),
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
      },
      viewport: page.viewportSize(),
      deviceMemoryGb: raw.deviceMemoryGb,
      hardwareConcurrency: raw.hardwareConcurrency,
      nodeVersion: process.version,
    },
  };
}

/**
 * Assemble the final browser metrics report from a page-load snapshot plus the
 * journey interaction timings.
 *
 * `pageLoad` is the object returned by `collectPageLoadSnapshot` (or null when
 * the snapshot could not be taken); unavailable metrics are reported as null.
 */
function buildMetricsReport(options) {
  const {
    pageLoad = null,
    runId = config.runId,
    label = 'journey',
    timings = {},
    testStatus = 'unknown',
    baseUrl = config.baseUrl,
    errors = [],
  } = options || {};

  return {
    schemaVersion: '1.0',
    runId,
    label,
    testStatus,
    timestamp: new Date().toISOString(),
    baseUrl,
    pageUrl: pageLoad ? pageLoad.pageUrl : null,
    environment: pageLoad
      ? pageLoad.environment
      : { browser: null, browserVersion: null, os: { type: os.type(), platform: os.platform(), release: os.release(), arch: os.arch() }, nodeVersion: process.version },
    observation: {
      lcpObservationMs: config.metrics.lcpObservationMs,
      lcpDescription:
        'LCP is read on the login page after the `load` event and a documented ' +
        'observation window. LCP is only truly final after user input or page hide, ' +
        'so this is an approximation.',
      ttfbDescription:
        'TTFB is approximated as responseStart - navigationStart from Navigation Timing; ' +
        'it includes redirect time and does not isolate server processing from network latency.',
      inpDescription:
        'INP is NOT measured. Interaction durations below are custom click-to-visible ' +
        'measurements and must not be interpreted as INP.',
      jmeterNote:
        'These are browser-observed, single-session timings and are not server-side or ' +
        'load-test measurements; they complement JMeter rather than replace it.',
    },
    metrics: {
      navigation: pageLoad ? pageLoad.navigation : null,
      firstContentfulPaintMs: pageLoad ? pageLoad.firstContentfulPaintMs : null,
      largestContentfulPaintMs: pageLoad ? pageLoad.largestContentfulPaintMs : null,
      cumulativeLayoutShift: pageLoad ? pageLoad.cumulativeLayoutShift : null,
      clsShiftCount: pageLoad ? pageLoad.clsShiftCount : null,
      lcpCandidateCount: pageLoad ? pageLoad.lcpCandidateCount : null,
      interactionTimings: timings,
    },
    errors,
  };
}

/** Persist a metrics object as a raw JSON artifact for the current run. */
function writeMetricsFile(metrics, label) {
  const dir = path.join(config.paths.raw, config.runId, 'browser-metrics');
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(label).replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
  const file = path.join(dir, `browser-metrics-${safe}.json`);
  fs.writeFileSync(file, `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');
  logger.debug(`Wrote browser metrics artifact: ${file}`);
  return file;
}

module.exports = {
  attachMetricsCollector,
  measureInteraction,
  collectPageLoadSnapshot,
  buildMetricsReport,
  writeMetricsFile,
};
