Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

$secure = Read-Host "Enter the local PostgreSQL password" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)

try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)

    # Keep the password out of the connection URL so URL-reserved characters
    # cannot be misinterpreted by the PostgreSQL connection parser.
    $env:PGPASSWORD = $plain
    $env:NODE_ENV = "development"
    $env:PORT = "5050"
    $env:STORE_DRIVER = "postgres"
    $env:DATABASE_URL = "postgres://postgres@127.0.0.1:5432/orac_phase5_browser_test?sslmode=disable"
    $env:ORAC_REQUIRE_PASSWORD = "true"
    Remove-Item Env:ORAC_V5_COMMERCIAL_WORKFLOW -ErrorAction SilentlyContinue
    Remove-Item Env:ORAC_V5_INVOICE_WRITER -ErrorAction SilentlyContinue

    & node.exe server.js
}
finally {
    Remove-Item Env:PGPASSWORD, Env:DATABASE_URL -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    Remove-Variable plain -ErrorAction SilentlyContinue
}
