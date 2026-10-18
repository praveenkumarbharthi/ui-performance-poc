'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');
const logger = require('./logger');

// Lighthouse ships as ESM; dynamic import keeps this CommonJS entry point working.
async function loadLighthouse() {
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

function pageUrl(pageDef) {
  const p = pageDef.path || '/';
  return `${config.baseUrl}${p.startsWith('/') ? p : `/${p}`}`;
}

// Lighthouse cannot authenticate on its own, so we reuse a real login session
// obtained through Playwright. Cookie values are never logged.
async function getSessionCookies() {
  const { chromium, selectors } = require('playwright');
  // Standalone library launch: the test-runner config does not apply here, so the
  // SauceDemo data-test attribute has to be registered explicitly.
  selectors.setTestIdAttribute('data-test');
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(config.baseUrl, { waitUntil: 'load' });
    await page.getByTestId('username').fill(config.credentials.username);
    await page.getByTestId('password').fill(config.credentials.password);
    await page.getByTestId('login-button').click();
    await page.waitForURL(/inventory\.html/, { timeout: 30_000 });
    return await context.cookies();
  } finally {
    await browser.close();
  }
}

// SauceDemo's protected pages redirect to the login *client-side* by reading
// document.cookie, so a `Cookie` request header is not enough - the cookie must
// exist in the browser's cookie store. Lighthouse's storage reset is disabled
// for the run (see auditPage) so the seeded session survives.
async function seedSessionCookies(port, cookies) {
  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('no default browser context available for cookie seeding');
    await context.addCookies(
      cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      }))
    );
  } finally {
    await browser.close();
  }
}

async function auditPage(lighthouse, port, pageDef, keepStorage) {
  const url = pageUrl(pageDef);
  const options = {
    port,
    output: ['html', 'json'],
    logLevel: 'error',
    onlyCategories: config.lighthouse.categories,
    formFactor: config.lighthouse.formFactor,
    screenEmulation: config.lighthouse.screenEmulation,
    throttlingMethod: config.lighthouse.throttlingMethod,
    // Keep the seeded session: protected pages redirect to login without it.
    disableStorageReset: keepStorage,
  };

  const runnerResult = await lighthouse(url, options);
  if (!runnerResult || !runnerResult.lhr) {
    throw new Error('Lighthouse returned no result (lhr missing).');
  }

  const { lhr, report } = runnerResult;
  // report follows options.output order: [html, json].
  const htmlReport = Array.isArray(report) ? report[0] : null;
  const jsonReport = Array.isArray(report) ? report[1] : null;
  if (typeof htmlReport !== 'string' || htmlReport.length === 0) {
    throw new Error('Lighthouse HTML report was empty.');
  }
  if (typeof jsonReport !== 'string' || jsonReport.length === 0) {
    throw new Error('Lighthouse JSON report was empty.');
  }

  const categories = {};
  for (const [key, value] of Object.entries(lhr.categories || {})) {
    categories[key] = {
      title: value.title || null,
      score: typeof value.score === 'number' ? value.score : null,
    };
  }

  const audits = lhr.audits || {};
  const finalUrl = lhr.finalDisplayedUrl || lhr.finalUrl || url;

  // Guard against silent redirects: an unaccepted session bounces back to the
  // login page, which would otherwise report metrics for the wrong page.
  if (pageDef.requiresAuth && new URL(finalUrl).pathname !== new URL(url).pathname) {
    throw new Error(`redirected to ${finalUrl} - the session was not accepted`);
  }

  return {
    htmlReport,
    jsonReport,
    result: {
      name: pageDef.name,
      lighthouseVersion: lhr.lighthouseVersion || null,
      requestedUrl: url,
      finalUrl,
      authenticated: !!pageDef.requiresAuth,
      status: 'ok',
      fetchTime: lhr.fetchTime || null,
      environment: {
        hostUserAgent: (lhr.environment && lhr.environment.hostUserAgent) || null,
        networkUserAgent: (lhr.environment && lhr.environment.networkUserAgent) || null,
        benchmarkIndex:
          lhr.environment && typeof lhr.environment.benchmarkIndex === 'number'
            ? lhr.environment.benchmarkIndex
            : null,
        configSettings: {
          formFactor: (lhr.configSettings && lhr.configSettings.formFactor) || null,
          throttlingMethod: (lhr.configSettings && lhr.configSettings.throttlingMethod) || null,
          onlyCategories: (lhr.configSettings && lhr.configSettings.onlyCategories) || null,
          screenEmulation: (lhr.configSettings && lhr.configSettings.screenEmulation) || null,
        },
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
      reports: {
        html: `reports/lighthouse/${pageDef.name}.report.html`,
        json: `reports/lighthouse/${pageDef.name}.report.json`,
      },
      error: null,
    },
  };
}

// A page that was never audited is recorded explicitly (as `failed` or
// `skipped`) so a partial run can never be mistaken for a complete one.
function failedPageResult(pageDef, error, status = 'failed') {
  return {
    name: pageDef.name,
    lighthouseVersion: null,
    requestedUrl: pageUrl(pageDef),
    finalUrl: null,
    authenticated: !!pageDef.requiresAuth,
    status,
    fetchTime: null,
    environment: null,
    categories: {},
    metrics: {},
    reports: { html: null, json: null },
    error,
  };
}

async function run() {
  const outDir = config.paths.lighthouse;
  fs.mkdirSync(outDir, { recursive: true });

  const pages = config.lighthouse.pages;
  const summaryFile = path.join(outDir, 'summary.json');

  let chrome = null;
  let lighthouseVersion = null;
  let sessionCookies = null;
  let abortError = null;
  const pageResults = [];
  const completed = new Set();

  const record = (result) => {
    pageResults.push(result);
    completed.add(result.name);
  };

  try {
    logger.info(
      `Starting Lighthouse audit of ${pages.length} page(s): ${pages.map((p) => p.name).join(', ')}`
    );

    const needsAuth = pages.some((p) => p.requiresAuth);
    if (needsAuth) {
      try {
        logger.info('Logging in with Playwright to obtain the session cookies');
        sessionCookies = await getSessionCookies();
        if (!sessionCookies || sessionCookies.length === 0) {
          throw new Error('login returned no cookies');
        }
        logger.info(`Session cookies obtained (${sessionCookies.length}, values not logged).`);
      } catch (err) {
        logger.error(
          `Could not obtain session cookies: ${err.message}. Authenticated pages will be skipped.`
        );
      }
    }

    const chromeLauncher = await loadChromeLauncher();
    const launchOptions = { chromeFlags: config.lighthouse.chromeFlags };
    if (config.lighthouse.chromePath) launchOptions.chromePath = config.lighthouse.chromePath;

    chrome = await chromeLauncher.launch(launchOptions);
    logger.info(`Chrome launched on port ${chrome.port}`);

    if (sessionCookies) {
      await seedSessionCookies(chrome.port, sessionCookies);
      logger.info('Session cookies seeded into the Lighthouse browser.');
    }

    const lighthouse = await loadLighthouse();

    for (const pageDef of pages) {
      if (pageDef.requiresAuth && !sessionCookies) {
        record(failedPageResult(pageDef, 'skipped: no session cookie (login failed)', 'skipped'));
        logger.error(`Page "${pageDef.name}" skipped: no session cookie.`);
        continue;
      }

      try {
        logger.info(`Auditing page "${pageDef.name}" (${pageUrl(pageDef)})`);
        const { htmlReport, jsonReport, result } = await auditPage(
          lighthouse,
          chrome.port,
          pageDef,
          needsAuth
        );
        fs.writeFileSync(path.join(outDir, `${pageDef.name}.report.html`), htmlReport, 'utf8');
        fs.writeFileSync(path.join(outDir, `${pageDef.name}.report.json`), jsonReport, 'utf8');

        lighthouseVersion = lighthouseVersion || result.lighthouseVersion;
        record(result);

        const scores = Object.entries(result.categories)
          .map(([k, v]) => `${k}=${v.score}`)
          .join(', ');
        logger.info(`  "${pageDef.name}" ok: ${scores}`);
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        record(failedPageResult(pageDef, message));
        logger.error(`  "${pageDef.name}" failed: ${message}`);
      }
    }
  } catch (err) {
    abortError = err && err.message ? err.message : String(err);
    logger.error(`Lighthouse audit aborted: ${abortError}`);
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

  // Outcome is derived from what actually happened per page, never assumed. A
  // skipped page is partial success (`unstable`), not a silent pass.
  const outcomes = {
    total: pages.length,
    ok: pageResults.filter((r) => r.status === 'ok').length,
    failed: pageResults.filter((r) => r.status === 'failed').length,
    skipped: pageResults.filter((r) => r.status === 'skipped').length,
  };
  const missing = pages.length - pageResults.length;

  let status = 'ok';
  if (abortError || outcomes.failed > 0 || missing > 0) status = 'failed';
  else if (outcomes.skipped > 0) status = 'unstable';

  // Always write a summary that records the real outcome instead of fake scores.
  const summary = {
    schemaVersion: '2.0',
    tool: 'lighthouse',
    lighthouseVersion,
    runId: config.runId,
    timestamp: new Date().toISOString(),
    status,
    outcomes,
    abortError,
    environment: {
      nodeVersion: process.version,
      platform: os.platform(),
      release: os.release(),
      chromeFlags: config.lighthouse.chromeFlags,
      formFactor: config.lighthouse.formFactor,
      throttlingMethod: config.lighthouse.throttlingMethod,
    },
    pages: pageResults,
    note:
      'Lighthouse lab scores are controlled-audit measurements, not real-user ' +
      'monitoring, and are not directly comparable to the Playwright journey timings.',
  };

  try {
    fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    logger.info(`Wrote Lighthouse reports to ${outDir}`);
  } catch (writeErr) {
    logger.error(`Could not write Lighthouse summary: ${writeErr.message}`);
    process.exitCode = 1;
    return;
  }

  if (status === 'failed') {
    logger.error(
      `Lighthouse audit failed (ok=${outcomes.ok}, failed=${outcomes.failed}, ` +
        `skipped=${outcomes.skipped}${abortError ? `, aborted: ${abortError}` : ''}). ` +
        'See reports/lighthouse/summary.json.'
    );
    process.exitCode = 1;
  } else if (status === 'unstable') {
    logger.warn(
      `Lighthouse audit partially completed (ok=${outcomes.ok}, skipped=${outcomes.skipped}). ` +
        'Results are incomplete; see reports/lighthouse/summary.json.'
    );
  } else {
    logger.info('Lighthouse audit completed successfully.');
  }
}

if (require.main === module) {
  run().catch((err) => {
    logger.error(`Unexpected Lighthouse error: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  });
}

module.exports = { run };
