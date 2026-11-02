$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$evidence = Join-Path $root 'release-evidence\v5-fictional-api-uat'
New-Item -ItemType Directory -Force -Path $evidence | Out-Null

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$output = Join-Path $evidence "api-uat-$stamp.log"
$statusPath = Join-Path $evidence "api-uat-$stamp.status.txt"
$statusLines = [System.Collections.Generic.List[string]]::new()

Push-Location $root
$bstr = [IntPtr]::Zero
try {
    $statusLines.Add("ORAC V5 fictional API UAT")
    $statusLines.Add("Started: $(Get-Date -Format o)")
    $statusLines.Add("Checkout: $root")
    $statusLines.Add("Flags are controlled by the test files and are not persisted.")

    $password = Read-Host "Enter the local disposable PostgreSQL test password" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    $env:ORAC_TEST_DATABASE_URL = "postgres://postgres:$plainPassword@127.0.0.1:5432/orac_v5_writer_test"

    & node.exe --test `
        tests/v5InvoiceWriterFoundation.test.js `
        tests/v5InvoiceWriterHttp.test.js `
        tests/v5InvoiceWriterPostgres.test.js 2>&1 | Tee-Object -FilePath $output

    $exitCode = $LASTEXITCODE
    $statusLines.Add("Exit code: $exitCode")
    $statusLines.Add("Finished: $(Get-Date -Format o)")

    if ($exitCode -ne 0) {
        throw "Fictional V5 API UAT failed. See $output"
    }
}
finally {
    [System.IO.File]::WriteAllLines($statusPath, $statusLines)
    Remove-Item Env:ORAC_TEST_DATABASE_URL -ErrorAction SilentlyContinue
    if ($bstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    Remove-Variable plainPassword -ErrorAction SilentlyContinue
    Pop-Location
}
