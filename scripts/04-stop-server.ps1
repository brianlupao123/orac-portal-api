param(
  [int]$Port = 5050
)

$ErrorActionPreference = "Stop"

Write-Host "Looking for a process listening on port $Port..."

$connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue

if (-not $connections) {
  Write-Host "No running server found on port $Port."
  exit 0
}

$processIds = $connections | Select-Object -ExpandProperty OwningProcess -Unique

foreach ($processId in $processIds) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if (-not $process) {
    continue
  }

  Write-Host "Stopping process $($process.ProcessName) with PID $processId on port $Port..."
  Stop-Process -Id $processId -Force
}

Start-Sleep -Milliseconds 500

$stillRunning = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($stillRunning) {
  throw "Port $Port is still in use after stop attempt."
}

Write-Host "Port $Port is free."

