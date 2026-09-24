param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^TEST[0-9A-Za-z_-]+$')]
  [string]$TestEventCode,
  [switch]$Start
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sourceEnv = Join-Path $root '.env'
$waEnv = Join-Path $root '.env.meta-wa-readonly.local'
$isolatedEnv = Join-Path $root '.env.qualified-lead-test.local'
$compose = Join-Path $PSScriptRoot 'qualified-lead-test.compose.yml'

function Read-DotEnv([string]$Path) {
  $values = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $values }
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
      $values[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'")
    }
  }
  return $values
}

$base = Read-DotEnv $sourceEnv
$wa = Read-DotEnv $waEnv
$required = @{
  META_WA_CAPI_ACCESS_TOKEN = [string]$base['META_WA_CAPI_ACCESS_TOKEN']
  META_WABA_ID = [string]$wa['META_WABA_ID']
  META_MESSAGING_DATASET_ID = [string]$wa['META_MESSAGING_DATASET_ID']
  META_WA_BM_TEST_CTWA_CLID = [string]$wa['META_WA_BM_TEST_CTWA_CLID']
}
foreach ($entry in $required.GetEnumerator()) {
  if ([string]::IsNullOrWhiteSpace($entry.Value)) { throw "Falta $($entry.Key) en el almacén local autorizado" }
}
if ($required.META_WABA_ID -eq $required.META_MESSAGING_DATASET_ID) {
  throw 'WABA y dataset de mensajería deben ser distintos'
}

$secretBytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($secretBytes)
$internalSecret = [Convert]::ToHexString($secretBytes).ToLowerInvariant()
$lines = @(
  'QL_TEST_HOST_PORT=3110'
  'META_MODE=test'
  'META_API_VERSION=v21.0'
  'META_WA_API_VERSION=v26.0'
  "META_TEST_EVENT_CODE=$TestEventCode"
  "META_CAPI_INTERNAL_SECRET=$internalSecret"
  "META_WA_CAPI_ACCESS_TOKEN=$($required.META_WA_CAPI_ACCESS_TOKEN)"
  "META_WABA_ID=$($required.META_WABA_ID)"
  "META_MESSAGING_DATASET_ID=$($required.META_MESSAGING_DATASET_ID)"
  "META_WA_BM_TEST_CTWA_CLID=$($required.META_WA_BM_TEST_CTWA_CLID)"
  'META_WA_CRM_QUALIFICATION_DELIVERY_ENABLED=true'
)
[IO.File]::WriteAllLines($isolatedEnv, $lines, [Text.UTF8Encoding]::new($false))

docker compose --env-file $isolatedEnv -f $compose config --quiet
if ($LASTEXITCODE -ne 0) { throw 'La configuración aislada no es válida' }

if ($Start) {
  docker info *> $null
  if ($LASTEXITCODE -eq 0) {
    docker compose --env-file $isolatedEnv -f $compose up -d --build
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo iniciar la instancia Docker aislada' }
    $startMethod = 'docker_compose'
  } else {
    $entrypoint = Join-Path $root 'dist\main.js'
    if (-not (Test-Path -LiteralPath $entrypoint)) {
      throw 'Docker no está disponible y falta dist/main.js; ejecute npm run build sin iniciar servicios'
    }
    foreach ($line in $lines) {
      $parts = $line -split '=', 2
      [Environment]::SetEnvironmentVariable($parts[0], $parts[1], 'Process')
    }
    [Environment]::SetEnvironmentVariable('PORT', '3110', 'Process')
    [Environment]::SetEnvironmentVariable('DATABASE_PATH', (Join-Path $root 'data\qualified-lead-test\qualified-lead-test.db'), 'Process')
    [Environment]::SetEnvironmentVariable('META_CAPI_ACCESS_TOKEN', '', 'Process')
    [Environment]::SetEnvironmentVariable('SUPABASE_DRAIN_ENABLED', 'false', 'Process')
    [Environment]::SetEnvironmentVariable('SUPABASE_URL', '', 'Process')
    [Environment]::SetEnvironmentVariable('SUPABASE_SERVICE_ROLE_KEY', '', 'Process')
    [Environment]::SetEnvironmentVariable('META_SCHEDULE_RECOVER_ENABLED', 'false', 'Process')
    [Environment]::SetEnvironmentVariable('META_SCHEDULE_DELIVERY_ENABLED', 'false', 'Process')
    [Environment]::SetEnvironmentVariable('META_WA_LEAD_SUBMITTED_DELIVERY_ENABLED', 'false', 'Process')
    [Environment]::SetEnvironmentVariable('META_PURCHASE_DELIVERY_ENABLED', 'false', 'Process')
    [Environment]::SetEnvironmentVariable('META_WA_CLOUD_WEBHOOK_CHALLENGE_ENABLED', 'false', 'Process')
    [Environment]::SetEnvironmentVariable('META_WA_CLOUD_WEBHOOK_RECEIVE_ENABLED', 'false', 'Process')
    [Environment]::SetEnvironmentVariable('META_WA_CTWA_RECONCILE_ENABLED', 'false', 'Process')
    New-Item -ItemType Directory -Force -Path (Join-Path $root 'data\qualified-lead-test') | Out-Null
    $process = Start-Process -FilePath 'node' -ArgumentList 'dist/main.js' -WorkingDirectory $root -WindowStyle Hidden -PassThru
    Set-Content -LiteralPath (Join-Path $root 'data\qualified-lead-test\server.pid') -Value $process.Id
    $startMethod = 'local_hidden_process'
  }
}

Write-Output 'qualified_lead_test_prepared=true'
Write-Output "started=$([bool]$Start)"
if ($Start) { Write-Output "start_method=$startMethod" }
Write-Output 'production_configuration_changed=false'
