param(
  [Parameter(Mandatory = $true)]
  [switch]$AuthorizeSingleSend
)

$ErrorActionPreference = 'Stop'
if (-not $AuthorizeSingleSend) { throw 'Se requiere -AuthorizeSingleSend' }

$root = Split-Path -Parent $PSScriptRoot
$isolatedEnv = Join-Path $root '.env.qualified-lead-test.local'
$stateDir = Join-Path $root 'data\qualified-lead-test'
$statePath = Join-Path $stateDir 'single-qualified-lead-state.json'
if (-not (Test-Path -LiteralPath $isolatedEnv)) { throw 'Primero prepare la instancia aislada' }

function Read-DotEnv([string]$Path) {
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { $values[$matches[1]] = $matches[2] }
  }
  return $values
}

$envMap = Read-DotEnv $isolatedEnv
$base = 'http://127.0.0.1:3110/api'
$headers = @{ 'X-Internal-Secret' = $envMap.META_CAPI_INTERNAL_SECRET }
$health = Invoke-RestMethod -Method Get -Uri "$base/health" -TimeoutSec 10
if ($health.mode -ne 'test' -or -not $health.test_code_present) { throw 'La instancia no está en carril test con Test Event Code' }
if ($health.supabase_drain.enabled -or $health.wa_cloud_webhook.challenge_enabled -or $health.wa_cloud_webhook.receive_enabled) {
  throw 'Drain o webhook activo en la instancia aislada'
}
if (-not $health.wa_crm_qualification_delivery_enabled) { throw 'QualifiedLead no está habilitado en la instancia aislada' }
if ($health.persistence.database_path -ne '/qualified-lead-test/qualified-lead-test.db') { throw 'SQLite no es la aislada esperada' }

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
if (Test-Path -LiteralPath $statePath) {
  $existing = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  throw "La ejecución única ya fue preparada/intentada (estado=$($existing.status)); no se reenviará"
}

$leadId = [guid]::NewGuid().ToString()
$eventId = [guid]::NewGuid().ToString()
$eventTime = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$payload = [ordered]@{
  event_name = 'QualifiedLead'
  idempotency_key = "wa_crm_qualified:$leadId"
  event_id = $eventId
  event_time = $eventTime
  action_source = 'business_messaging'
  messaging_channel = 'whatsapp'
  delivery_lane = 'test'
  ads_consent = $true
  lead_id = $leadId
  tenant_id = 'a1b2c3d4-0001-4000-8000-000000000001'
  project_id = 'b1b2c3d4-0001-4000-8000-000000000001'
  contact_id = "meta-test-$($eventId.Substring(0,8))"
  ctwa_clid = $envMap.META_WA_BM_TEST_CTWA_CLID
  whatsapp_business_account_id = $envMap.META_WABA_ID
  messaging_dataset_id = $envMap.META_MESSAGING_DATASET_ID
  temperature = 'tibio'
  evidence_labels = @('meta_test_event_authorized')
  qualification_source = 'crm_persisted_evaluation'
}
$state = [ordered]@{
  status = 'attempting'
  prepared_at = [DateTimeOffset]::UtcNow.ToString('o')
  event_id = $eventId
  event_time = $eventTime
  idempotency_key = $payload.idempotency_key
}
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8

try {
  $accepted = Invoke-RestMethod -Method Post -Uri "$base/v1/events" -Headers $headers -ContentType 'application/json' -Body ($payload | ConvertTo-Json -Depth 6 -Compress) -TimeoutSec 15
  $state.status = 'backend_accepted'
  $state.backend_delivery = $accepted.delivery
  $state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
} catch {
  $state.status = 'transport_uncertain_or_rejected'
  $state.error = $_.Exception.Message
  $state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
  throw 'El POST único falló o quedó incierto; el script no lo reintentará'
}

$outcome = $null
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 1
  $outcome = Invoke-RestMethod -Method Get -Uri "$base/v1/events/$eventId" -Headers $headers -TimeoutSec 10
  if ($outcome.delivery_outcome -in @('meta_accepted','meta_rejected')) { break }
}
$state.status = [string]$outcome.delivery_outcome
$state.meta_http_status = $outcome.meta_response.http_status
$state.events_received = $outcome.meta_response.events_received
$state.fbtrace_present = -not [string]::IsNullOrWhiteSpace([string]$outcome.meta_response.fbtrace_id)
$state.completed_at = [DateTimeOffset]::UtcNow.ToString('o')
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8

[ordered]@{
  event_id = $eventId
  delivery_outcome = $state.status
  meta_http_status = $state.meta_http_status
  events_received = $state.events_received
  fbtrace_present = $state.fbtrace_present
} | ConvertTo-Json
