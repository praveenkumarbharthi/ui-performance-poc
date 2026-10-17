# -----------------------------------------------------------------------------
# setup-windows.ps1
# Verifies prerequisites and installs project dependencies + Playwright Chromium.
# Works from a directory path containing spaces. Uses only cross-platform npm
# commands plus version checks for Node.js, npm and Google Chrome.
#
# Usage (from the project root):
#   powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/setup-windows.ps1
# -----------------------------------------------------------------------------

$ErrorActionPreference = 'Continue'

Write-Host '============================================='
Write-Host ' ui-performance-poc - Windows setup'
Write-Host '============================================='

function Test-Command($name) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    return [bool]$cmd
}

# --- Node.js -----------------------------------------------------------------
if (Test-Command 'node') {
    $nodeVersion = (node -v)
    Write-Host "[OK]  Node.js $nodeVersion"
} else {
    Write-Error '[FAIL] Node.js not found on PATH. Install Node.js LTS (>=18.18).'
    exit 1
}

# --- npm ---------------------------------------------------------------------
if (Test-Command 'npm') {
    $npmVersion = (npm -v)
    Write-Host "[OK]  npm $npmVersion"
} else {
    Write-Error '[FAIL] npm not found on PATH.'
    exit 1
}

# --- Google Chrome (needed by Lighthouse) -----------------------------------
$chromeCandidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chromeFound = $null
foreach ($candidate in $chromeCandidates) {
    if ($candidate -and (Test-Path $candidate)) { $chromeFound = $candidate; break }
}
if ($chromeFound) {
    Write-Host "[OK]  Google Chrome found: $chromeFound"
} else {
    Write-Warning '[WARN] Google Chrome not found in common locations.'
    Write-Warning '       Playwright Chromium is installed below; Lighthouse prefers system Chrome.'
    Write-Warning '       Set CHROME_PATH if Chrome is installed elsewhere.'
}

# --- Install dependencies ----------------------------------------------------
if (Test-Path 'package-lock.json') {
    Write-Host '[INFO] package-lock.json found -> running npm ci'
    npm ci
} else {
    Write-Host '[INFO] No lock file -> running npm install (will generate package-lock.json)'
    npm install
}
if ($LASTEXITCODE -ne 0) {
    Write-Error '[FAIL] Dependency installation failed.'
    exit $LASTEXITCODE
}
Write-Host '[OK]  Dependencies installed.'

# --- Playwright Chromium -----------------------------------------------------
Write-Host '[INFO] Installing Playwright Chromium browser...'
npx playwright install chromium
if ($LASTEXITCODE -ne 0) {
    Write-Error '[FAIL] Playwright Chromium installation failed.'
    exit $LASTEXITCODE
}
Write-Host '[OK]  Playwright Chromium installed.'

Write-Host ''
Write-Host 'Setup complete. Next steps:'
Write-Host '  npm run test:ui       # run the UI journey'
Write-Host '  npm run lighthouse    # run the Lighthouse audit'
Write-Host '  npm run all           # full workflow + reports + validation'
exit 0
