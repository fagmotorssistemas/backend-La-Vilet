#!/usr/bin/env bash
# Ejecutar EN el Droplet (ssh root@138.197.35.10).
# Ventana del mensaje prueba Ecuador 15:18–15:19 → UTC 20:17–20:22 del 2026-09-21.
# No imprime secretos, cuerpos de webhook ni texto de mensajes.
set -euo pipefail

FROM_UTC="${FROM_UTC:-21/Sep/2026:20:17:00}"
TO_UTC="${TO_UTC:-21/Sep/2026:20:22:59}"
NEST_SINCE="${NEST_SINCE:-2026-09-21T20:17:00}"
NEST_UNTIL="${NEST_UNTIL:-2026-09-21T20:22:59}"
APP_DIR="${APP_DIR:-/root/lavilet-meta-capi}"
APP_ID="${APP_ID:-1576506134490618}"
WABA="${WABA:-1410020224338488}"
APP_KOMMO="${APP_KOMMO:-1022173854571346}"
API="${API:-https://graph.facebook.com/v21.0}"

echo "=== 1) Nginx: POST /api/whatsapp/webhook ${FROM_UTC} .. ${TO_UTC} UTC ==="
NGINX_HITS=0
for f in /var/log/nginx/access.log /var/log/nginx/access.log.1 /var/log/nginx/capi*access*.log; do
  if [[ -f "$f" ]]; then
    echo "-- file: $f"
    # Solo método, path, status, time (sin query secrets ni body)
    awk -v from="$FROM_UTC" -v to="$TO_UTC" '
      $0 ~ /POST/ && $0 ~ /\/api\/whatsapp\/webhook/ {
        # common/combined: time often in [$4] like [21/Sep/2026:20:19:03 +0000]
        t=$4
        gsub(/^\[/,"",t)
        if (t >= from && t <= to) {
          # print time, request, status
          print t, $6, $7, $9
        }
      }
    ' "$f" | tee /tmp/wa_nginx_hits.txt || true
    c=$(wc -l < /tmp/wa_nginx_hits.txt 2>/dev/null || echo 0)
    NGINX_HITS=$((NGINX_HITS + c))
  fi
done
echo "nginx_post_hits=${NGINX_HITS}"

echo
echo "=== 2) Nest container logs (reasons only, no payloads) ${NEST_SINCE}..${NEST_UNTIL} ==="
CONTAINER="$(docker ps --format '{{.Names}}' | grep -E 'lavilet|meta-capi|capi' | head -1 || true)"
if [[ -z "${CONTAINER}" ]]; then
  echo "container=NOT_FOUND"
  docker ps --format '{{.Names}} {{.Image}} {{.Status}}'
else
  echo "container=${CONTAINER}"
  # Filtrar por ventana si el log trae ISO; si no, volcar y grep razones conocidas
  docker logs --since "$NEST_SINCE" --until "$NEST_UNTIL" "$CONTAINER" 2>&1 \
    | grep -E 'wa_cloud_|signature_|raw_body|receive_disabled|waba_|phone_number|HttpException|Unauthorized|whatsapp/webhook|ERROR|WARN' \
    | grep -viE 'ctwa_clid|Bearer |secret|token=|verify_token|app_secret|password' \
    | sed 's/\(clid["=: ]\+\)[^" ,}]*/\1***/Ig' \
    || true
fi

echo
echo "=== 3) Health receipt_counts (no secrets) ==="
curl -sS http://127.0.0.1:3010/api/health | python3 -c '
import sys,json
j=json.load(sys.stdin)
w=j.get("wa_cloud_webhook") or {}
print(json.dumps({
  "ok": j.get("ok"),
  "challenge_enabled": w.get("challenge_enabled"),
  "receive_enabled": w.get("receive_enabled"),
  "verify_token_configured": w.get("verify_token_configured"),
  "app_secret_configured": w.get("app_secret_configured"),
  "waba_id_configured": w.get("waba_id_configured"),
  "phone_number_id_configured": w.get("phone_number_id_configured"),
  "receipt_counts": w.get("receipt_counts"),
}, indent=2))
'

echo
echo "=== 4) Env presence (booleans only) + WABA dual subscribe ==="
cd "$APP_DIR"
set -a
# shellcheck disable=SC1091
source .env
set +a
python3 - <<'PY'
import os, json
keys = [
  "META_WA_APP_SECRET","META_WA_VERIFY_TOKEN","META_WABA_ID","META_WA_PHONE_NUMBER_ID",
  "META_WA_CLOUD_WEBHOOK_CHALLENGE_ENABLED","META_WA_CLOUD_WEBHOOK_RECEIVE_ENABLED",
  "META_WA_LEAD_SUBMITTED_DELIVERY_ENABLED",
]
print(json.dumps({k: bool(str(os.environ.get(k,"")).strip()) for k in keys}, indent=2))
print("flags:", {
  "challenge": os.environ.get("META_WA_CLOUD_WEBHOOK_CHALLENGE_ENABLED"),
  "receive": os.environ.get("META_WA_CLOUD_WEBHOOK_RECEIVE_ENABLED"),
  "wa_delivery": os.environ.get("META_WA_LEAD_SUBMITTED_DELIVERY_ENABLED"),
})
PY

TOKEN="${META_WA_READONLY_TOKEN:-${META_CAPI_ACCESS_TOKEN:-${META_WA_CAPI_ACCESS_TOKEN:-}}}"
SECRET="${META_WA_APP_SECRET:-}"
if [[ -z "$TOKEN" ]]; then
  echo "graph_token=MISSING (skip Graph checks)"
else
  echo "=== 5) WABA subscribed_apps (must include La Vilet + Kommo) ==="
  curl -sS -H "Authorization: Bearer ${TOKEN}" "${API}/${WABA}/subscribed_apps" \
    | python3 -c '
import sys,json
j=json.load(sys.stdin)
apps=[{"id":str((r.get("whatsapp_business_api_data") or r).get("id") or ""),
       "name":(r.get("whatsapp_business_api_data") or r).get("name")}
      for r in (j.get("data") or [])]
ids={a["id"] for a in apps}
print(json.dumps({
  "apps": apps,
  "has_lavilet": "1576506134490618" in ids,
  "has_kommo": "1022173854571346" in ids,
}, indent=2))
'
  if [[ -n "$SECRET" ]]; then
    echo "=== 6) App subscriptions (callback + field messages) via appsecret_proof ==="
    TOKEN_FOR_PROOF="$TOKEN" SECRET_FOR_PROOF="$SECRET" APP_ID="$APP_ID" API="$API" python3 - <<'PY'
import os, json, hmac, hashlib, urllib.request
from urllib.parse import urlparse
tok = os.environ["TOKEN_FOR_PROOF"]
sec = os.environ["SECRET_FOR_PROOF"]
proof = hmac.new(sec.encode(), tok.encode(), hashlib.sha256).hexdigest()
app = os.environ["APP_ID"]
api = os.environ["API"]
url = f"{api}/{app}/subscriptions?appsecret_proof={proof}"
req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}"})
with urllib.request.urlopen(req) as res:
    j = json.load(res)
out = []
for d in j.get("data") or []:
    cb = d.get("callback_url") or ""
    p = urlparse(cb)
    fields = []
    for f in d.get("fields") or []:
        fields.append(f if isinstance(f, str) else f.get("name"))
    out.append({
        "object": d.get("object"),
        "active": d.get("active"),
        "host": p.hostname,
        "path": p.path,
        "fields": fields,
        "has_messages": "messages" in fields,
        "matches_nest": p.hostname == "capi.lavilett.com" and p.path == "/api/whatsapp/webhook",
    })
print(json.dumps(out, indent=2))
PY
  else
    echo "app_secret=MISSING → cannot list /{app}/subscriptions (needs Application Secret)"
  fi
fi

echo
echo "=== Interpretación rápida ==="
echo "- nginx_post_hits=0 → Meta no entregó POST a Nest (o log rotado / otra ruta de access log)."
echo "- nginx 401 + Nest signature_* → llegó y falló firma ANTES de persistir (receipt_counts vacío es coherente)."
echo "- nginx 403 + waba_/phone_ → llegó firmado; filtro WABA/phone antes de persistir."
echo "- nginx 200 + receipt vacío → posible solo statuses[] (sin messages[]); no es el inbound de texto."
echo "- nginx 200 + Nest wa_cloud_message_receipt → llegó y persistió (revisar link_status)."
echo "- Conservar Kommo: has_kommo debe seguir true; no desuscribir."
