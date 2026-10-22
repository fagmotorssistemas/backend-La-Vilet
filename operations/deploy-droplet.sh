#!/usr/bin/env bash
# Despliegue seguro de lavilet-meta-capi. Ejecutar EN el droplet (root).
#
#   Fase 1 (por defecto): solo revisa y muestra qué cambiaría. No modifica nada.
#   Fase 2 (CONFIRM_DEPLOY=1): respaldo de la cola SQLite, despliegue,
#           verificación y vuelta atrás automática si el servicio no queda sano.
#
#   bash operations/deploy-droplet.sh                    # revisar
#   CONFIRM_DEPLOY=1 bash operations/deploy-droplet.sh   # desplegar
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/lavilet-meta-capi}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-lavilet-capi}"
SERVICE="${SERVICE:-lavilet-meta-capi}"
TARGET_REF="${TARGET_REF:-origin/main}"
BACKUP_DIR="${BACKUP_DIR:-/root/lavilet-capi-backups}"
HEALTH_TIMEOUT_SEC="${HEALTH_TIMEOUT_SEC:-180}"

log() { printf '\n== %s\n' "$*"; }
die() { printf '\nABORTADO: %s\n' "$*" >&2; exit 1; }
compose() { docker compose -p "$COMPOSE_PROJECT" "$@"; }

cd "$APP_DIR" || die "no existe $APP_DIR"
[ -f .env ] || die "falta $APP_DIR/.env"

env_value() { grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- | tr -d '\r' || true; }
HOST_PORT="$(env_value PORT)"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${HOST_PORT:-3010}/api/health}"

health_json() { curl -fsS --max-time 5 "$HEALTH_URL"; }

log "1. Proyecto compose y contenedor actuales"
compose ls >/dev/null 2>&1 || true
if ! docker compose ls | awk 'NR > 1 { print $1 }' | grep -qx "$COMPOSE_PROJECT"; then
  docker compose ls
  die "no hay un proyecto compose '$COMPOSE_PROJECT' en marcha (¿otro nombre? usar COMPOSE_PROJECT=...)"
fi
CID="$(compose ps -q "$SERVICE" | head -n 1)"
[ -n "$CID" ] || die "no se encontró el contenedor del servicio $SERVICE"
docker ps --filter "id=$CID" --format '{{.Names}} | {{.Status}}'

log "2. Código: versión actual y destino"
git fetch --quiet origin
if ! git diff --quiet || ! git diff --cached --quiet; then
  git status --short
  die "hay cambios locales en archivos versionados del droplet; revisarlos antes"
fi
PREV_SHA="$(git rev-parse HEAD)"
NEW_SHA="$(git rev-parse "$TARGET_REF")"
echo "actual:  $PREV_SHA ($(git log -1 --format=%cI "$PREV_SHA"), HEAD del repo del droplet)"
echo "contenedor en marcha creado: $(docker inspect -f '{{.Created}}' "$CID")"
echo "destino: $NEW_SHA ($TARGET_REF)"
if [ "$PREV_SHA" = "$NEW_SHA" ]; then
  echo "El droplet ya está en el destino."
else
  git merge-base --is-ancestor "$PREV_SHA" "$NEW_SHA" \
    || die "el destino no contiene la versión actual (no es avance directo)"
  echo "Commits que entran:"
  git log --oneline "$PREV_SHA..$NEW_SHA"
fi

log "3. Configuración que el despliegue empieza a aplicar (valores no secretos)"
for key in META_MODE META_CORE_SETUP_CONSERVATIVE META_SCHEDULE_DELIVERY_ENABLED \
  META_SCHEDULE_RECOVER_ENABLED META_SCHEDULE_RECOVER_LOOKBACK_DAYS \
  SUPABASE_HTTP_TIMEOUT_MS META_QUALIFIED_PURCHASE_DELIVERY_ENABLED \
  META_QUALIFIED_PURCHASE_VALUE META_QUALIFIED_PURCHASE_CURRENCY \
  META_SALE_DELIVERY_ENABLED META_SALE_ACTIVATED_AT \
  META_FUNNEL_EVENTS_DELIVERY_ENABLED META_SIGNAL_CASCADE_ENABLED \
  META_PURCHASE_DELIVERY_ENABLED META_PURCHASE_ACTIVATED_AT; do
  value="$(env_value "$key")"
  printf '  %-42s %s\n' "$key" "${value:-<no definido: usa el valor por defecto>}"
done
echo "  (META_PURCHASE_* ya no tienen efecto; los META_SCHEDULE_* y"
echo "   META_CORE_SETUP_CONSERVATIVE antes se ignoraban y ahora se aplican.)"

log "4. Estado del servicio antes"
health_json | python3 -c 'import sys, json
j = json.load(sys.stdin)
print("  ok:", j.get("ok"), "| mode:", j.get("mode"))
print("  outbox:", j.get("outbox", {}).get("counts"))
print("  drain last_tick_error:", j.get("supabase_drain", {}).get("last_tick_error"))' \
  || die "el servicio actual no responde en $HEALTH_URL"

if [ "${CONFIRM_DEPLOY:-0}" != "1" ]; then
  log "Fase 1 completa: no se modificó nada. Para desplegar: CONFIRM_DEPLOY=1 bash $0"
  exit 0
fi

log "5. Respaldo de la cola SQLite"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_NAME="pre-deploy-$TS.db"
compose exec -T "$SERVICE" node -e "
const Database = require('better-sqlite3');
const db = new Database(process.env.DATABASE_PATH, { readonly: true, fileMustExist: true });
db.backup('/data/$BACKUP_NAME')
  .then(() => {
    const copy = new Database('/data/$BACKUP_NAME', { readonly: true });
    const check = copy.pragma('integrity_check', { simple: true });
    const rows = copy.prepare('SELECT COUNT(*) AS c FROM outbox_events').get().c;
    console.log('respaldo', check, 'filas outbox:', rows);
    if (check !== 'ok') process.exit(2);
  })
  .catch((error) => { console.error(error.message); process.exit(1); });
" || die "no se pudo respaldar la base (no se desplegó nada)"
mkdir -p "$BACKUP_DIR"
docker cp "$CID:/data/$BACKUP_NAME" "$BACKUP_DIR/$BACKUP_NAME"
[ -s "$BACKUP_DIR/$BACKUP_NAME" ] || die "el respaldo copiado está vacío (no se desplegó nada)"
echo "respaldo: $BACKUP_DIR/$BACKUP_NAME"

rollback() {
  printf '\n!! FALLO: volviendo a %s\n' "$PREV_SHA" >&2
  git checkout --quiet --detach "$PREV_SHA"
  compose up -d --build
  for _ in $(seq 1 60); do
    if health_json >/dev/null 2>&1; then
      echo "Versión anterior restaurada y sana. Respaldo en $BACKUP_DIR/$BACKUP_NAME" >&2
      exit 1
    fi
    sleep 3
  done
  echo "La versión anterior tampoco responde: revisar 'docker compose -p $COMPOSE_PROJECT logs'" >&2
  exit 1
}
trap rollback ERR

log "6. Despliegue"
git checkout --quiet --detach "$NEW_SHA"
compose up -d --build

log "7. Verificación"
ok=0
for _ in $(seq 1 $((HEALTH_TIMEOUT_SEC / 3))); do
  if health_json 2>/dev/null | python3 -c 'import sys, json
j = json.load(sys.stdin)
# deprecated_env_present solo existe en la versión nueva.
sys.exit(0 if j.get("ok") is True and "deprecated_env_present" in j else 1)' 2>/dev/null; then
    ok=1
    break
  fi
  sleep 3
done
[ "$ok" = "1" ] || { echo "la versión nueva no quedó sana" >&2; false; }

sleep 20 # al menos un ciclo de worker y de drain
health_json | python3 -c 'import sys, json
j = json.load(sys.stdin)
w = j["outbox"]["worker"]; d = j.get("supabase_drain", {})
print("  ok:", j["ok"], "| mode:", j["mode"])
print("  outbox:", j["outbox"]["counts"])
print("  worker last_tick_at:", w.get("last_tick_at"), "error:", w.get("last_tick_error"))
print("  drain last_tick_at:", d.get("last_tick_at"), "error:", d.get("last_tick_error"))
print("  avisos de variables antiguas:", j.get("deprecated_env_present"))
sys.exit(1 if w.get("last_tick_error") or d.get("last_tick_error") else 0)' \
  || { echo "el worker o el drain reportan error" >&2; false; }

trap - ERR
# Deja el repositorio del droplet en main alineado con lo desplegado.
if [ "$NEW_SHA" = "$(git rev-parse origin/main)" ]; then
  git checkout --quiet main && git merge --quiet --ff-only "$NEW_SHA"
fi
log "Despliegue correcto: $NEW_SHA"
echo "Vuelta atrás manual si hiciera falta:"
echo "  cd $APP_DIR && git checkout --detach $PREV_SHA && docker compose -p $COMPOSE_PROJECT up -d --build"
echo "Respaldo de la cola: $BACKUP_DIR/$BACKUP_NAME"
