'use strict';

/**
 * Lighthouse audit of the PUBLIC SauceDemo login page only.
 *
 * - No credentials, no authenticated pages, no private data.
 * - Runs headless Chrome with safe, documented flags.
 * - Produces HTML + JSON reports in reports/lighthouse/ plus a machine-readable
 *   summary JSON.
 * - Fails loudly (non-zero exit code) on real errors; never fabricates scores.
 * - Kept intentionally separate from the authenticated Playwright journey:
 *   a Lighthouse lab score is a controlled audit, NOT real-user monitoring.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');
const logger = require('./logger');

async function loadLighthouse() {
  // lighthouse is ESM; use dynamic import so this CommonJS file keeps working.
  const mod = await import('lighthouse');
  return mod.default || mod;
}

async function loadChromeLauncher() {
  const mod = await import('chrome-launcher');
  return mod.default || mod;
}

function pickAudit(audits, id) {
  const audit = audits && audits[id];
  if (!audit) return null;
  return {
    id,
    title: audit.title || null,
    score: typeof audit.score === 'number' ? audit.score : null,
    displayValue: audit.displayValue || null,
    numericValue: typeof audit.numericValue === 'number' ? audit.numericValue : null,
    scoreDisplayMode: audit.scoreDisplayMode || null,
  };
}

function compactErrors(items) {
  return (items || []).map((e) => ({
    code: e.code || null,
    level: e.level || null,
    message: e.message || null,
  }));
}

async function run() {
  const outDir = config.paths.lighthouse;
  fs.mkdirSync(outDir, { recursive: true });

  const url = config.lighthouse.url;
  const htmlFile = path.join(outDir, 'lighthouse-report.html');
  const jsonFile = path.join(outDir, 'lighthouse-report.json');
  const summaryFile = path.join(outDir, 'summary.json');

  let chrome = null;
  let lighthouseVersion = null;
  let fatalError = null;

  try {
    logger.info(`Starting Lighthouse audit of ${url}`);

    const chromeLauncher = await loadChromeLauncher();
    const launchOptions = { chromeFlags: config.lighthouse.chromeFlags };
    if (config.lighthouse.chromePath) launchOptions.chromePath = config.lighthouse.chromePath;

    chrome = await chromeLauncher.launch(launchOptions);
    logger.info(`Chrome launched on port ${chrome.port}`);

    const lighthouse = await loadLighthouse();
    const options = {
      port: chrome.port,
      output: ['html', 'json'],
      logLevel: 'error',
      onlyCategories: config.lighthouse.categories,
      formFactor: config.lighthouse.formFactor,
      screenEmulation: config.lighthouse.screenEmulation,
      throttlingMethod: config.lighthouse.throttlingMethod,
    };

    const runnerResult = await lighthouse(url, options);
    if (!runnerResult || !runnerResult.lhr) {
      throw new Error('Lighthouse returned no result (lhr missing).');
    }

    const { lhr, report } = runnerResult;
    lighthouseVersion = lhr.lighthouseVersion || null;

    // report is an array matching options.output order: [html, json].
    const htmlReport = Array.isArray(report) ? report[0] : null;
    const jsonReport = Array.isArray(report) ? report[1] : null;

    if (typeof htmlReport !== 'string' || htmlReport.length === 0) {
      throw new Error('Lighthouse HTML report was empty.');
    }
    if (typeof jsonReport !== 'string' || jsonReport.length === 0) {
      throw new Error('Lighthouse JSON report was empty.');
    }

    fs.writeFileSync(htmlFile, htmlReport, 'utf8');
    fs.writeFileSync(jsonFile, jsonReport, 'utf8');
    logger.info(`Wrote Lighthouse reports to ${outDir}`);

    const categories = {};
    for (const [key, value] of Object.entries(lhr.categories || {})) {
      categories[key] = {
        title: value.title || null,
        score: typeof value.score === 'number' ? value.score : null,
      };
    }

    const audits = lhr.audits || {};
    const summary = {
      schemaVersion: '1.0',
      tool: 'lighthouse',
      lighthouseVersion,
      runId: config.runId,
      timestamp: new Date().toISOString(),
      requestedUrl: url,
      finalUrl: lhr.finalDisplayedUrl || lhr.finalUrl || url,
      fetchTime: lhr.fetchTime || null,
      userAgent: lhr.userAgent || null,
      environment: {
        nodeVersion: process.version,
        platform: os.platform(),
        release: os.release(),
        chromeFlags: config.lighthouse.chromeFlags,
        formFactor: config.lighthouse.formFactor,
        throttlingMethod: config.lighthouse.throttlingMethod,
      },
      categories,
      metrics: {
        firstContentfulPaint: pickAudit(audits, 'first-contentful-paint'),
        largestContentfulPaint: pickAudit(audits, 'largest-contentful-paint'),
        cumulativeLayoutShift: pickAudit(audits, 'cumulative-layout-shift'),
        speedIndex: pickAudit(audits, 'speed-index'),
        totalBlockingTime: pickAudit(audits, 'total-blocking-time'),
        interactive: pickAudit(audits, 'interactive'),
        serverResponseTime: pickAudit(audits, 'server-response-time'),
        totalByteWeight: pickAudit(audits, 'total-byte-weight'),
      },
      runtimeError: lhr.runtimeError || null,
      runWarnings: lhr.runWarnings || [],
      reports: {
        html: path.relative(config.projectRoot, htmlFile).replace(/\\/g, '/'),
        json: path.relative(config.projectRoot, jsonFile).replace(/\\/g, '/'),
      },
      note:
        'Lighthouse lab scores are controlled-audit measurements, not real-user ' +
        'monitoring, and are not directly comparable to the Playwright journey timings.',
    };

    fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    logger.info(
      `Lighthouse categories: ${Object.entries(categories)
        .map(([k, v]) => `${k}=${v.score}`)
        .join(', ')}`
    );
  } catch (err) {
    fatalError = err;
    logger.error(`Lighthouse audit failed: ${err && err.message ? err.message : String(err)}`);

    // Write a summary that explicitly records the failure instead of fake scores.
    const failureSummary = {
      schemaVersion: '1.0',
      tool: 'lighthouse',
      lighthouseVersion,
      runId: config.runId,
      timestamp: new Date().toISOString(),
      requestedUrl: url,
      status: 'failed',
      error: err && err.message ? err.message : String(err),
      environment: { nodeVersion: process.version, platform: os.platform() },
      categories: {},
      metrics: {},
      note: 'Lighthouse did not complete; no scores are available.',
    };
    try {
      fs.writeFileSync(summaryFile, `${JSON.stringify(failureSummary, null, 2)}\n`, 'utf8');
    } catch (writeErr) {
      logger.error(`Could not write failure summary: ${writeErr.message}`);
    }
    process.exitCode = 1;
  } finally {
    if (chrome) {
      try {
        await chrome.kill();
        logger.debug('Chrome instance terminated.');
      } catch (killErr) {
        logger.warn(`Failed to terminate Chrome cleanly: ${killErr.message}`);
      }
    }
  }

  if (!fatalError) logger.info('Lighthouse audit completed successfully.');
}

if (require.main === module) {
  run().catch((err) => {
    logger.error(`Unexpected Lighthouse error: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  });
}

module.exports = { run };
