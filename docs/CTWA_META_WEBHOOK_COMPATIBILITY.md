# Compatibilidad CTWA: recepción `ctwa_clid` en Nest

**Estado (2026-09-21):** inspección solo lectura. **Sin** deploy, **sin** cambios a suscripciones remotas, **sin** activar delivery WA.

## Contexto operativo (campaña en uso)

- Hay campaña **activa** con interés comercial real: mensajes de clientes llegan a WhatsApp → Kommo → CRM.
- Esos contactos **sí interesan** al negocio aunque el anuncio mencione una propiedad externa a La Vilet.
- **No** tratar toda la campaña ni sus leads como “pruebas”; solo mensajes explícitamente marcados como prueba técnica.
- El bot de La Vilet debe permanecer restringido (respondería sobre otro proyecto).
- Conversiones WA **apagadas** mientras se prepara la atribución.
- Tráfico nuevo sirve como evidencia de solo lectura; no generar tráfico artificial.
- Campaña real **≠** presencia de `ctwa_clid` ni consentimiento ads verificable: ambos se comprueban, nunca se inventan.

## Hallazgo principal (evidencia Graph)

WABA `1410020224338488` — `GET /{WABA}/subscribed_apps` (token system user, app `1576506134490618`):

| App | ID | Rol |
| --- | --- | --- |
| **Kommo** | `1022173854571346` | **Única** app suscrita a webhooks del WABA |

Teléfono WABA: `phone_id=1372191202637500`, display `***5286`, nombre verificado `La Vilet`. Sin override de callback visible en `webhook_configuration` con este token.

**Consecuencia:** hoy **solo Kommo** recibe el webhook Cloud API `messages` (donde Meta documenta `messages[].referral.ctwa_clid`). Nest (`capi.lavilett.com`) **no** está suscrito y **no** tiene endpoint webhook WA.

Script de inspección (local, no imprime tokens):

```bash
node scripts/meta-wa-subscribed-apps-inspect.mjs
```

## Fuentes oficiales

### Meta — origen del `ctwa_clid`

- [Conversions API for Business Messaging](https://developers.facebook.com/documentation/ads-commerce/conversions-api/business-messaging): el `ctwa_clid` sale del objeto `referral` del webhook **messages** (Cloud API) en el **primer** mensaje tras el anuncio CTWA.
- [Managing webhooks (Solution Providers)](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/manage-webhooks): una WABA puede tener **varias** apps en `subscribed_apps`; cada una recibe notificaciones en **su** callback del App Dashboard (salvo override).
- [Webhook overrides](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/override/): un override en la **misma** app **redirige** el callback (no es una copia). Usarlo sobre la app Kommo **rompería** el chat en Kommo → **prohibido**.

### Kommo — qué documentan

- [Track WhatsApp ad campaigns with UTMs](https://support.kommo.com/docs/track-whatsapp-ad-campaigns-with-utms): UTMs en la ficha del lead; **no** documentan reenvío de `referral.ctwa_clid` al webhook CRM `message[add]`.
- [Meta CAPI en Kommo](https://support.kommo.com/docs/set-up-meta-conversions-api-capi): Lead/Purchase desde pipeline Kommo → Meta; **no** es el recorrido Nest `LeadSubmitted` BM ni entrega el clid al CRM La Vilet.

### Frontend La Vilet (ya desplegado)

- Webhook Kommo → `payload.ctwaProbe` (diagnóstico seguro: `fieldsAbsent`, paths, sin PII/clid).
- Extractor + `lv_app_preserve_ctwa` listos **si** Kommo algún día reenvía el clid.
- Recepciones examinadas: **sin** referral/`ctwa_clid` (probe `fieldsAbsent`).

### Evidencia prod de solo lectura (2026-09-21, sin PII)

| Señal | Valor |
| --- | --- |
| Inbound Kommo (total / 7d / 24h) | 591 / 352 / 29 → integración **en uso** |
| `lv_whatsapp_ctwa_attribution` | **0** filas |
| Eventos con `payload.ctwa` no null | **0** |
| Eventos con `ctwaProbe` (post-deploy probe) | **6** (hoy) |
| De esos 6: `fieldsAbsent=true`, `extracted=false` | **6/6** |
| Paths referral/ctwa en probe (`pathCount>0`) | **0** |
| Outbox `LeadSubmitted` | **0** |
| Leads Kommo 14d: `meta_ads_consent` | 1 true / 0 false / 6 null |
| Consent con `meta_ads_consent_scope` / evidencia texto | **ninguno** en leads Kommo |
| Leads Kommo 14d `bot_enabled=true` | 3 (revisar que el bot siga restringido en operación) |

**Conclusión empírica:** el tráfico real **sí** llega al CRM; el webhook Kommo **sigue sin** aportar `ctwa_clid` en las recepciones instrumentadas. Consent ads WA explícito (scope/evidencia) **no** está establecido para el recorrido BM.

## Vías evaluadas

| Vía | ¿Compatible con “no romper Kommo/WA”? | ¿Comprobada en esta WABA? | Acción |
| --- | --- | --- | --- |
| A. Nest recibe webhook Meta como **2.ª app** en `subscribed_apps` | Meta lo documenta para multi-app; **no** toca el callback de Kommo | **No** — solo Kommo está suscrita; no se hizo POST | Requiere prueba remota autorizada (abajo) |
| B. Override callback de la app Kommo → Nest | **No** — roba el webhook a Kommo | N/A | Descartada |
| C. Kommo reenvía `ctwa_clid` en `message[add]` | No interrumpe WA | **No observado**; no documentado por Kommo | Seguir probe FE; preguntar a soporte Kommo |
| D. CAPI nativo Kommo (Lead/Purchase) | Paralelo, no Nest BM | Documentado por Kommo | No sustituye `LeadSubmitted` + outbox Nest |

**Bloqueo actual:** no hay fuente **comprobada** de `ctwa_clid` hacia Nest ni hacia el CRM. Implementar y “activar” un webhook Nest **antes** de verificar la co-suscripción sería una solución basada en supuesto.

## Configuración remota exacta que falta (si se autoriza vía A)

Orden **después** de autorización explícita (este doc no la ejecuta):

1. Meta App Dashboard (app propia La Vilet, hoy el system user usa `app_id=1576506134490618`): product **WhatsApp** + Webhooks → callback `https://capi.lavilett.com/api/whatsapp/webhook` (ruta a implementar solo tras A OK) + `verify_token` + suscripción campo **`messages`**.
2. Vars Nest (propuestas, default OFF): `META_WA_CLOUD_WEBHOOK_ENABLED=false`, `META_WA_APP_SECRET`, `META_WA_VERIFY_TOKEN`, `META_WABA_ID`, `META_WA_PHONE_NUMBER_ID`, `META_WA_CLOUD_WEBHOOK_PERSIST_ENABLED=false`.
3. Prueba de co-suscripción (**sin** borrar Kommo):
   ```bash
   # SOLO con autorización; no ejecutar en diagnóstico
   POST /v21.0/{WABA_ID}/subscribed_apps
   GET  /v21.0/{WABA_ID}/subscribed_apps
   # Esperado: Kommo + app La Vilet (count>=2)
   ```
4. Si GET no muestra ambas apps → **abortar**; no hay recepción Nest.
5. Reversión: `DELETE /{WABA_ID}/subscribed_apps` **solo** con el token de la app La Vilet (Kommo debe permanecer).

Impacto: Kommo sigue recibiendo mensajes (multi-app documentado). Nest solo **lee** referral; **no** debe reenviar el mensaje al CRM (evitar duplicar el texto que ya guarda Kommo). Persistencia: solo atribución first-touch (`lv_app_preserve_ctwa` / cola pendiente por `wa_id`/teléfono verificable) hasta correlacionar con `contact_id` Kommo.

## Vínculo a LeadSubmitted (sin activar)

Flujo ya existente (flags OFF):

```
ctwa en lv_whatsapp_ctwa_attribution
  → FE maybeRegisterWaLeadSubmitted (consent + interés)
  → meta_capi_outbox LeadSubmitted
  → Nest drain /events → Graph (META_WA_CAPI_ACCESS_TOKEN)
```

Nest **no** debe fabricar consentimiento ni enviar Graph desde el webhook Cloud. Solo alimentar la captura CTWA; el outbox BM sigue gated por `META_WA_LEAD_SUBMITTED_*`.

## Próxima prueba controlada (clid real)

Ver procedimiento completo en `docs/CTWA_VIA_A_AUTHORIZATION_REQUEST.md`.

1. Deploy Nest (servicio existente) con CHALLENGE=true / RECEIVE=false.
2. Verify webhook en App Dashboard (app La Vilet).
3. POST `subscribed_apps` → verificar IDs Kommo `1022173854571346` + La Vilet `1576506134490618`.
4. RECEIVE=true; delivery CAPI WA sigue OFF.
5. Mensaje real de la campaña → recibo / pending / linked; Kommo intacto; bot restringido.

## Qué no hacer

- No sustituir callback Kommo.
- No `META_WA_LEAD_SUBMITTED_DELIVERY_ENABLED=true`.
- No TestEvent / clid de Graph Explorer como prueba del recorrido real.
- No crear WABA/app Meta nueva “en paralelo” sin el paso de co-suscripción verificado.
