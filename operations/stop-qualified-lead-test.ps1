$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$isolatedEnv = Join-Path $root '.env.qualified-lead-test.local'
$compose = Join-Path $PSScriptRoot 'qualified-lead-test.compose.yml'
$pidPath = Join-Path $root 'data\qualified-lead-test\server.pid'

if (Test-Path -LiteralPath $pidPath) {
  $isolatedPid = [int](Get-Content -LiteralPath $pidPath -Raw).Trim()
  $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$isolatedPid" -ErrorAction SilentlyContinue
  if ($candidate -and $candidate.Name -match '^node(\.exe)?$' -and $candidate.CommandLine -match 'dist[/\\]main\.js') {
    Stop-Process -Id $isolatedPid
  }
  Remove-Item -LiteralPath $pidPath -Force
}

docker info *> $null
if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $isolatedEnv)) {
  docker compose --env-file $isolatedEnv -f $compose down
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo detener la instancia Docker aislada' }
}

Write-Output 'qualified_lead_test_stopped=true'
Write-Output 'sqlite_preserved=true'
