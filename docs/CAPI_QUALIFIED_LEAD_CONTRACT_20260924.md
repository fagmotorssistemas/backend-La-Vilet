# Contrato de calificación comercial CAPI — 2026-09-24

## Matriz conciliada

| Hecho                                              | Evento Meta     | Canal admitido aquí                                                                  | Identidad                                                                |
| -------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Primera transición del lead a `tibio` o `caliente` | `QualifiedLead` | `business_messaging` / `whatsapp`, con CTWA, WABA y dataset de mensajería coherentes | `event_id` UUID v4 persistido; idempotencia `wa_crm_qualified:{lead_id}` |
| Interés inicial existente                          | `LeadSubmitted` | `business_messaging` / `whatsapp`                                                    | `wa_lead_submitted:{lead_id}`; no se reemplaza ni se reenvía             |
| Cita real                                          | `Schedule`      | web/CRM fuera de Business Messaging                                                  | identidad propia del hecho de cita                                       |
| Venta real                                         | `Purchase`      | `system_generated` / dataset web en el contrato La Vilet actual                      | `purchase:{sale_id}` y fecha original verificada                         |

`QualifiedLead` se emite una sola vez por lead al entrar por primera vez en cualquiera de los dos estados elegibles. Si entra tibio y después caliente, la segunda transición actualiza el CRM pero no produce otro `QualifiedLead`. Si la primera transición elegible es caliente, produce el único evento. Los reintentos conservan `event_id`, `event_time` e idempotencia. Cita y compra son hechos posteriores independientes y conservan identidades propias.

Campos obligatorios adicionales: `temperature` (`tibio|caliente`), `evidence_labels` no vacío, `qualification_source=crm_persisted_evaluation`, `lead_id`, `contact_id`, `tenant_id`, `project_id`. Los motivos, temperatura y fuente quedan en evidencia interna redacted y no se añaden al payload Graph. Puede enviarse `initial_lead_submitted_event_id` como linaje interno.

## Corte y activación

La entrega nueva queda apagada con `META_WA_CRM_QUALIFICATION_DELIVERY_ENABLED=false`. El productor debe crear solo eventos nuevos posteriores al corte acordado y hacer `ON CONFLICT` sobre `wa_crm_qualified:{lead_id}`; no debe convertir ni recorrer históricos de `LeadSubmitted`. Antes de activarla deben estar instalados el tipo `QualifiedLead` en la tabla/outbox de Supabase, el productor atómico de primera transición elegible y los campos anteriores. La activación es independiente de `META_WA_LEAD_SUBMITTED_DELIVERY_ENABLED`.

`GET /health` expone `delivery_by_event_channel_dataset` para todo el histórico local y para `last_7d`, desglosado por evento, canal, dataset, carril, estado y `delivery_outcome`. El objetivo operativo de 50/7 días se evalúa contando únicamente `QualifiedLead` con `delivery_outcome=meta_accepted` en el dataset de mensajería y carril live. `backend_accepted`, pending, errores de transporte o rechazos Meta no cuentan y no demuestran atribución ni optimización.

## Fuentes oficiales verificadas

- Meta Conversions API for Business Messaging enumera `QualifiedLead` entre los eventos admitidos, además de `LeadSubmitted`, `ViewContent` y `Purchase`; no enumera `Schedule`. También exige que el hecho de mensajería ocurra en el hilo y que `action_source` represente el canal real: https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging
- El ejemplo oficial de Meta para eventos de mensajería muestra el destino de dataset, `action_source=business_messaging`, `messaging_channel=whatsapp` y CTWA: https://github.com/fbsamples/lead-ads-webhook-sample
- Meta Blueprint describe campañas de clientes potenciales cualificados y optimización por calidad; la aceptación técnica de la API sigue siendo solo evidencia de entrega: https://www.facebookblueprint.com/student/path/253141-conversions-api-crm

Meta admite `Purchase` en Business Messaging cuando la compra ocurre realmente en el hilo. La matriz conciliada de La Vilet conserva por ahora `Purchase` como `system_generated` en el dataset web; el backend no acepta su variante BM sin un contrato específico de productor y destino. `Schedule` permanece fuera de BM.

## Conciliación con frontend

El handoff actualizado `CAPI_HOT_LEAD_SIGNAL_HANDOFF_20260924.md` ya define la primera transición `tibio|caliente`, `wa_crm_qualified:{lead_id}`, motivos internos y supresión de un segundo evento al pasar de tibio a caliente. El cambio exacto que debe recibir del backend es `event_name=QualifiedLead`; sus nombres `temperature`, `evidence_labels`, `qualification_source` y su clave se conservan. La bandera acordada es `META_WA_CRM_QUALIFICATION_DELIVERY_ENABLED=false`.

Los campos de atribución que propone el frontend (`attribution_verified`, `meta_attributed`, `attributed_adset_id`) solo podrán contarse cuando exista evidencia devuelta por Meta. Este backend no los fabrica: hasta disponer de esa fuente quedan como pendientes de atribución aunque Graph haya aceptado el evento.
