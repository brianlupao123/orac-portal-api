param(
  [string]$BaseUrl = "http://localhost:5050"
)

$ErrorActionPreference = "Stop"

Write-Host "Orac-IOS smoke test"
Write-Host "Base URL: $BaseUrl"

function Test-Endpoint {
  param(
    [string]$Path,
    [string]$ExpectedText = $null
  )

  $url = "$BaseUrl$Path"
  Write-Host "GET $url"
  $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 10

  if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) {
    throw "Endpoint failed: $url returned $($response.StatusCode)"
  }

  if ($ExpectedText -and ($response.Content -notlike "*$ExpectedText*")) {
    throw "Endpoint content check failed: $url did not contain '$ExpectedText'"
  }

  Write-Host "OK $Path"
}

Test-Endpoint "/" "Orac-IOS"
Test-Endpoint "/api/summary" "clients"
Test-Endpoint "/api/clients" "Example North Mining"
Test-Endpoint "/api/assets/equipment-tags" "EQ-TAG"
Test-Endpoint "/api/exports/pastel.csv" "invoice_number"

Write-Host "Smoke test passed." -ForegroundColor Green

