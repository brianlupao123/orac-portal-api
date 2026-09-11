param(
  [Parameter(Mandatory = $true)]
  [string]$PhaseName,
  [string]$ProjectRoot = (Resolve-Path "$PSScriptRoot\..").Path
)

$ErrorActionPreference = "Stop"

Write-Host "Starting Orac-IOS phase: $PhaseName"

& "$PSScriptRoot\00-backup-current.ps1" -ProjectRoot $ProjectRoot
& "$PSScriptRoot\01-health-check.ps1" -ProjectRoot $ProjectRoot

Write-Host ""
Write-Host "Manual implementation point for phase: $PhaseName"
Write-Host "Apply the phase changes now, then run:"
Write-Host "powershell -ExecutionPolicy Bypass -File .\scripts\01-health-check.ps1"
Write-Host "powershell -ExecutionPolicy Bypass -File .\scripts\02-smoke-test.ps1"

