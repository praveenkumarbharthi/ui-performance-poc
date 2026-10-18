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
// readiness point; add the documented observation window (config.metrics.
// lcpObservationMs) when the page must settle before reading LCP. Unavailable
// metrics are null rather than an invented value.
async function collectPageLoadSnapshot(page, name = 'page') {
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
      // Identity of the document these numbers belong to. In a single-page app the
      // observer state and the navigation entry persist across route changes, so
      // this is what lets the reporter tell a real page load from a client-side
      // route change instead of duplicating one document's metrics under many
      // page names.
      documentTimeOrigin: num(performance.timeOrigin),
      documentUrl: nav ? nav.name || null : null,
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
    name,
    pageUrl: raw.pageUrl,
    documentUrl: raw.documentUrl,
    documentTimeOrigin: raw.documentTimeOrigin,
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

function defaultEnvironment() {
  return {
    browser: null,
    browserVersion: null,
    os: { type: os.type(), platform: os.platform(), release: os.release(), arch: os.arch() },
    nodeVersion: process.version,
  };
}

// `pages` maps a checkpoint name to a collectPageLoadSnapshot() result. The
// primary page also drives the top-level metric fields so threshold evaluation
// and long-standing report consumers keep a single, well-defined target.
function buildMetricsReport(options = {}) {
  const {
    pages = {},
    primaryPage = 'login',
    runId = config.runId,
    label = 'journey',
    timings = {},
    testStatus = 'unknown',
    baseUrl = config.baseUrl,
    errors = [],
  } = options;

  const names = Object.keys(pages);
  const primaryName = pages[primaryPage] ? primaryPage : names[0] || null;
  const primary = primaryName ? pages[primaryName] : null;

  // Document-level metrics (navigation timing, FCP) are only valid for the
  // checkpoint that actually loaded a document. SauceDemo is a single-page app,
  // so every checkpoint after the first is a client-side route change: repeating
  // the initial document's numbers under those names would misrepresent them as a
  // fresh page load. LCP/CLS are kept because they keep accumulating across
  // routes, and are labelled as cumulative.
  const seenDocuments = new Set();
  const pageList = names.map((name) => {
    const snapshot = pages[name];
    const hasIdentity =
      snapshot.documentTimeOrigin !== null && snapshot.documentTimeOrigin !== undefined;
    const docKey = hasIdentity ? `t:${snapshot.documentTimeOrigin}` : `n:${name}`;
    const sameDocument = seenDocuments.has(docKey);
    seenDocuments.add(docKey);
    return {
      name,
      url: snapshot.pageUrl,
      documentUrl: snapshot.documentUrl || null,
      sameDocument,
      navigation: sameDocument ? null : snapshot.navigation,
      firstContentfulPaintMs: sameDocument ? null : snapshot.firstContentfulPaintMs,
      largestContentfulPaintMs: snapshot.largestContentfulPaintMs,
      cumulativeLayoutShift: snapshot.cumulativeLayoutShift,
      clsShiftCount: snapshot.clsShiftCount,
      lcpCandidateCount: snapshot.lcpCandidateCount,
      note: sameDocument
        ? 'Client-side route change in a single-page app: no new document load, so navigation timing and FCP are not applicable. LCP/CLS are cumulative for the session; see interactionTimings for this step.'
        : null,
    };
  });

  return {
    schemaVersion: '1.1',
    runId,
    label,
    testStatus,
    timestamp: new Date().toISOString(),
    baseUrl,
    primaryPage: primaryName,
    pageUrl: primary ? primary.pageUrl : null,
    environment: primary ? primary.environment : defaultEnvironment(),
    observation: {
      lcpObservationMs: config.metrics.lcpObservationMs,
      primaryPage,
      // LCP is only final after user input or page hide, so a snapshot taken at
      // the readiness checkpoint is an approximation.
      lcpDescription:
        'LCP is read per page at its journey checkpoint after the `load` event and, for ' +
        `the primary page ("${primaryPage}"), a documented observation window. LCP is only ` +
        'truly final after user input or page hide, so all values are approximations.',
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
      documentNote:
        'Navigation timing and FCP are document-level and are reported only for checkpoints ' +
        'that loaded a document. When a target is a single-page app (e.g. SauceDemo), later ' +
        'checkpoints are client-side route changes (sameDocument=true) with no new document ' +
        'load; their per-step cost is measured by interactionTimings, not by navigation timing.',
    },
    metrics: {
      navigation: primary ? primary.navigation : null,
      firstContentfulPaintMs: primary ? primary.firstContentfulPaintMs : null,
      largestContentfulPaintMs: primary ? primary.largestContentfulPaintMs : null,
      cumulativeLayoutShift: primary ? primary.cumulativeLayoutShift : null,
      clsShiftCount: primary ? primary.clsShiftCount : null,
      lcpCandidateCount: primary ? primary.lcpCandidateCount : null,
      pages: pageList,
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
