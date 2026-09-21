#!/usr/bin/env bash
# Ejecutar EN el Droplet del servicio existente lavilet-capi / lavilet-meta-capi.
# No sustituye Kommo. No activa delivery CAPI WA.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/lavilet-meta-capi}"
SHA_EXPECTED="${SHA_EXPECTED:-$(git rev-parse origin/main)}"
CALLBACK="https://capi.lavilett.com/api/whatsapp/webhook"
WABA="1410020224338488"
PHONE_ID="1372191202637500"
APP_LAVILET="1576506134490618"
APP_KOMMO="1022173854571346"

cd "$APP_DIR"
git fetch origin
git checkout main
git pull --ff-only origin main
test "$(git rev-parse HEAD)" = "$SHA_EXPECTED"

# Asegurar vars (no imprimir valores). Crear VERIFY_TOKEN si falta.
if ! grep -q '^META_WA_VERIFY_TOKEN=.\+' .env 2>/dev/null; then
  TOKEN="$(openssl rand -hex 24)"
  echo "META_WA_VERIFY_TOKEN=${TOKEN}" >> .env
  echo "GENERATED META_WA_VERIFY_TOKEN (copy to Meta App Dashboard; not printed again)"
fi

# Requiere META_WA_APP_SECRET ya en .env (App Dashboard → Settings → Basic → App Secret)
grep -q '^META_WA_APP_SECRET=.\+' .env

# Flags + IDs (upsert simple)
upsert() {
  local k="$1" v="$2"
  if grep -q "^${k}=" .env; then
    sed -i "s|^${k}=.*|${k}=${v}|" .env
  else
    echo "${k}=${v}" >> .env
  fi
}

upsert META_WABA_ID "$WABA"
upsert META_WA_PHONE_NUMBER_ID "$PHONE_ID"
upsert META_WA_CLOUD_WEBHOOK_CHALLENGE_ENABLED true
upsert META_WA_CLOUD_WEBHOOK_RECEIVE_ENABLED true
upsert META_WA_LEAD_SUBMITTED_DELIVERY_ENABLED false

docker compose up -d --build
docker compose ps
curl -sS http://127.0.0.1:3010/api/health | python3 -c "import sys,json; j=json.load(sys.stdin); print(json.dumps({'ok':j.get('ok'),'wa_cloud_webhook':j.get('wa_cloud_webhook')},indent=2))"

echo "NEXT: In Meta App ${APP_LAVILET} set webhook ${CALLBACK} + same VERIFY_TOKEN + field messages → Verify and Save"
echo "THEN: POST subscribed_apps with La Vilet token; GET must show ${APP_KOMMO} and ${APP_LAVILET}"
