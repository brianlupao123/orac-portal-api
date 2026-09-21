param(
  [switch]$FullSuite
)

$ErrorActionPreference = "Stop"
$backendRoot = Split-Path -Parent $PSScriptRoot
$reportDirectory = Join-Path $backendRoot "evidence\stage-reports"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$reportPath = Join-Path $reportDirectory "operational-data-gates-$timestamp.md"

Set-Location $backendRoot
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "STOP: Git is required." }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "STOP: Node.js is required." }
if (-not (Test-Path (Join-Path $backendRoot "node_modules"))) { throw "STOP: Backend dependencies are missing. Run npm ci first." }

$status = git status --porcelain
if ($LASTEXITCODE -ne 0) { throw "STOP: Could not inspect Git status." }
if ($status) { throw "STOP: Backend is dirty. Commit or stash reviewed work before running gates." }

New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null
$tests = if ($FullSuite) { @("--test", "--test-concurrency=1", "tests/*.test.js") } else { @("--test", "tests/operationalData.test.js", "tests/operationalDocuments.test.js") }
& node @tests 2>&1 | Tee-Object -FilePath $reportPath -Append
if ($LASTEXITCODE -ne 0) { throw "STOP: Test gate failed. Review $reportPath" }

git diff --check 2>&1 | Tee-Object -FilePath $reportPath -Append
if ($LASTEXITCODE -ne 0) { throw "STOP: Git whitespace gate failed. Review $reportPath" }

Add-Content -LiteralPath $reportPath -Value "`nPASS: Operational data gates completed. No migration, seed, database connection, deployment, or git write was performed."
Write-Host "PASS: Operational data gates completed. Report: $reportPath"
