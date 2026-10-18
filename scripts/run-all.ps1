$ErrorActionPreference = 'Continue'

if (-not $env:RUN_ID -or $env:RUN_ID.Trim() -eq '') {
    $env:RUN_ID = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ss-fff')
}
Write-Host "Run ID: $env:RUN_ID"

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
Write-Host ''

# Critical stages: UI journey, report summary, report validation. Lighthouse is
# reported separately (network/browser dependent) and only fails under STRICT=1.
$criticalFailed = ($uiExit -ne 0) -or ($reportExit -ne 0) -or ($validateExit -ne 0)

if ($criticalFailed) {
    Write-Host '[RESULT] One or more critical stages failed. See logs and reports above.'
    exit 1
}

if ($lhExit -ne 0) {
    Write-Host '[RESULT] UI journey passed but the Lighthouse audit failed (see reports/lighthouse/summary.json).'
    if ($env:STRICT -eq '1') { exit 1 }
    exit 0
}

Write-Host '[RESULT] All stages completed successfully.'
exit 0
