# Metrics glossary

This glossary defines every metric the PoC reports, how it is measured, its caveats, and whether it
is a **browser** metric, a **custom journey timing**, or a **Lighthouse** metric.

> **Key distinction:** browser-observed timings describe one real browser session; Lighthouse
> metrics come from a controlled lab audit; server-side timings would come from the backend/JMeter.
> Do not compare them as if they were the same thing.

## Browser metrics (Playwright)

Collected by [src/browser-metrics.js](../src/browser-metrics.js). Observers are registered **before
navigation**. Any value unavailable in the current environment is reported as `null` — never
invented.

### Navigation Timing (from `PerformanceNavigationTiming`)

| Metric | Field / calculation | Unit | Caveats |
| --- | --- | --- | --- |
| `navigationStart` | `startTime` | ms | Time origin (≈0). |
| `responseStart` | `responseStart` | ms | Relative to navigation start. |
| `domInteractive` | `domInteractive` | ms | DOM parsed; not necessarily interactive. |
| `domContentLoaded` | `domContentLoadedEventEnd` | ms | End of DCL event. |
| `loadEvent` | `loadEventEnd` | ms | End of load event (sub-resources included for the main document). |
| `totalNavigationDuration` | `loadEventEnd - startTime` | ms | `null` if the load event has not fired yet. |
| `dnsLookupDuration` | `domainLookupEnd - domainLookupStart` | ms | `0` when DNS is cached/reused. |
| `tcpConnectionDuration` | `connectEnd - connectStart` | ms | Includes TLS; `0` when connection is reused. |
| `tlsNegotiationDuration` | `connectEnd - secureConnectionStart` | ms | `null` when not HTTPS or `secureConnectionStart` is 0. |
| `transferSize` / `encodedBodySize` | respective fields | bytes | Sizes for the main document. |
| `nextHopProtocol` | `nextHopProtocol` | string | e.g. `h2`, `http/1.1`. |

### TTFB (approximate)

| Metric | Calculation | Unit | Caveats |
| --- | --- | --- | --- |
| `ttfbApprox` | `responseStart - navigationStart` | ms | **Approximate.** Includes redirect time and DNS/TCP/TLS; does **not** isolate server processing from network latency. |

### Paint & stability

| Metric | Source | Unit | Caveats |
| --- | --- | --- | --- |
| `firstContentfulPaintMs` | `paint` entry `first-contentful-paint` | ms | First text/image paint. |
| `largestContentfulPaintMs` | `largest-contentful-paint` observer | ms | Read **after** `load` + a documented `LCP_OBSERVATION_MS` window. LCP is only truly final after user input / page hide, so this is an approximation. |
| `cumulativeLayoutShift` | Σ `layout-shift` where `!hadRecentInput` | unitless | Standard calculation (excludes shifts with recent input). Continues to accrue over the page lifetime. |
| `clsShiftCount` | count of contributing layout-shift entries | count | Diagnostic. |
| `lcpCandidateCount` | count of LCP candidate entries observed | count | Diagnostic. |

### Interaction timings (custom journey timing)

These are **custom click-to-visible measurements** taken with `Date.now()` around a user action and
its visible outcome:

| Metric | Measures |
| --- | --- |
| `goto-login-page` | Full page navigation to the login page (`goto` → `load`). |
| `login-to-inventory-ready` | Click **Login** → inventory container visible. |
| `add-to-cart-to-badge-updated` | Click **Add to cart** → cart badge shows `1`. |
| `open-cart-to-item-verified` | Open cart → item + quantity verified. |
| `checkout-form-to-overview` | Open checkout → fill details → **Continue** → overview. |
| `checkout-submit-to-confirmation-visible` | Click **Finish** → confirmation header visible. |
| `total-journey-duration` | Whole journey wall-clock duration. |

> **These are NOT INP.** INP (Interaction to Next Paint) is a specific Core Web Vital that requires
> the official `web-vitals` implementation and correct measurement of the *worst* interaction
> latency. This PoC does **not** measure INP and says so explicitly in the metrics output.

### Metadata

`runId`, `timestamp`, `testStatus`, `baseUrl`, `pageUrl`, browser + version, user agent, OS
type/platform/release/arch, viewport, device memory, hardware concurrency and Node version are
recorded for traceability.

## Lighthouse metrics (lab audit)

Produced by [src/lighthouse-audit.js](../src/lighthouse-audit.js) for **each configured page** — the
public login page and any pages behind it, audited with a session cookie.

| Metric | Meaning | Caveats |
| --- | --- | --- |
| Performance / Accessibility / Best Practices / SEO **category scores** | Lighthouse category score (0–1) | Controlled lab audit under simulated throttling; **not** real-user monitoring. |
| `first-contentful-paint` | FCP | Lab environment. |
| `largest-contentful-paint` | LCP | Lab environment. |
| `cumulative-layout-shift` | CLS | Lab environment. |
| `speed-index` | Speed Index | Lab environment. |
| `total-blocking-time` | TBT | Lab environment (a proxy for main-thread blocking; **not** INP). |
| `interactive` | Time to Interactive | Lab environment. |
| `server-response-time` | TTFB from the lab run | Lab environment. |
| `total-byte-weight` | Total transfer weight | Lab environment. |

Lighthouse's lab score is a **controlled audit** and is **not** the same as real-user monitoring.
It is kept **separate** from the authenticated Playwright journey and must not be compared directly
to the journey interaction timings.

## What this PoC does NOT measure

- **INP** — not measured (see above).
- **Load / stress / soak / capacity behaviour** — requires JMeter or similar.
- **Backend-only latency** — requires server-side instrumentation and a non-production environment.
- **Long-term real-user trends** — requires RUM (Real User Monitoring), not a single lab run.
