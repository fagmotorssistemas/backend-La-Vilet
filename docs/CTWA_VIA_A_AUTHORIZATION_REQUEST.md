# Autorización solicitada — vía A (co-suscripción CTWA)

**No ejecutar hasta autorización explícita.** Código Nest preparado y probado en local. Sin deploy ni POST remoto aún.

## Resultados de pruebas locales

```text
npx jest --testPathPatterns=whatsapp --forceExit
Test Suites: 4 passed
Tests:       17 passed
```

Cobertura:

| Caso | Resultado |
| --- | --- |
| Firma válida / inválida / body alterado | OK |
| GET hub.challenge | OK |
| RECEIVE=false → **503** `receive_disabled` (no 200 silencioso) | OK |
| Idempotencia `wamid` | OK |
| WABA incorrecta → 403 | OK |
| Sin referral → `seen_no_referral` (no inventa CTWA) | OK |
| Lead único → `linked` + `lv_app_preserve_ctwa` | OK |
| Leads ambiguos → `pending_ambiguous` | OK |
| Meta antes que Kommo → `pending_link` → reconcile | OK |

## Flags (orden correcto)

| Flag | Antes de suscribir | Tras deploy + verify | Con tráfico real |
| --- | --- | --- | --- |
| `META_WA_CLOUD_WEBHOOK_CHALLENGE_ENABLED` | `true` | `true` | `true` |
| `META_WA_CLOUD_WEBHOOK_RECEIVE_ENABLED` | `false` | `false` hasta verify OK | `true` |
| `META_WA_LEAD_SUBMITTED_DELIVERY_ENABLED` | `false` | `false` | `false` |

Callback: `https://capi.lavilett.com/api/whatsapp/webhook`

## Evidencia documental de coexistencia

Meta documenta múltiples apps en `subscribed_apps` y que cada una recibe webhooks en **su** callback del App Dashboard (sin override):

- [Managing webhooks](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/manage-webhooks) — sample response con **dos** apps.
- [Subscribed Apps API](https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/subscribed_apps/)
- Override [redirige](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/override/) el callback de **una** app → **no usar** (rompería Kommo).

Estado actual WABA `1410020224338488` (solo lectura): **solo** Kommo `1022173854571346`.

## Operaciones exactas (tras autorización)

### 0) Preflight credencial app La Vilet (lectura)

```bash
node scripts/meta-wa-cosubscribe-preflight.mjs
# Esperado: app_matches_lavilet=true, has_kommo=true, has_lavilet=false, ready_for_cosubscribe_post=true
```

App que suscribe: **1576506134490618** (token system user de esa app). No usar token de Kommo.

### 1) Deploy en servicio existente (Droplet Compose `lavilet-capi`)

Sin crear app nueva. En `.env` del host:

```bash
META_WA_CLOUD_WEBHOOK_CHALLENGE_ENABLED=true
META_WA_CLOUD_WEBHOOK_RECEIVE_ENABLED=false
META_WA_VERIFY_TOKEN=<verify>
META_WA_APP_SECRET=<app_secret app 1576506134490618>
META_WABA_ID=1410020224338488
META_WA_PHONE_NUMBER_ID=1372191202637500
META_WA_LEAD_SUBMITTED_DELIVERY_ENABLED=false
```

```bash
cd "$APP_DIR"
git pull --ff-only origin main
docker compose up -d --build
curl -sS https://capi.lavilett.com/api/health | jq '.wa_cloud_webhook'
# challenge_enabled=true receive_enabled=false
```

### 2) Meta App Dashboard (app 1576506134490618)

- WhatsApp → Configuration → Webhook URL = `https://capi.lavilett.com/api/whatsapp/webhook`
- Verify Token = mismo `META_WA_VERIFY_TOKEN`
- Suscribir campo **`messages`**
- “Verify and Save” (GET challenge; RECEIVE sigue false)

### 3) Co-suscripción (POST) — no elimina Kommo

```bash
curl -sS -X POST "https://graph.facebook.com/v21.0/1410020224338488/subscribed_apps" \
  -H "Authorization: Bearer $META_WA_SUBSCRIBE_TOKEN"
```

### 4) Verificación por IDs (no basta count≥2)

```bash
curl -sS "https://graph.facebook.com/v21.0/1410020224338488/subscribed_apps" \
  -H "Authorization: Bearer $META_WA_SUBSCRIBE_TOKEN"
# Debe incluir id=1022173854571346 (Kommo) Y id=1576506134490618 (La Vilet)
```

### 5) Encender recepción (sin CAPI)

```bash
# En .env + recreate del mismo servicio
META_WA_CLOUD_WEBHOOK_RECEIVE_ENABLED=true
docker compose up -d
```

Comprobar con mensaje **real** de la campaña (no TestEvent): health `receipt_counts`; CRM Kommo sigue recibiendo; bot sigue restringido; delivery WA OFF.

### 6) Reversión (solo La Vilet)

Meta `DELETE /{WABA}/subscribed_apps` desuscribe **la app del access token** usado (no un query param de app id). Por eso el DELETE debe hacerse **solo** con token de la app La Vilet `1576506134490618`:

```bash
curl -sS -X DELETE "https://graph.facebook.com/v21.0/1410020224338488/subscribed_apps" \
  -H "Authorization: Bearer $META_WA_SUBSCRIBE_TOKEN"   # app La Vilet
curl -sS "https://graph.facebook.com/v21.0/1410020224338488/subscribed_apps" \
  -H "Authorization: Bearer $META_WA_SUBSCRIBE_TOKEN"
# Esperado: Kommo 1022173854571346 presente; La Vilet 1576506134490618 ausente
```

Apagar flags Nest: `RECEIVE=false`, opcional `CHALLENGE=false`.

## Fuera de alcance de esta autorización

- Sustituir/eliminar suscripción Kommo
- Override de callback
- Activar `META_WA_LEAD_SUBMITTED_DELIVERY_ENABLED`
- Encender bot / responder chats
- Generar tráfico artificial / TestEvent como prueba de recorrido
