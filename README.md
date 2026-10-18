# ui-performance-poc

Browser-level UI performance testing with Playwright and Lighthouse against the public SauceDemo demo site: a single-user purchase journey plus a multi-page lab audit, complementary to JMeter (which covers concurrent load, stress, and soak testing).

## Project tree

```text
ui-performance-poc/
├── docs/
│   ├── architecture.md                # Components, execution flow, data flow
│   ├── demo-script.md                 # 5-10 minute stakeholder walkthrough
│   ├── limitations-and-next-steps.md  # What this PoC is not; future work
│   ├── metrics-glossary.md            # Every metric, how it is measured, caveats
│   └── troubleshooting.md             # Windows issues (execution policy, ports, paths)
├── scripts/
│   ├── check-env.js                   # Fail-fast Node/npm/config preflight
│   ├── run-all.ps1                    # journey -> lighthouse -> report -> validate
│   ├── save-baseline.js               # Save the current summary as the baseline
│   ├── setup-windows.ps1              # Prerequisite checks + dependency/browser install
│   └── validate-reports.js            # Report artifact + summary structure gate
├── src/
│   ├── baseline.js                    # Baseline load/compare (regression safeguards)
│   ├── browser-metrics.js             # PerformanceObserver collector (nav timing, FCP, LCP, CLS)
│   ├── config.js                      # Environment-driven configuration and defaults
│   ├── html-report.js                 # Consolidated dashboard.html renderer
│   ├── lighthouse-audit.js            # Multi-page Lighthouse audit with session-cookie auth
│   ├── logger.js                      # Level-filtered console logger (LOG_LEVEL)
│   ├── quality-gate.js                # Threshold + overall-status rules (pure, unit tested)
│   └── report-summary.js              # Merges artifacts into summary.json / SUMMARY.md / dashboard.html
├── tests/
│   ├── sauce-demo-journey.spec.js     # Login -> cart -> checkout journey with metrics
│   └── unit/                          # node:test unit + integration tests
├── reports/                           # Generated test output (git-ignored)
├── .env.example                       # Environment variable template
├── .gitignore
├── Jenkinsfile                        # Windows declarative CI pipeline
├── LICENSE                            # MIT
├── package-lock.json
├── package.json
├── playwright.config.js               # Playwright reporters, projects, timeouts
└── README.md
```

## Environment & quickstart

Requires Node.js >= 22.19 (Lighthouse 13), npm, Google Chrome, and outbound HTTPS to SauceDemo.

```powershell
npm ci
npx playwright install chromium
Copy-Item .env.example .env    # optional local overrides
npm run check:env              # validate toolchain + configuration
```

`.env.example` -> `.env` variables: `BASE_URL`, `SAUCE_USERNAME`, `SAUCE_PASSWORD`, `LOG_LEVEL`,
`LCP_OBSERVATION_MS`, `RUN_ID`, `RUN_STARTED_AT`, `REPORTS_DIR`, `LIGHTHOUSE_PAGES` (JSON
`{name, path, requiresAuth}`), `CHROME_PATH`, `PERF_THRESHOLDS_ENABLED`, `THRESHOLD_LCP_MS`,
`THRESHOLD_CLS`, `THRESHOLD_JOURNEY_MS`, `BASELINE_FILE`, `BASELINE_NOISE_PCT`,
`BASELINE_VARIABILITY_PCT`. Only public SauceDemo demo credentials are used.

## Key commands

| Command | Purpose |
| --- | --- |
| `npm run check:env` | Validate Node/npm toolchain and configuration |
| `npm run test:unit` | Unit + integration tests (`node --test`) |
| `npm run test:ui` | Playwright UI journey (headless) |
| `npm run lighthouse` | Multi-page Lighthouse audit |
| `npm run report` | Build `summary.json`, `SUMMARY.md`, and `dashboard.html` |
| `npm run validate:reports` | Validate report artifacts and summary structure |
| `npm run baseline:save` | Save the current summary as the comparison baseline |
| `npm run all` | End-to-end `scripts/run-all.ps1` workflow |
| `npm run clean` | Remove `reports/raw` |

## Status model

Overall status is `passed`, `failed`, `unstable`, or `no-data`. Functional failures and enforced
threshold breaches (`PERF_THRESHOLDS_ENABLED=true`) fail the build; a failed or partial Lighthouse
audit, or missing evidence, yields `unstable` so incomplete runs are never mistaken for success.
Thresholds are observation-only until enabled with an agreed baseline.

`Jenkinsfile`: Windows-agent pipeline - run marker, tool/config checks, `npm ci`, unit tests,
`npm audit --audit-level=high`, Chromium install, journey, Lighthouse, report, validate. Evidence is
published even on failure via `catchError`, JUnit, and archived `reports/`.
