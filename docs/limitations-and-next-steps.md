# Limitations and next steps

## What this PoC is

A **single-user, browser-level UI performance proof of concept**. It drives one real Chromium session
through a SauceDemo purchase journey and runs a multi-page Lighthouse lab audit (public and
authenticated pages), producing HTML/JSON/JUnit/Markdown reports.

## What this PoC is NOT

- **Not a load test.** It never generates concurrent load against SauceDemo (or any public site).
- **Not a replacement for JMeter.** Load, stress, soak, capacity and backend testing remain JMeter's
  (or an equivalent load tool's) responsibility.
- **Not production evidence.** A single local run is not statistically reliable performance
  evidence and does not demonstrate production readiness.

## Honest metric scoping

- **Browser-observed** timings (Navigation Timing, FCP, LCP, CLS) describe one browser session on one
  machine at one moment. They are affected by CPU, memory, network, extensions and background load.
- **Custom interaction timings** are click-to-visible wall-clock measurements. They are **not INP**.
  INP is not measured by this PoC.
- **Single-page apps:** SauceDemo is a React SPA, so only the initial load is a real *document*
  navigation. Later journey checkpoints are client-side route changes: their document-level
  navigation timing and FCP are reported as `null` (marked `sameDocument`) instead of duplicating the
  initial load's numbers, and their cost is shown as interaction timings. LCP/CLS are cumulative for
  the session.
- **Lighthouse** metrics come from a controlled lab audit with simulated throttling. They are **not**
  real-user monitoring and are **not** directly comparable to the journey interaction timings.
- **Server-side** latency is out of scope here; it requires backend instrumentation and a
  non-production environment.

## Lab vs real-user metrics

| Aspect | Lab (this PoC / Lighthouse) | Real-user (RUM) |
| --- | --- | --- |
| Environment | Controlled, single machine | Real devices, networks, locations |
| Reproducibility | High (same inputs → similar output) | Low (high variance) |
| Represents | "What *can* the page do" | "What *users actually* experience" |
| Best for | Regression detection, CI gates | Trend monitoring, percentile SLAs |

Use lab metrics to catch regressions early; use RUM to understand real experience. They answer
different questions.

## Repeatability and environment effects

- Run-to-run variation is expected. Treat any single number as a **sample**, not a fact.
- Compare runs only when browser, OS, machine class, network and throttling settings match. The
  baseline comparison (`src/baseline.js`) **blocks** a comparison when browser / OS / platform /
  viewport width differ and **warns** on viewport height, Lighthouse version or audit-setting
  differences.
- Small movements are not regressions: a change is only called an **improvement** or **regression**
  when it exceeds a configurable noise band (`BASELINE_NOISE_PCT`, default 10%) and the measurement
  is not too variable (`BASELINE_VARIABILITY_PCT`, default 20%). Otherwise it is reported as
  `within-noise` or `inconclusive` — never a false regression from a single noisy sample.
- Prefer medians of several runs over a single measurement before drawing conclusions. The baseline
  stores count / median / min / max / spread so repeated runs are visible.

## Thresholds

Thresholds are **disabled by default** (observation mode). Enable them only after you have gathered
enough baseline data to choose meaningful limits, and always validate the inputs. A disabled
threshold can never fail a build; an enabled threshold failure is reported separately from functional
and infrastructure failures.

## Adapting to a company-approved non-production environment

1. **Target** — point `BASE_URL` at an approved non-production URL. Never benchmark production
   without explicit approval.
2. **Credentials** — replace the public demo account with a dedicated test account held in a secret
   store. In Jenkins, bind a Username/Password credential via `withCredentials([...])`; never commit
   secrets and never log them.
3. **Journey** — adapt `tests/sauce-demo-journey.spec.js` to the real user journey, keeping stable
   locators, explicit assertions and deterministic waits.
4. **Data isolation** — create per-run test data and clean up. Avoid shared mutable state.
5. **Baselines** — establish a baseline in the approved environment, then enable a small number of
   high-signal thresholds.
6. **Correlate with JMeter** — run JMeter load and this UI journey against the same environment to
   correlate backend latency with user-perceived timings. Document the relationship; do not conflate
   the two.
7. **Scale carefully** — if you need browser-level *load*, that is a different tool and a different
   conversation. This PoC stays single-user by design.

## Next steps (suggested roadmap)

1. Automate **repeated runs** in CI (e.g. N times, then compare medians) — the baseline module
   already records count / median / spread once multiple samples are saved.
2. Introduce RUM on a non-production front end for real-user comparison.
3. Parameterise the journey (multiple products / flows) while staying single-user.
4. Turn the Lighthouse **Accessibility** category score into an enforced CI gate (it is currently
   reported, not gated).
5. Publish trends (historical summary JSON) rather than point-in-time results.

## Explicit honesty statement

Where a metric is unsupported or unavailable, this PoC reports `null` rather than a fabricated
value, and where an audit fails it records the failure rather than a fake score. A passing run
demonstrates that the **mechanism** works — it is not proof of production readiness or guaranteed
reliability.
