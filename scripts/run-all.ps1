$ErrorActionPreference = 'Continue'

if (-not $env:RUN_ID -or $env:RUN_ID.Trim() -eq '') {
    $env:RUN_ID = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ss-fff')
}
if (-not $env:RUN_STARTED_AT -or $env:RUN_STARTED_AT.Trim() -eq '') {
    $env:RUN_STARTED_AT = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}
Write-Host "Run ID: $env:RUN_ID"
Write-Host "Run started at: $env:RUN_STARTED_AT"

# Persist the start time so report aggregation can reject stale artifacts even
# when it runs in a separate process without the environment variable.
$reportsDir = Join-Path $PSScriptRoot '..\reports'
New-Item -ItemType Directory -Force -Path $reportsDir | Out-Null
Set-Content -Path (Join-Path $reportsDir 'run-started-at.txt') -Value $env:RUN_STARTED_AT -NoNewline

$results = [ordered]@{}

# Stages are passed as scriptblocks so no shell string is ever evaluated
# (avoids injection) and the stage exit code is captured reliably.
function Invoke-Stage {
    param(
        [string]$Name,
        [scriptblock]$Action
    )
    Write-Host ''
    Write-Host "STAGE: $Name"
    & $Action
    $code = $LASTEXITCODE
    $script:results[$Name] = $code
    if ($code -eq 0) {
        Write-Host "[OK]  $Name (exit $code)"
    } else {
        Write-Host "[FAIL] $Name (exit $code)"
    }
}

Invoke-Stage -Name 'UI journey'       -Action { npm run test:ui }
$uiExit = $results['UI journey']

Invoke-Stage -Name 'Lighthouse audit' -Action { npm run lighthouse }
$lhExit = $results['Lighthouse audit']

# The audit's own summary is authoritative: a partial audit (some pages failed or
# skipped) records status `unstable` and still exits 0, so the exit code alone
# cannot tell a complete pass apart from an incomplete run.
$lhStatus = 'missing'
$lhSummaryPath = Join-Path $reportsDir 'lighthouse\summary.json'
if (Test-Path $lhSummaryPath) {
    try {
        $lhStatus = [string](Get-Content -Path $lhSummaryPath -Raw -ErrorAction Stop | ConvertFrom-Json).status
        if ([string]::IsNullOrWhiteSpace($lhStatus)) { $lhStatus = 'unknown' }
    } catch {
        $lhStatus = 'invalid'
    }
}

# Always generate the summary + validation, even after an earlier failure, so
# operators get maximum evidence about what happened.
Invoke-Stage -Name 'Report summary'   -Action { npm run report }
$reportExit = $results['Report summary']

Invoke-Stage -Name 'Validate reports' -Action { npm run validate:reports }
$validateExit = $results['Validate reports']

Write-Host ''
Write-Host 'Workflow summary'
foreach ($entry in $results.GetEnumerator()) {
    $status = if ($entry.Value -eq 0) { 'PASS' } else { 'FAIL' }
    Write-Host ("  {0,-20} {1} (exit {2})" -f $entry.Key, $status, $entry.Value)
}
Write-Host ("  {0,-20} {1}" -f 'Lighthouse status', $lhStatus)
Write-Host ''

# Critical stages: UI journey, report summary, report validation. Lighthouse is
# reported separately (network/browser dependent).
$criticalFailed = ($uiExit -ne 0) -or ($reportExit -ne 0) -or ($validateExit -ne 0)

if ($criticalFailed) {
    Write-Host '[RESULT] One or more critical stages failed. See logs and reports above.'
    exit 1
}

# strict=1 promotes an incomplete or failed audit into a non-zero exit code.
$strict = ($env:STRICT -eq '1')

# A non-zero exit, or a missing/invalid/failed summary, means the audit did not
# complete. `unstable` means it ran but only partially. Neither is a pass.
$lhAuditFailed = ($lhExit -ne 0) -or ($lhStatus -in @('failed', 'missing', 'invalid', 'unknown'))

if ($lhAuditFailed) {
    Write-Host "[RESULT] UI journey passed but the Lighthouse audit failed (status=$lhStatus, exit=$lhExit). See reports/lighthouse/summary.json."
    if ($strict) { exit 1 }
    exit 0
}

if ($lhStatus -eq 'unstable') {
    Write-Host '[RESULT] Workflow INCOMPLETE: the Lighthouse audit only partially completed (status=unstable; some pages failed or were skipped). This is not a full pass. See reports/lighthouse/summary.json.'
    if ($strict) { exit 1 }
    exit 0
}

Write-Host '[RESULT] All stages completed successfully.'
exit 0
