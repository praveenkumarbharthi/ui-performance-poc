# Demo script (5–10 minutes)

A presentation flow for stakeholders. Goal: show **what browser-based UI performance testing adds**
to an existing JMeter practice — and, just as importantly, what it does **not** prove.

Audience: performance-engineering leads, QA leads, delivery managers.

---

## 0. Setup before the audience arrives (do this silently)

```powershell
npm ci
npx playwright install chromium
```

Have two terminals ready. Keep `reports/` open in a file explorer.

---

## 1. Framing (1 minute) — *what are we actually measuring?*

Say:

> "JMeter tells us how our backend behaves under load. It does not tell us what a person actually
> *feels* in a browser. This PoC drives one real Chromium session through a purchase journey and
> measures rendering and interaction timings — then adds a Lighthouse audit. It **complements**
> JMeter; it never replaces it."

Show the folder tree briefly: `tests/`, `src/`, `scripts/`, `reports/`, `Jenkinsfile`.

---

## 2. Run the journey (2 minutes)

```powershell
npm run test:ui
```

While it runs, point out:

- It logs in with the **public** demo account (`standard_user` / `secret_sauce`) — no real data.
- It uses **stable `data-test` locators**, explicit assertions, no arbitrary sleeps.
- It records the login → inventory-ready duration and the whole journey.

When it finishes, open the Playwright HTML report:

```powershell
start reports\playwright\html\index.html
```

Highlight the passing journey and that a **trace + screenshot** would be attached on failure.

---

## 3. Show the metrics (2 minutes)

```powershell
npm run report
```

Open `reports/dashboard.html` (the consolidated view), then `reports/SUMMARY.md` and
`reports/summary.json`. Walk through:

- **Overall status** — `passed` / `failed` / `unstable` / `no-data`, with the contributing failure
  types listed (`functional-test-failure`, `performance-threshold-failure`, `lighthouse-audit-failure`,
  `lighthouse-partial-audit`, `missing-data`).
- **FCP / LCP** — when the user first sees content / the main content.
- **CLS** — visual stability.
- **Navigation Timing** — DNS/TCP/TLS, DOM ready, load, and the approximate TTFB.
- **Interaction timings** — login-to-inventory-ready, add-to-cart-to-badge, checkout-to-confirmation.
- **Thresholds** — observation-only unless enabled; a disabled threshold can never fail the build.

Say clearly:

> "The interaction numbers are custom click-to-visible timings. They are **not INP** — we do not
> claim to measure INP."

---

## 4. Show Lighthouse (1–2 minutes)

```powershell
npm run lighthouse
start reports\lighthouse\login.report.html
```

Point out the per-page table in `reports\lighthouse\summary.json` (login + the authenticated
product-detail and cart pages, audited with a session cookie) and the category scores
(Performance / Accessibility / Best Practices / SEO) and the lab
metrics (LCP, CLS, FCP, Speed Index, TBT).

Say clearly:

> "This is a **lab audit** of the public login page — a controlled environment. It is **not**
> real-user monitoring."

---

## 5. Show the Jenkins story (1 minute)

Open the `Jenkinsfile`. Point out:

- `check-env` → `npm ci` → unit tests → Playwright Chromium → UI journey → Lighthouse → report →
  validate.
- **JUnit** results feed the Jenkins test trend; HTML/JSON/Markdown artifacts (including
  `dashboard.html`) are archived even when a stage fails.
- Quality gates map to build state: a journey failure or an enforced threshold breach **fails** the
  build; a non-critical Lighthouse failure or partial audit marks it **unstable**; missing evidence
  can never read as a pass.
- Stale artifacts from a previous run are rejected via the run-start marker.
- No secrets, no hard-coded paths.

---

## 6. Close: what this proves, and what it does not (1 minute)

**It proves:**

- We can automate a real-browser performance journey and capture trustworthy browser metrics.
- We can wire it into CI with proper reporting and failure handling.
- It lays a foundation to extend toward a company-approved non-production environment.

**It does NOT prove:**

- Anything about behaviour under concurrent load (that is JMeter's job).
- Production readiness or guaranteed reliability from a single run.
- Real-user experience at scale (that needs RUM).

End with the ask: a non-production environment and a JMeter correlation exercise.

---

## Quick command reference for the demo

| When | Command | Open |
| --- | --- | --- |
| Environment check | `npm run check:env` | console output |
| Unit tests | `npm run test:unit` | console output |
| Journey | `npm run test:ui` | `reports/playwright/html/index.html` |
| Metrics | `npm run report` | `reports/dashboard.html`, `reports/SUMMARY.md`, `reports/summary.json` |
| Lighthouse | `npm run lighthouse` | `reports/lighthouse/<page>.report.html`, `reports/lighthouse/summary.json` |
| Save baseline | `npm run baseline:save` | `reports/baseline/baseline.json` |
| Validate artifacts | `npm run validate:reports` | console output |
| Everything | `npm run all` | all of the above |
