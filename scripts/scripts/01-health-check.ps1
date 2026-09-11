param(
  [string]$ProjectRoot = (Resolve-Path "$PSScriptRoot\..").Path
)

$ErrorActionPreference = "Stop"

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [string[]]$Arguments = @()
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($Arguments -join ' ')"
  }
}

Write-Host "Orac-IOS health check"
Write-Host "Project: $ProjectRoot"

$requiredFiles = @(
  "package.json",
  "server.js",
  "src\store.js",
  "src\stateMachine.js",
  "src\exporter.js",
  "public\index.html",
  "public\styles.css",
  "public\app.js",
  "db\migrations\001_schema_core.sql",
  "db\migrations\002_schema_assets.sql",
  "db\migrations\003_schema_commercial.sql",
  "tests\stateMachine.test.js"
)

$missing = @()
foreach ($file in $requiredFiles) {
  $path = Join-Path $ProjectRoot $file
  if (-not (Test-Path -LiteralPath $path)) {
    $missing += $file
  }
}

if ($missing.Count -gt 0) {
  Write-Host "Missing required files:" -ForegroundColor Red
  $missing | ForEach-Object { Write-Host " - $_" -ForegroundColor Red }
  exit 1
}

Push-Location $ProjectRoot
try {
  Write-Host "Checking Node.js..."
  Invoke-Checked "node" @("--version")

  Write-Host "Checking server syntax..."
  Invoke-Checked "node" @("--check", "server.js")

  Write-Host "Running state machine tests..."
  Invoke-Checked "node" @("tests\stateMachine.test.js")

  Write-Host "Health check passed." -ForegroundColor Green
}
finally {
  Pop-Location
}
