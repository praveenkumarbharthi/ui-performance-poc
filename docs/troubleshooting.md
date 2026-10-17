# Troubleshooting (Windows focus)

## PowerShell execution policy

**Symptom:** running a `.ps1` script fails with *"cannot be loaded because running scripts is
disabled on this system"*.

**Fix (per-invocation, no machine-wide change):**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/setup-windows.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/run-all.ps1
```

**Fix (current user only, persistent):**

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

Do not lower the policy machine-wide unless your IT policy allows it.

## Node.js / npm not found

**Symptom:** `node -v` or `npm -v` is not recognised.

**Fix:** install Node.js **LTS (>=18.18)** from <https://nodejs.org> and reopen the terminal so PATH
refreshes. Verify with `node -v` and `npm -v`.

## Playwright browser missing

**Symptom:** *"Executable doesn't exist ... please run the following command to download new
browsers: npx playwright install"*.

**Fix:**

```powershell
npx playwright install chromium
```

If a corporate proxy blocks the download, configure `HTTPS_PROXY` / `HTTP_PROXY` for the session
before installing. Do **not** disable TLS verification.

## Lighthouse cannot find Chrome

**Symptom:** Lighthouse fails with a Chrome launch error, or `Channel ... not found`.

**Fix options:**

1. Install Google Chrome, or
2. Point Lighthouse at an explicit binary:

```powershell
$env:CHROME_PATH = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
npm run lighthouse
```

Chrome may live in `Program Files (x86)` or `%LOCALAPPDATA%` depending on installation type.

## Port already in use

**Symptom:** Chrome/Lighthouse fails to bind, or a debug port is occupied.

**Fix:** close leftover Chrome processes and retry:

```powershell
Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force
```

`chrome-launcher` picks a free port automatically; a stale process is the usual culprit.

## Paths containing spaces

All scripts use quoted paths and Node's cross-platform `path` APIs, so `C:\Program Files\...`-style
or user directories with spaces work. If you call scripts manually, always quote paths:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\My Projects\ui-performance-poc\scripts\run-all.ps1"
```

## Permissions / cleanup issues

**Symptom:** `EPERM` or *"resource busy"* when removing `reports/raw` or `test-results`.

**Fix:** ensure no Chrome/Playwright process holds the files, then retry:

```powershell
Get-Process chrome,node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*playwright*' } | Stop-Process -Force
npm run clean
```

## Network / certificate problems

- SauceDemo and the Lighthouse audit both require outbound HTTPS. Behind a proxy, set `HTTPS_PROXY`
  (and `HTTP_PROXY`) for the session.
- **Never** disable TLS verification to work around certificate issues; fix the trust chain or the
  proxy configuration instead.
- If the network is unavailable, the UI journey and Lighthouse cannot run. The tooling reports the
  failure explicitly (it does **not** fake success). Run the offline validation only:

```powershell
node -c src/config.js        # syntax check example
npm run validate:reports
```

## `npm run all` reports a Lighthouse failure

This is expected when Chrome or the network is unavailable. The UI journey results remain valid and
the overall exit code stays `0` unless you set `STRICT=1`:

```powershell
$env:STRICT = "1"; npm run all
```

Check `reports/lighthouse/summary.json` — it records the exact error instead of fabricating scores.

## Reports look stale

Each run writes raw artifacts to `reports/raw/<runId>/`. The *latest* convenient files
(`reports/summary.json`, `reports/SUMMARY.md`) are overwritten by design. To keep runs isolated,
set an explicit `RUN_ID`:

```powershell
$env:RUN_ID = "release-2026-10-17"; npm run all
```
