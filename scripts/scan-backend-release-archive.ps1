param(
  [Parameter(Mandatory = $true)]
  [string]$ArchivePath,
  [string]$OwnerName = $env:ORAC_OWNER_DISPLAY_NAME
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) {
  throw 'Archive does not exist.'
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$rules = [ordered]@{
  known_client_name = '(?i)(?:Zimplats|Mimosa)'
  personal_name = if ($OwnerName) { "(?i)\b$([regex]::Escape($OwnerName))\b" } else { $null }
  workstation_path = '(?i)[A-Z]:\\(?:Users|Projects)\\'
  private_key = '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'
  credential_url = '(?i)postgres(?:ql)?://[^:\s/@]+:[^@\s/]+@'
  access_token = '(?i)\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b'
}

$findings = [System.Collections.Generic.List[object]]::new()
$scannedFiles = 0
$zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $ArchivePath).Path)
try {
  foreach ($entry in $zip.Entries) {
    if ($entry.FullName.EndsWith('/')) { continue }
    $scannedFiles++
    $reader = [System.IO.StreamReader]::new(
      $entry.Open(), [System.Text.UTF8Encoding]::new($false, $true), $true
    )
    try {
      $lineNumber = 0
      while ($null -ne ($line = $reader.ReadLine())) {
        $lineNumber++
        foreach ($label in $rules.Keys) {
          if ($line -match $rules[$label]) {
            $findings.Add([pscustomobject]@{
              file = $entry.FullName
              line = $lineNumber
              category = $label
            })
          }
        }
      }
    }
    finally {
      $reader.Dispose()
    }
  }
}
finally {
  $zip.Dispose()
}

Write-Output "Files scanned: $scannedFiles"
Write-Output "Findings: $($findings.Count)"
foreach ($finding in $findings) {
  # Never print the matched text or any credential value.
  Write-Output "$($finding.file):$($finding.line) [$($finding.category)]"
}
if ($findings.Count -gt 0) {
  throw "Archive privacy scan failed with $($findings.Count) finding(s)."
}
Write-Output 'Archive privacy scan: passed for configured patterns'
