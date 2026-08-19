param()

$ErrorActionPreference = "Stop"

if (-not $env:APPDATA) {
  throw "APPDATA is not set"
}

$source = Join-Path $PSScriptRoot "codex-live-token-cost.js"
$targetDir = Join-Path $env:APPDATA "Codex++\user_scripts"
$target = Join-Path $targetDir "market-codex-live-token-cost.js"

if (-not (Test-Path -LiteralPath $source)) {
  throw "Source script not found: $source"
}

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
$temp = Join-Path $targetDir (".$([System.IO.Path]::GetFileName($target)).$([guid]::NewGuid().ToString('N')).tmp")
$backup = Join-Path $targetDir (".$([System.IO.Path]::GetFileName($target)).$([guid]::NewGuid().ToString('N')).bak")
try {
  Copy-Item -LiteralPath $source -Destination $temp -Force

  $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash.ToLowerInvariant()
  $tempHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $temp).Hash.ToLowerInvariant()
  if ($sourceHash -ne $tempHash) {
    throw "Temporary userscript hash does not match source"
  }

  if (Test-Path -LiteralPath $target) {
    [System.IO.File]::Replace($temp, $target, $backup)
  } else {
    [System.IO.File]::Move($temp, $target)
  }
} finally {
  if (Test-Path -LiteralPath $temp) {
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $backup) {
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
  }
}

$targetHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLowerInvariant()
$matched = $sourceHash -eq $targetHash

Write-Output "source=$source"
Write-Output "target=$target"
Write-Output "source_sha256=$sourceHash"
Write-Output "target_sha256=$targetHash"
Write-Output "match=$($matched.ToString().ToLowerInvariant())"

if (-not $matched) {
  exit 1
}
