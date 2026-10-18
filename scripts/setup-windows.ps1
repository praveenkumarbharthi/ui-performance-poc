# Verifies prerequisites then installs dependencies + Playwright Chromium.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/setup-windows.ps1

$ErrorActionPreference = 'Continue'

Write-Host 'ui-performance-poc - Windows setup'

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

if (Test-Command 'node') {
    Write-Host "[OK]  Node.js $(node -v)"
} else {
    Write-Error '[FAIL] Node.js not found on PATH. Install Node.js >= 22.19 (required by Lighthouse 13).'
    exit 1
}

if (Test-Command 'npm') {
    Write-Host "[OK]  npm $(npm -v)"
} else {
    Write-Error '[FAIL] npm not found on PATH.'
    exit 1
}

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
