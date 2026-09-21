#!/usr/bin/env bash
# Despliegue diagnóstico WA webhook en Droplet.
# Ruta: /opt/lavilet-meta-capi  ·  Compose project: lavilet-capi
# No cambia suscripciones Graph ni secretos. No activa delivery WA.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/lavilet-meta-capi}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-lavilet-capi}"
SHA_EXPECTED="${SHA_EXPECTED:-}"

cd "$APP_DIR"
git fetch origin
git checkout main
git pull --ff-only origin main
if [[ -n "$SHA_EXPECTED" ]]; then
  test "$(git rev-parse HEAD)" = "$SHA_EXPECTED"
fi

# Presencia (sin imprimir valores)
python3 - <<'PY'
import os
from pathlib import Path
env = {}
for line in Path(".env").read_text(encoding="utf-8", errors="replace").splitlines():
    line=line.strip()
    if not line or line.startswith("#") or "=" not in line: continue
    k,v=line.split("=",1)
    env[k]=v.strip().strip('"').strip("'")
need = [
  "META_WA_APP_SECRET","META_WA_VERIFY_TOKEN","META_WABA_ID","META_WA_PHONE_NUMBER_ID",
  "META_WA_CLOUD_WEBHOOK_CHALLENGE_ENABLED","META_WA_CLOUD_WEBHOOK_RECEIVE_ENABLED",
  "META_WA_LEAD_SUBMITTED_DELIVERY_ENABLED",
]
print({k: bool(env.get(k)) for k in need})
assert env.get("META_WA_CLOUD_WEBHOOK_RECEIVE_ENABLED","").lower() in ("1","true","yes")
assert env.get("META_WA_LEAD_SUBMITTED_DELIVERY_ENABLED","false").lower() in ("0","false","no","")
print("flags_ok")
PY

docker compose -p "$COMPOSE_PROJECT" up -d --build
docker compose -p "$COMPOSE_PROJECT" ps
curl -sS http://127.0.0.1:3010/api/health | python3 -c '
import sys,json
j=json.load(sys.stdin)
w=j.get("wa_cloud_webhook") or {}
print(json.dumps({
  "ok": j.get("ok"),
  "wa_cloud_webhook": {
    "challenge_enabled": w.get("challenge_enabled"),
    "receive_enabled": w.get("receive_enabled"),
    "app_secret_configured": w.get("app_secret_configured"),
    "app_secret_env": w.get("app_secret_env"),
    "receipt_counts": w.get("receipt_counts"),
    "reject_counts": w.get("reject_counts"),
    "last_reject": w.get("last_reject"),
  }
}, indent=2))
'

echo "Listo. Tras un POST de Meta, revisar:"
echo "  docker compose -p $COMPOSE_PROJECT logs --since 5m | grep wa_cloud_webhook"
echo "  curl -sS http://127.0.0.1:3010/api/health | jq '.wa_cloud_webhook | {reject_counts,last_reject,receipt_counts}'"
