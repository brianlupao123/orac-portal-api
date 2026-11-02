param(
  [string]$ProjectRoot = (Resolve-Path "$PSScriptRoot\..").Path
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $ProjectRoot)) {
  throw "Project root not found: $ProjectRoot"
}

$projectName = Split-Path -Leaf $ProjectRoot
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupRoot = Join-Path (Split-Path -Parent $ProjectRoot) "_orac-ios-backups"
$backupPath = Join-Path $backupRoot "$projectName-$timestamp"

New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null

if (Test-Path -LiteralPath $backupPath) {
  throw "Backup destination already exists; refusing to reuse or overwrite it: $backupPath"
}

$excludeDirs = @("node_modules", ".git", "_orac-ios-backups")

Write-Host "Creating backup..."
Write-Host "From: $ProjectRoot"
Write-Host "To:   $backupPath"

New-Item -ItemType Directory -Path $backupPath | Out-Null

Get-ChildItem -LiteralPath $ProjectRoot -Force | ForEach-Object {
  if ($_.PSIsContainer -and $excludeDirs -contains $_.Name) {
    return
  }
  Copy-Item -LiteralPath $_.FullName -Destination $backupPath -Recurse -Force
}

Write-Host "Backup complete: $backupPath"

