param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\release-evidence\v5-invoice-writer")
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$target = Join-Path (Resolve-Path $OutputDirectory).Path "v5-invoice-writer-checkout-$timestamp.md"

function Get-FlagState([string]$Name) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($Name))) { return "unset" }
    return "set"
}

$files = @(
    "src/controllers/v5InvoiceWriterController.js",
    "src/v5InvoiceWriter.js",
    "src/v5InvoiceWriterPolicy.js",
    "src/postgresStore.js",
    "tests/v5InvoiceWriterFoundation.test.js",
    "tests/v5InvoiceWriterHttp.test.js",
    "tests/v5InvoiceWriterPostgres.test.js",
    "V5_INVOICE_WRITER_RELEASE_GATES.md",
    "V5_INVOICE_WRITER_FICTIONAL_UAT.md"
)

$status = git -C $root status --short --branch
$branch = git -C $root branch --show-current
$head = git -C $root rev-parse HEAD
$hashes = foreach ($relativePath in $files) {
    $path = Join-Path $root $relativePath
    if (Test-Path -LiteralPath $path) {
        "| ``$relativePath`` | ``$((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash)`` |"
    } else {
        "| ``$relativePath`` | MISSING |"
    }
}

$lines = @(
    "# V5 Invoice Writer Checkout Evidence",
    "",
    "- Captured: $(Get-Date -Format o)",
    "- Root: ``$root``",
    "- Branch: ``$branch``",
    "- HEAD: ``$head``",
    "- V5 commercial flag: $(Get-FlagState "ORAC_V5_COMMERCIAL_WORKFLOW")",
    "- V5 writer flag: $(Get-FlagState "ORAC_V5_INVOICE_WRITER")",
    "- Test database URL: $(Get-FlagState "ORAC_TEST_DATABASE_URL")",
    "",
    "This capture reads the checkout only. It does not run the application, enable a feature, open a database connection, or record any secret value.",
    "",
    "## Git Status",
    "",
    "````text"
) + $status + @(
    "````",
    "",
    "## V5 File Hashes",
    "",
    "| File | SHA-256 |",
    "| --- | --- |"
) + $hashes

Set-Content -LiteralPath $target -Value $lines -Encoding ascii
Write-Host "Captured read-only V5 checkout evidence: $target"
