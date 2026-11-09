param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$archivePath = [System.IO.Path]::GetFullPath($OutputPath)
$archiveParent = [System.IO.Path]::GetDirectoryName($archivePath)

if (-not (Test-Path -LiteralPath $archiveParent -PathType Container)) {
  throw "Archive output directory does not exist."
}
if (Test-Path -LiteralPath $archivePath) {
  throw "Archive output already exists; refusing to overwrite it."
}

# Archive only tracked runtime and deployment inputs from one exact commit.
# Working-tree changes, local data, reports and credentials cannot enter this ZIP.
$paths = @(
  '.dockerignore', 'Dockerfile', 'fly.toml', 'render.yaml',
  'package.json', 'package-lock.json', 'server.js', 'src', 'knowledge-base'
)
$head = (& git -C $repository rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -notmatch '^[0-9a-f]{40}$') {
  throw "Could not identify the source commit."
}

foreach ($path in $paths) {
  $tracked = & git -C $repository ls-tree HEAD -- $path
  if ($LASTEXITCODE -ne 0 -or -not $tracked) {
    throw "Required archive path is absent from the source commit: $path"
  }
}

try {
  & git -C $repository archive --format=zip "--output=$archivePath" HEAD -- @paths
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $archivePath)) {
    throw "git archive failed."
  }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
  try {
    $names = @($zip.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
    if ($names.Count -eq 0 -or $names -notcontains 'server.js' -or $names -notcontains 'package.json') {
      throw "Archive is incomplete."
    }
    $forbidden = '(^|/)(data|node_modules|\.git|\.lead-retry-backups|\.orac-v5-signature-phase)(/|$)|(^|/)\.env(\.|$)|(^|/)\.orac-ssr-[^/]*(/|$)|\.log$'
    foreach ($name in $names) {
      if ($name -match $forbidden) {
        throw "Archive contains a forbidden path: $name"
      }
    }
  }
  finally {
    $zip.Dispose()
  }

  $hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
  Write-Output "Source commit: $head"
  Write-Output "Archive: $archivePath"
  Write-Output "Files: $($names.Count)"
  Write-Output "SHA-256: $hash"
  Write-Output "Path exclusions: passed"
  Write-Output "Content privacy scan: pending Lane F3"
}
catch {
  if (Test-Path -LiteralPath $archivePath) {
    Remove-Item -LiteralPath $archivePath -Force
  }
  throw
}
