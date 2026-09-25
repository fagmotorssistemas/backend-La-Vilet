# Contrato conciliado CAPI La Vilet

Fecha: 2026-09-24. Fuentes contrastadas: implementación frontend actual, `META_CAPI_FRONTEND_CONTRACT.md`, `META_EVENTS_MATRIX.md`, `META_NEST_BACKEND_CONTRACT.md` y backend Nest. Este documento es el contrato de integración para la activación coordinada.

## Incompatibilidades encontradas

1. El ejemplo Purchase de `META_NEST_BACKEND_CONTRACT.md` indicaba `action_source=website` y omitía las fechas. La implementación frontend actual ya usa `system_generated` y guarda `registered_at` + `sale_at`. Este contrato adopta la implementación actual: Purchase es un cierre CRM, no una visita web.
2. Documentos anteriores describían Purchase como preparado o deshabilitado. El backend productivo observado tenía el flag activo, pero su commit sigue sin verificar. La activación debe volver a empezar con entrega deshabilitada y seguir el orden final de este documento.
3. El frontend puede usar la hora actual como fallback al construir fechas de venta. El contrato final prohíbe inventarlas: deben proceder de `unit_sales_closings.created_at` y `unit_sales_closings.sale_at`. El backend conserva el evento y lo retiene si falta cualquiera.
4. `sent`, `forwarded` y una respuesta HTTP 2xx interna no equivalen a aceptación Meta. Los estados finales se definen abajo.

## Matriz única

| Hecho real                                | Evento                         | source/canal                  | Clave idempotente              | Requisitos específicos                                                                           | Pixel                                                 |
| ----------------------------------------- | ------------------------------ | ----------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Showroom 360 listo                        | ViewContent / showroom_general | website                       | `view:showroom:{visitor_key}`  | visitor_key; URL/atribución disponibles                                                          | Mismo event_name + event_id para el mismo hecho       |
| Apertura de ficha de unidad               | ViewContent / detalle_unidad   | website                       | `view:{visitor_key}:{unit_id}` | unit_id y visitor_key; backend asegura `content_type=home_listing` + `content_ids=[unit_id]` | Mismo event_name + event_id                           |
| Solicitud real de información             | Lead / solicitud               | website                       | `lead:{lead_id}`               | lead_id; solo flujo info_request                                                                 | Mismo event_name + event_id si Pixel informa el hecho |
| Favorito guardado                         | AddToWishlist / favorito       | website                       | `wishlist:{lead_id}:{unit_id}` | lead_id y unit_id; backend asegura `content_type=home_listing` + `content_ids=[unit_id]`         | Mismo event_name + event_id                           |
| Cita web confirmada                       | Schedule / cita                | website                       | `schedule:{appointment_id}`    | appointment existente, confirmada por cliente; Schedule BM no existe                             | Mismo event_name + event_id                           |
| Interés comercial CTWA elegible           | LeadSubmitted                  | business_messaging / whatsapp | `wa_lead_submitted:{lead_id}`  | lead_id, contact_id, CTWA, WABA, dataset de mensajería y scopes coherentes                       | No Pixel web                                          |
| Primera calificación CRM tibia o caliente | QualifiedLead                  | business_messaging / whatsapp | `wa_crm_qualified:{lead_id}`   | evaluación/transición persistidas; temperatura, motivos, CTWA, WABA, dataset y scopes coherentes | No Pixel web                                          |
| Venta real confirmada                     | Purchase / compra              | system_generated / CRM        | `purchase:{sale_id}`           | sale_id, lead_id, unit_id, value, currency, registered_at, sale_at; backend asegura `content_type=home_listing` + `content_ids=[unit_id]` | No se inventa evento web                              |

PageView continúa solo en Pixel. Search, reserva y la clasificación/temperatura comercial están fuera de esta matriz. Purchase nunca representa temperatura, interés, cita, reserva, anticipo o cuota.

## Sobre común productor → Nest

El productor debe enviar siempre:

- `event_name`, `idempotency_key` no vacía, `event_id` UUID v4 estable, `event_time` Unix segundos del hecho original, `action_source`, `ads_consent` y `delivery_lane` (`test` o `live`).
- El reintento conserva exactamente event_id, event_time, clave y carril.
- Una clave reutilizada con otro evento, ID, fecha, carril o dataset devuelve `409 idempotency_key_conflict`.
- `delivery_lane=test` y `live` comparten esquema, pero el worker solo reclama el carril de su modo. Test requiere test code; live lo prohíbe.
- El backend aún genera event_id/event_time para clientes legacy que los omitan. Esta tolerancia no forma parte del contrato del frontend nuevo.

Campos comunes opcionales según disponibilidad: phone/email/name/city/country/external_id, visitor_key/lead_id, fbp/fbc/fbclid, IP/UA y URL web. Fuera de website se eliminan URL, cookies web, IP y UA.

Purchase debe llevar `action_source=system_generated`, `sale_id`, `lead_id`, `unit_id`, `value>0`, `currency` de tres letras en mayúsculas, `registered_at` ISO y `sale_at` ISO. `event_time` debe ser `floor(epoch(sale_at))`; si falta o difiere, queda retenido con `purchase_event_time_required` o `purchase_event_time_mismatch`. El backend valida venta y anulación antes de Graph. Si falta una fecha, conserva la fila pending y expone `purchase_registered_at_required` o `purchase_sale_at_required`; no usa created_at local como sustituto.

LeadSubmitted y QualifiedLead deben llevar simultáneamente `action_source=business_messaging`, `messaging_channel=whatsapp`, `ctwa_clid`, `whatsapp_business_account_id` y `messaging_dataset_id`. WABA y dataset deben coincidir con `META_WABA_ID` y `META_MESSAGING_DATASET_ID` del servidor; si la configuración falta o no coincide, se rechaza antes de persistir. El dataset de mensajería debe diferir del WABA y del dataset web. Cada carril exige su token propio (`META_CAPI_ACCESS_TOKEN` web, `META_WA_CAPI_ACCESS_TOKEN` mensajería); la ausencia conserva el evento pendiente y no intenta Graph. QualifiedLead añade `temperature`, `evidence_labels`, `qualification_source=crm_persisted_evaluation` y los scopes CRM; esos campos quedan internos.

## Consentimiento y controles

No cambia la política acordada:

- La recepción directa exige `ads_consent=true`.
- Revocación explícita (`false`) cancela.
- LeadSubmitted permite consentimiento ausente/null si el lead existe y los scopes requeridos son coherentes; fallo de consulta, lead/contact ausente o discrepancia de tenant/project retienen el evento.
- Los demás eventos cancelan ante false; esta fase no endurece la política histórica de consulta fallida.
- Los flags Schedule, LeadSubmitted, QualifiedLead y Purchase son independientes y deshabilitables. Desactivarlos conserva pending.
- No hay una exclusión backend nueva de internos/pruebas. El productor conserva sus controles actuales; el carril test no debe mezclarse con live.

## Estados y salida pública

POST 202 significa aceptación del backend para persistir, no de Meta. Conserva los campos existentes y añade `delivery_outcome`.

GET `/api/v1/events/:eventId` conserva `status`, `acceptance_tier`, `api_accepted` y `meta_response`, y añade:

| delivery_outcome | Significado                                             |
| ---------------- | ------------------------------------------------------- |
| backend_accepted | Persistido/pendiente/held; Meta aún no acreditado       |
| transport_failed | No hubo respuesta Graph verificable; puede reintentarse |
| meta_rejected    | Graph respondió con rechazo                             |
| meta_unverified  | HTTP OK sin evidencia suficiente (`events_received`)    |
| meta_accepted    | Graph aceptó el evento con conteo coherente             |
| cancelled        | Cancelado antes de Meta                                 |

`acceptance_tier=api_rejected` solo corresponde a `meta_rejected`. Transporte y respuesta no verificable devuelven `insufficient_evidence`. `api_accepted=true` solo corresponde a `meta_accepted`. Events Manager y atribución siguen siendo capas distintas.

## Persistencia y sincronización

- SQLite conserva el payload Graph, event_id, event_time, carril e idempotencia. Reinicio recupera processing sin regenerarlos.
- Al aceptar Meta, el cambio a `sent` y la creación del trabajo de sincronización Supabase ocurren en una transacción SQLite.
- La sincronización usa una cola durable y reintentos con backoff aun si después se desactiva el envío Graph.
- Cada resultado usa un UUID determinista derivado de event_id + etapa y se escribe con upsert en `meta_capi_conversion_log`. Un timeout después de commit no duplica el registro.
- Un fallo de Supabase nunca devuelve el evento `sent` a la cola Graph, por lo que no provoca otro envío.
- Health expone conteos de la cola de resultados sin contenido sensible.

## Orden de activación

1. Verificar el commit/digest desplegado; hoy continúa pendiente.
2. Desplegar backend con `META_MODE=disabled` y flags Schedule/LeadSubmitted/Purchase desactivados. Confirmar migración SQLite local, volumen `/data`, health y cola de resultados.
3. Confirmar que el frontend emite el sobre de este contrato, en especial Purchase con fechas de la venta sin fallback y LeadSubmitted con los cinco campos BM.
4. Activar `META_MODE=test` con test code. Habilitar y probar cada familia con fixtures nuevos, nunca históricos: web; Schedule; LeadSubmitted; Purchase.
5. Verificar por GET los niveles backend_accepted, transport_failed/meta_rejected cuando se simulen localmente y meta_accepted en Test Events. Confirmar además que la bitácora Supabase recibe el resultado sin duplicados.
6. Vaciar o resolver holds de pruebas de forma explícita; no promover históricos en masa.
7. Quitar test code, cambiar a `META_MODE=live` y habilitar flags uno por uno. Purchase se habilita al final, con corte nuevo y ambas fechas reales posteriores al corte.
8. Vigilar `outbox.counts`, `result_sync_counts`, errores y GET por event_id. Rollback: desactivar el flag del evento o META_MODE; las filas permanecen durables.
