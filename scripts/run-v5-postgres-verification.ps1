param(
    [string]$Database = "orac_v5_writer_test"
)

$ErrorActionPreference = "Stop"
$psql = "D:\ORAC-Test\PostgreSQL16\bin\psql.exe"
$backend = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path -LiteralPath $psql)) {
    throw "PostgreSQL command-line tools were not found at $psql."
}

$password = Read-Host "Enter the PostgreSQL test password you created" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)

try {
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    $env:PGPASSWORD = $plainPassword

    $existsOutput = & $psql -h 127.0.0.1 -p 5432 -U postgres -d postgres -Atqc "SELECT 1 FROM pg_database WHERE datname = '$Database'"
    if ($LASTEXITCODE -ne 0) {
        throw "Could not connect to local PostgreSQL. Check the password and try again."
    }
    $exists = ($existsOutput | Out-String).Trim()
    if ($exists -eq "1") {
        $tables = & $psql -h 127.0.0.1 -p 5432 -U postgres -d $Database -Atqc "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
        if ($LASTEXITCODE -ne 0) {
            throw "Could not inspect the existing test database."
        }
        $unexpectedTables = @($tables | Where-Object { $_ -and $_ -ne "store" })
        if ($unexpectedTables.Count -gt 0) {
            throw "STOP: $Database contains application tables: $($unexpectedTables -join ', ')."
        }
        Write-Host "Using the existing disposable $Database database."
    } else {
        & $psql -h 127.0.0.1 -p 5432 -U postgres -d postgres -c "CREATE DATABASE $Database"
        if ($LASTEXITCODE -ne 0) {
            throw "Database creation failed."
        }
    }

    Set-Location $backend
    $env:ORAC_TEST_DATABASE_URL = "postgres://postgres:$plainPassword@127.0.0.1:5432/$Database"
    node.exe --test tests/v5InvoiceWriterPostgres.test.js
    if ($LASTEXITCODE -ne 0) {
        throw "PostgreSQL verification failed."
    }
}
finally {
    Remove-Item Env:PGPASSWORD, Env:ORAC_TEST_DATABASE_URL -ErrorAction SilentlyContinue
    if ($bstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    Remove-Variable plainPassword -ErrorAction SilentlyContinue
}
