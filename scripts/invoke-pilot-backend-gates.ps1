[CmdletBinding()]
param(
    [switch]$IncludeMaintenance
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$reportDirectory = Join-Path $root 'evidence\stage-reports'
$reportPath = Join-Path $reportDirectory "pilot-backend-gates-$timestamp.txt"

function Stop-Gate([string]$Message) {
    New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null
    "BLOCKED: $Message" | Set-Content -LiteralPath $reportPath -Encoding utf8
    Write-Error "$Message Report: $reportPath"
    exit 1
}

if (-not (Test-Path -LiteralPath (Join-Path $root 'package.json') -PathType Leaf)) {
    Stop-Gate "Backend package.json was not found at $root."
}
if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules') -PathType Container)) {
    Stop-Gate "Backend dependencies are missing. Run npm ci first."
}

$dirty = git -C $root status --porcelain
if ($LASTEXITCODE -ne 0) {
    Stop-Gate "Git status could not be read."
}
if ($dirty) {
    Stop-Gate "Backend is dirty. Commit or stash reviewed changes before running gates."
}

New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null
@(
    "ORAC-IOS pilot backend gate report",
    "Timestamp: $(Get-Date -Format o)",
    "Branch: $(git -C $root branch --show-current)",
    "Commit: $(git -C $root rev-parse HEAD)",
    "Mode: local tests only; no deployment, migration, seed, database connection, commit, or push"
) | Set-Content -LiteralPath $reportPath -Encoding utf8

Push-Location $root
try {
    $focusedTests = @(
        'tests/reportScope.test.js',
        'tests/passwordResetSafety.test.js',
        'tests/stateMachine.test.js',
        'tests/accountDataRedaction.test.js'
    )
    "`nRunning focused pilot tests..." | Tee-Object -FilePath $reportPath -Append
    & node --test @focusedTests 2>&1 | Tee-Object -FilePath $reportPath -Append
    if ($LASTEXITCODE -ne 0) { throw "Focused pilot tests failed." }

    if ($IncludeMaintenance) {
        "`nRunning full local test suite..." | Tee-Object -FilePath $reportPath -Append
        & node --test tests/*.test.js 2>&1 | Tee-Object -FilePath $reportPath -Append
        if ($LASTEXITCODE -ne 0) { throw "Full local test suite failed." }

        "`nChecking staged and unstaged whitespace..." | Tee-Object -FilePath $reportPath -Append
        & git -C $root diff --check 2>&1 | Tee-Object -FilePath $reportPath -Append
        if ($LASTEXITCODE -ne 0) { throw "Git whitespace check failed." }
    }

    "`nPASS: local backend gates completed. No database or deployment action was performed." |
        Tee-Object -FilePath $reportPath -Append
    Write-Host "Report: $reportPath"
} catch {
    "`nFAIL: $($_.Exception.Message)" | Tee-Object -FilePath $reportPath -Append
    Write-Error "Backend gate failed. Report: $reportPath"
    exit 1
} finally {
    Pop-Location
}
