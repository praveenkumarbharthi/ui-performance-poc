# ui-performance-poc

A production-quality **proof of concept** for automated, browser-based **UI performance
testing** using [Playwright](https://playwright.dev/) and [Lighthouse](https://github.com/GoogleChrome/lighthouse)
against the public demo site <https://www.saucedemo.com>.

Its purpose is to demonstrate how **browser-level UI performance testing complements JMeter**
in an enterprise performance-testing practice. It is **not** a load test, **not** a production
banking framework, and it **never** generates concurrent load against the public SauceDemo site.

> A single local run is **not** statistically reliable performance evidence, and this PoC must
> **complement — never replace — JMeter** for load, stress, soak, capacity and backend testing.
> See [docs/limitations-and-next-steps.md](docs/limitations-and-next-steps.md).

---

## Table of contents

- [Objective](#objective)
- [Architecture](#architecture)
- [Folder tree](#folder-tree)
- [Prerequisites](#prerequisites)
- [Setup (Windows)](#setup-windows)
- [Runnable commands](#runnable-commands)
- [Report locations](#report-locations)
- [Sample report structure](#sample-report-structure)
- [Metric definitions](#metric-definitions)
- [Configuration & thresholds](#configuration--thresholds)
- [Jenkins setup](#jenkins-setup)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

---

## Objective

1. Exercise a realistic **single-user** journey on SauceDemo (login → inventory → add to cart →
   cart → checkout → confirmation) using real Chromium browser automation.
2. Collect **browser-observed** performance metrics (Navigation Timing, FCP, LCP, CLS, custom
   interaction timings) without inventing unsupported values.
3. Run an independent **Lighthouse lab audit** of the public login page.
4. Produce HTML, JSON, JUnit XML and Markdown reports suitable for local review and Jenkins.
5. Model how such a suite would be wired into **Jenkins** on a Windows agent with proper failure
   propagation and archived evidence.

## Architecture

Full details, including a Mermaid flow diagram, are in [docs/architecture.md](docs/architecture.md).

High-level flow:

```
Git → Jenkins (Windows agent)
      ├─ Playwright browser journey (Chromium) ─┐
      └─ Lighthouse lab audit (headless Chrome) ─┤
                                                 ▼
                        Report aggregation (summary.json + SUMMARY.md)
                                                 ▼
                  Archived artifacts (HTML / JSON / XML / PNG / trace)
```

## Folder tree

```
ui-performance-poc/
  package.json
  package-lock.json
  playwright.config.js
  Jenkinsfile
  .gitignore
  .env.example
  README.md
  docs/
    architecture.md
    metrics-glossary.md
    troubleshooting.md
    demo-script.md
    limitations-and-next-steps.md
  tests/
    sauce-demo-journey.spec.js
  src/
    browser-metrics.js
    lighthouse-audit.js
    report-summary.js
    config.js
    logger.js
  scripts/
    setup-windows.ps1
    run-all.ps1
    validate-reports.js
  reports/            # generated (git-ignored except .gitkeep)
    .gitkeep
```

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | LTS, `>=18.18` | Tested on Node 24.x |
| npm | bundled with Node | |
| Google Chrome | recent stable | Used by Lighthouse; Playwright ships its own Chromium |
| Network access | — | Required for SauceDemo and Lighthouse |

## Setup (Windows)

Open **PowerShell** in the project root (works even if the path contains spaces).

```powershell
# 1. Verify prerequisites
node -v
npm -v
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" --version   # if Chrome is installed

# 2. Install dependencies (uses the lock file when present)
npm ci            # or: npm install

# 3. Install the Playwright Chromium browser
npx playwright install chromium

# 4. (Optional) one-shot setup script that does steps 1-3 for you
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/setup-windows.ps1
```

If `powershell` scripts are blocked by execution policy, the `-ExecutionPolicy Bypass` flag above
avoids changing machine-wide policy. See [docs/troubleshooting.md](docs/troubleshooting.md).

## Runnable commands

Every command below exists in `package.json` and has been exercised.

| Command | What it does |
| --- | --- |
| `npm run test:ui` | Run the Playwright UI journey (headless). |
| `npm run test:ui:headed` | Run the journey with a visible browser. |
| `npm run test:ui:debug` | Run with the Playwright debugger / inspector. |
| `npm run lighthouse` | Run the Lighthouse audit of the login page. |
| `npm run report` | Build `reports/summary.json` and `reports/SUMMARY.md`. |
| `npm run validate:reports` | Verify report artifacts exist, are non-empty and parse. |
| `npm run all` | Full workflow: journey → Lighthouse → summary → validation. |
| `npm run clean` | Remove `reports/raw` (raw per-run artifacts). |

### Notes on `npm run all`

The `all` script invokes [scripts/run-all.ps1](scripts/run-all.ps1), which:

- exports one shared `RUN_ID` so every stage writes/reads the same run directory;
- runs the stages in a fixed order and prints a per-stage PASS/FAIL table;
- always runs the summary + validation stages (even after an earlier failure) so you get maximum
  evidence;
- exits non-zero when a **critical** stage (UI journey / summary / validation) fails, and reports a
  **Lighthouse** failure separately (it is network/Chrome dependent). Set `STRICT=1` to also fail on
  a Lighthouse error.

Opening HTML reports:

```powershell
start reports\playwright\html\index.html
start reports\lighthouse\lighthouse-report.html
```

## Report locations

All generated artifacts live under `reports/` and are **git-ignored** (except `reports/.gitkeep`).
Raw, per-run artifacts are kept under a **timestamped run directory** so previous evidence is never
overwritten; convenient *latest* summary/report locations are also maintained.

| Artifact | Path |
| --- | --- |
| Playwright HTML report | `reports/playwright/html/index.html` |
| Playwright JSON report | `reports/playwright/results.json` |
| JUnit XML (for Jenkins) | `reports/junit/results.xml` |
| Merged browser metrics JSON | `reports/browser-metrics/browser-metrics.json` |
| Lighthouse HTML report | `reports/lighthouse/lighthouse-report.html` |
| Lighthouse JSON report | `reports/lighthouse/lighthouse-report.json` |
| Lighthouse summary JSON | `reports/lighthouse/summary.json` |
| Consolidated summary JSON | `reports/summary.json` |
| Human-readable summary | `reports/SUMMARY.md` |
| Raw per-run artifacts | `reports/raw/<runId>/**` (traces, screenshots, metrics) |

## Sample report structure

`reports/summary.json` (abridged):

```json
{
  "schemaVersion": "1.0",
  "generatedAt": "2026-10-17T10:00:00.000Z",
  "runId": "2026-10-17T10-00-00-000",
  "baseUrl": "https://www.saucedemo.com",
  "status": "passed",
  "failureTypes": [],
  "tests": {
    "summary": { "passed": 1, "failed": 0, "flaky": 0, "skipped": 0, "total": 1 },
    "details": [{ "title": "SauceDemo UI performance journey > ...", "status": "passed", "durationMs": 8421 }]
  },
  "browserMetrics": [
    {
      "metrics": {
        "navigation": { "ttfbApprox": 120.4, "domContentLoaded": 810.2, "loadEvent": 1320.7 },
        "firstContentfulPaintMs": 640.1,
        "largestContentfulPaintMs": 1020.5,
        "cumulativeLayoutShift": 0.001,
        "interactionTimings": {
          "login-to-inventory-ready": 1210,
          "add-to-cart-to-badge-updated": 96,
          "checkout-submit-to-confirmation-visible": 340,
          "total-journey-duration": 8421
        }
      }
    }
  ],
  "lighthouse": { "available": true, "version": "12.x", "categories": { "performance": 0.98, "accessibility": 0.95 } },
  "thresholds": { "enabled": false, "checks": [], "failures": [] }
}
```

## Metric definitions

See [docs/metrics-glossary.md](docs/metrics-glossary.md) for the full glossary. Summary:

| Metric | Source | Measured as |
| --- | --- | --- |
| Navigation Timing (DNS/TCP/TLS) | Browser (Playwright) | `PerformanceNavigationTiming` deltas (ms) |
| TTFB (approximate) | Browser (Playwright) | `responseStart - navigationStart` — includes redirects |
| FCP | Browser (Playwright) | `paint` entry `first-contentful-paint` (ms) |
| LCP | Browser (Playwright) | `largest-contentful-paint` after a documented observation window (ms) |
| CLS | Browser (Playwright) | Sum of `layout-shift` entries without recent input |
| Interaction timings | Custom journey timing | `Date.now()` deltas around a click and its visible outcome (ms) |
| INP | **Not measured** | Custom click-to-visible timings are **not** INP |
| Performance/Accessibility/Best-Practices/SEO | Lighthouse | Lab audit category scores (0–1) |

> Browser-observed timings are **not** server-side timings and are **not** the same as Lighthouse
> lab metrics. Lighthouse's lab score is a controlled audit and is **not** real-user monitoring.

## Configuration & thresholds

Configuration is environment-driven (see [.env.example](.env.example)); nothing machine-specific is
hard-coded.

| Variable | Default | Purpose |
| --- | --- | --- |
| `BASE_URL` | `https://www.saucedemo.com` | Target application |
| `SAUCE_USERNAME` / `SAUCE_PASSWORD` | `standard_user` / `secret_sauce` | Public demo account only |
| `RUN_ID` | timestamp | Run identity for raw artifacts |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` |
| `LCP_OBSERVATION_MS` | `2500` | LCP/CLS settle window after load |
| `LIGHTHOUSE_URL` | `https://www.saucedemo.com/` | Audited (login) page |
| `CHROME_PATH` | auto-detect | Explicit Chrome binary for Lighthouse |
| `PERF_THRESHOLDS_ENABLED` | `false` | Master switch for thresholds |
| `THRESHOLD_LCP_MS` / `THRESHOLD_CLS` / `THRESHOLD_JOURNEY_MS` | empty | Optional limits |
| `BASELINE_FILE` | `reports/baseline/summary.json` | Optional baseline |

**Threshold policy:** thresholds start **disabled** (observation mode). A disabled threshold can
never fail a build. When enabled, inputs are validated, `null`/unavailable metrics are skipped, and
any failure is reported explicitly (which metric, actual vs max, overshoot) and categorised
separately from functional test failures and infrastructure failures.

**Baseline comparison** only runs when a valid, comparable baseline file exists; it warns when the
browser, OS or Lighthouse version differs.

## Jenkins setup

The [Jenkinsfile](Jenkinsfile) is a declarative pipeline targeting a **Windows** agent
(`bat` steps). It:

- checks out source, checks Node/npm versions;
- installs with `npm ci` (falls back to `npm install`);
- installs Playwright Chromium;
- runs the UI journey, then the Lighthouse audit (a Lighthouse failure marks the build *unstable*
  rather than failed, because it is network/Chrome dependent);
- aggregates reports and validates them;
- publishes JUnit results (`allowEmptyResults`) and archives HTML/JSON/Markdown/XML/PNG/ZIP
  (`allowEmptyArchive`);
- has `success` / `unstable` / `failure` post actions, useful console logging and cleanup of
  temporary files;
- propagates failure correctly and hard-codes no Jenkins workspace or tool paths.

To wire this in Jenkins:

1. Create a **Pipeline** job and point it at this repository (or configure `checkout scm` via
   Jenkins SCM).
2. Ensure an agent labelled `windows` has Node.js LTS, npm and (ideally) Google Chrome installed.
3. Adjust `environment` variables (`BASE_URL`, thresholds, etc.) as job parameters.
4. Run the job and review **Test Result** (JUnit), **Artifacts**, and the console log.

**Secrets:** this demo uses only public SauceDemo credentials, so no credentials are required. For a
future authenticated application, add a Jenkins **Username/Password** (or Secret Text) credential
and bind it via `withCredentials([...])` — never commit secrets to source or print them in logs.

## Troubleshooting

Common Windows issues (execution policy, browser install, ports, paths, permissions) are covered in
[docs/troubleshooting.md](docs/troubleshooting.md).

## Limitations

Read [docs/limitations-and-next-steps.md](docs/limitations-and-next-steps.md). In short: this is a
single-user browser POC, it complements JMeter, it is not load testing, and lab metrics differ from
real-user monitoring.
