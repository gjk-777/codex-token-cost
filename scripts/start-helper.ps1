param(
  [ValidateRange(1, 65535)]
  [int]$Port = 17888,
  [ValidateSet("127.0.0.1", "::1")]
  [string]$ListenHost = "127.0.0.1"
)

$ErrorActionPreference = "Stop"
$helper = Join-Path $PSScriptRoot "codex-local-usage-helper.cjs"
$logDir = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".codex"
$stdoutLog = Join-Path $logDir "codex-token-cost-helper.out.log"
$stderrLog = Join-Path $logDir "codex-token-cost-helper.err.log"

if (-not (Test-Path -LiteralPath $helper)) {
  throw "Helper script not found: $helper"
}

$hostForUri = if ($ListenHost -eq "::1") { "[$ListenHost]" } else { $ListenHost }
$healthUri = "http://${hostForUri}:$Port/health"

function Test-HelperHealth {
  try {
    $health = Invoke-RestMethod -Uri $healthUri -TimeoutSec 2
    return ($health.ok -eq $true -and $health.source -eq "codex-local-usage-helper" -and $health.bridge -eq "cc-switch")
  } catch {
    return $false
  }
}

if (Test-HelperHealth) {
  return
}

$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalAddress -in @($ListenHost, "0.0.0.0", "::") } |
  Select-Object -First 1
if ($existing) {
  throw "Port $Port is already listening on $ListenHost, but it is not the Codex Token Cost helper."
}

$node = (Get-Command node -ErrorAction Stop).Source
$helperArgument = '"' + $helper + '"'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$process = Start-Process -FilePath $node `
  -ArgumentList @($helperArgument, "--serve", "--host", $ListenHost, "--port", $Port) `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -PassThru

for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
  Start-Sleep -Milliseconds 100
  if (Test-HelperHealth) {
    return
  }
  $process.Refresh()
  if ($process.HasExited) {
    break
  }
}

$exitCode = if ($process.HasExited) { $process.ExitCode } else { "running" }
throw "Codex Token Cost helper did not become healthy at $healthUri (process=$exitCode). Logs: $stdoutLog; $stderrLog"
