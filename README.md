# ui-performance-poc

Browser-level UI performance testing with Playwright and Lighthouse against the public SauceDemo demo site, covering a single-user purchase journey plus a multi-page lab audit that complements JMeter.

## Project tree

```text
ui-performance-poc/
├── docs/
│   ├── architecture.md                # Components and execution flow
│   ├── demo-script.md                 # 5-10 minute stakeholder walkthrough
│   ├── limitations-and-next-steps.md  # What this PoC is not; future work
│   ├── metrics-glossary.md            # Every metric, how it is measured, caveats
│   └── troubleshooting.md             # Windows issues (execution policy, ports, paths)
├── scripts/
│   ├── run-all.ps1                    # journey -> lighthouse -> report -> validate
│   ├── setup-windows.ps1              # Prerequisite checks + dependency/browser install
│   └── validate-reports.js            # Report artifact quality gate
├── src/
│   ├── browser-metrics.js             # PerformanceObserver collector (nav timing, FCP, LCP, CLS)
│   ├── config.js                      # Environment-driven configuration and defaults
│   ├── lighthouse-audit.js            # Multi-page Lighthouse audit with session-cookie auth
│   ├── logger.js                      # Level-filtered console logger (LOG_LEVEL)
│   └── report-summary.js              # Merges artifacts into summary.json / SUMMARY.md
├── tests/
│   └── sauce-demo-journey.spec.js     # Login -> cart -> checkout journey with metrics
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
```

`.env.example` -> `.env` variables: `BASE_URL`, `SAUCE_USERNAME`, `SAUCE_PASSWORD`, `LOG_LEVEL`,
`LCP_OBSERVATION_MS`, `RUN_ID`, `LIGHTHOUSE_PAGES` (JSON `{name, path, requiresAuth}`),
`CHROME_PATH`, `PERF_THRESHOLDS_ENABLED`, `THRESHOLD_LCP_MS`, `THRESHOLD_CLS`,
`THRESHOLD_JOURNEY_MS`, `BASELINE_FILE`. Only public SauceDemo demo credentials are used.

```powershell
npm run test:ui      # Playwright journey
npm run lighthouse   # multi-page Lighthouse audit
npm run all          # journey -> lighthouse -> report -> validate
```

## Key commands & CI

| Command | Purpose |
| --- | --- |
| `npm run test:ui` | Playwright UI journey (headless) |
| `npm run test:ui:headed` | Journey with a visible browser |
| `npm run test:ui:debug` | Playwright debugger |
| `npm run lighthouse` | Multi-page Lighthouse audit |
| `npm run report` | Build `reports/summary.json` and `reports/SUMMARY.md` |
| `npm run validate:reports` | Validate report artifacts exist and parse |
| `npm run all` | End-to-end `scripts/run-all.ps1` workflow |
| `npm run clean` | Remove `reports/raw` |

`Jenkinsfile`: Windows-agent pipeline - install, `npm audit --audit-level=high`, Chromium install, journey, Lighthouse (unstable on error), aggregate, validate, publish JUnit, archive `reports/`.
