'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');
const logger = require('./logger');

// Injected via page.addInitScript before navigation, so observers capture
// buffered entries from the very start. The function is serialized and runs
// inside the browser, therefore it cannot reference anything from this scope.
function browserMetricsInitScript() {
  try {
    window.__uiPerf = { lcp: null, lcpCandidates: [], cls: 0, clsEntries: [], fcp: null };
  } catch (e) {
    return;
  }

  try {
    const lcpObserver = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (!last) return;
      window.__uiPerf.lcp = last.startTime;
      window.__uiPerf.lcpCandidates.push({
        startTime: last.startTime,
        renderTime: typeof last.renderTime === 'number' ? last.renderTime : null,
        element: last.element ? last.element.tagName : null,
        url: last.url || null,
        size: typeof last.size === 'number' ? last.size : null,
      });
    });
    lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) {
    // LCP not observable in this browser.
  }

  try {
    const clsObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // Standard CLS excludes shifts that follow recent user input.
        if (entry.hadRecentInput) continue;
        window.__uiPerf.cls += entry.value;
        window.__uiPerf.clsEntries.push({ value: entry.value, startTime: entry.startTime });
      }
    });
    clsObserver.observe({ type: 'layout-shift', buffered: true });
  } catch (e) {
    // layout-shift not observable in this browser.
  }

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
    // paint timing not observable in this browser.
  }
}

async function attachMetricsCollector(page) {
  await page.addInitScript(browserMetricsInitScript);
}

async function measureInteraction(timings, key, fn) {
  const start = Date.now();
  const result = await fn();
  timings[key] = Date.now() - start;
  return result;
}

// Reads the page-load snapshot from the CURRENT page. Call after an explicit
// readiness point plus the documented observation window (config.metrics.
// lcpObservationMs) so FCP/LCP/CLS have settled. Unavailable metrics are null.
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
        // All values are ms relative to navigation start (time origin).
        navigationStart: num(start),
        responseStart: num(nav.responseStart),
        domInteractive: num(nav.domInteractive),
        domContentLoaded: num(nav.domContentLoadedEventEnd),
        loadEvent: num(nav.loadEventEnd),
        totalNavigationDuration: nav.loadEventEnd > 0 ? num(nav.loadEventEnd - start) : null,
        dnsLookupDuration: num(nav.domainLookupEnd - nav.domainLookupStart),
        tcpConnectionDuration: num(nav.connectEnd - nav.connectStart),
        tlsNegotiationDuration:
          nav.secureConnectionStart > 0 ? num(nav.connectEnd - nav.secureConnectionStart) : null,
        // Approximate TTFB = responseStart - navigationStart. Includes redirect
        // time and does not isolate server processing from network latency.
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

function buildMetricsReport(options = {}) {
  const {
    pageLoad = null,
    runId = config.runId,
    label = 'journey',
    timings = {},
    testStatus = 'unknown',
    baseUrl = config.baseUrl,
    errors = [],
  } = options;

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
      : {
          browser: null,
          browserVersion: null,
          os: { type: os.type(), platform: os.platform(), release: os.release(), arch: os.arch() },
          nodeVersion: process.version,
        },
    observation: {
      lcpObservationMs: config.metrics.lcpObservationMs,
      // LCP is only final after user input or page hide, so the login-page read
      // is an approximation.
      lcpDescription:
        'LCP is read on the login page after the `load` event and a documented ' +
        'observation window. LCP is only truly final after user input or page hide, ' +
        'so this is an approximation.',
      ttfbDescription:
        'TTFB is approximated as responseStart - navigationStart from Navigation Timing; ' +
        'it includes redirect time and does not isolate server processing from network latency.',
      // The click-to-visible timings below are NOT INP; INP is not measured here.
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

// Raw per-run artifact; never overwrites another run's file.
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
