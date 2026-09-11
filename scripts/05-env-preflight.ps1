$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$envExample = Join-Path $root ".env.example"

Write-Host "Orac-IOS environment preflight" -ForegroundColor Cyan

if (-not (Test-Path -LiteralPath $envExample)) {
  throw ".env.example is missing."
}

$content = Get-Content -LiteralPath $envExample -Raw
$requiredKeys = @(
  "NODE_ENV",
  "PORT",
  "APP_BASE_URL",
  "JWT_SECRET",
  "JWT_EXPIRES_IN",
  "STORE_DRIVER",
  "JSON_DB_PATH",
  "DATABASE_URL",
  "PASTEL_EXPORT_DIR",
  "UPLOAD_DIR",
  "ORAC_PRIMARY_BLUE",
  "ORAC_SLATE",
  "ORAC_WHITE"
)

foreach ($key in $requiredKeys) {
  if ($content -notmatch "(?m)^$key=") {
    throw "Missing key in .env.example: $key"
  }
}

if ($content -notmatch "STORE_DRIVER=json") {
  throw ".env.example must keep STORE_DRIVER=json until Postgres adapter is implemented."
}

Write-Host ".env.example: PASS" -ForegroundColor Green

$migration = Join-Path $root "db\migrations\005_schema_inventory_notifications.sql"
if (-not (Test-Path -LiteralPath $migration)) {
  throw "Missing migration: db\migrations\005_schema_inventory_notifications.sql"
}

$migrationContent = Get-Content -LiteralPath $migration -Raw
foreach ($table in @("company_profile", "suppliers", "stock_items", "stock_movements", "notifications")) {
  if ($migrationContent -notmatch "CREATE TABLE IF NOT EXISTS $table") {
    throw "Migration missing table: $table"
  }
}

Write-Host "migration 005: PASS" -ForegroundColor Green
Write-Host "Environment preflight passed." -ForegroundColor Green
