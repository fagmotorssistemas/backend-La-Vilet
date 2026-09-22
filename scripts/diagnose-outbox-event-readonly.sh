#!/usr/bin/env bash
# Diagnóstico SOLO LECTURA — Droplet CAPI Nest.
# No reenvía eventos ni modifica SQLite.
#
# Uso:
#   EVENT_ID=<uuid> bash scripts/diagnose-outbox-event-readonly.sh
#   bash scripts/diagnose-outbox-event-readonly.sh   # últimos 20
set -euo pipefail

ROOT="${ROOT:-/opt/lavilet-meta-capi}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-lavilet-capi}"
SERVICE="${SERVICE:-lavilet-meta-capi}"
EVENT_ID="${EVENT_ID:-}"

cd "$ROOT"
echo "== compose ps =="
docker compose -p "$COMPOSE_PROJECT" ps

CID="$(docker compose -p "$COMPOSE_PROJECT" ps -q "$SERVICE" | head -n1)"
if [[ -z "$CID" ]]; then
  echo "ERROR: contenedor no encontrado ($SERVICE en -p $COMPOSE_PROJECT)" >&2
  exit 1
fi
echo "CID=$CID"

echo "== health =="
curl -sS "http://127.0.0.1:3010/api/health" | head -c 2000 || true
echo

if [[ -n "$EVENT_ID" ]]; then
  echo "== lookup event_id=$EVENT_ID =="
  docker exec -i "$CID" node -e '
const Database=require("better-sqlite3");
const id=process.argv[1];
const db=new Database("/data/lavilet-meta-capi.db",{readonly:true,fileMustExist:true});
const rows=db.prepare(`
  SELECT id,event_id,event_name,status,attempt_count,last_error,delivery_lane,dataset_id,
         sent_at,updated_at,created_at,meta_response_redacted
  FROM outbox_events WHERE event_id=? ORDER BY id DESC`).all(id);
const counts=db.prepare("SELECT status,COUNT(*) c FROM outbox_events GROUP BY status").all();
console.log(JSON.stringify({event_id:id,counts,rows:rows.map(r=>({
  ...r,
  meta_response: r.meta_response_redacted?JSON.parse(r.meta_response_redacted):null,
  meta_response_redacted:undefined
}))},null,2));
db.close();
' "$EVENT_ID"
else
  echo "== últimos 20 (sin graph_payload) =="
  docker exec -i "$CID" node -e '
const Database=require("better-sqlite3");
const db=new Database("/data/lavilet-meta-capi.db",{readonly:true,fileMustExist:true});
console.log(JSON.stringify(
  db.prepare(`SELECT event_id,event_name,status,attempt_count,delivery_lane,sent_at,last_error,meta_response_redacted
              FROM outbox_events ORDER BY id DESC LIMIT 20`).all().map(r=>({
    ...r,
    meta_response: r.meta_response_redacted?JSON.parse(r.meta_response_redacted):null,
    meta_response_redacted:undefined
  })),null,2));
db.close();
'
fi

echo
echo "Nota: status=sent + meta_response.events_received>=1 ⇒ api_accepted."
echo "No reenviar. Correlacionar event_id con meta_capi_conversion_log.stage=meta_accepted en CRM."
