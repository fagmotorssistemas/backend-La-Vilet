# Modelo de señales CAPI La Vilet (2026-10-21)

Este documento manda sobre `CAPI_CONTRACT_FINAL.md` para Purchase y para los
eventos nuevos. Objetivo: que cada evento junte el máximo de señales **reales**
para que las campañas salgan de "Aprendizaje limitado", sin inflar.

## Idea central

- Meta exige ~50 eventos por semana **en el evento de optimización de cada
  conjunto de anuncios**, no en todos los eventos.
- En anuncios Click-to-WhatsApp, el único evento CAPI con el que Meta puede
  optimizar es `Purchase`. Por eso `Purchase` = **contacto calificado**, no la venta.
- La venta real es `VentaCerrada` (evento propio): solo mide el retorno real.

## Matriz

| Evento             | Se envía cuando…                                                                                                         | Canal (`action_source`)          | Clave idempotente sugerida                                        | Requisitos                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `Search`           | Entra al 360, filtra tipologías o ve un listado                                                                          | `website`                        | `search:{visitor_key}:{yyyy-mm-dd}`                               | `content_ids` = 1–10 unidades del listado                                                                                   |
| `ViewContent`      | Consulta una unidad (360/ficha) o pregunta por un depa concreto                                                          | `website` o `business_messaging` | `view:{visitor_key}:{unit_id}`                                    | Con unidad: `unit_id` (Nest pone `content_ids=[unit_id]`)                                                                   |
| `InitiateCheckout` | Guarda una unidad, cambia acabados/luz, >30 s en una unidad, simulador, o pregunta precio/entrada/financiamiento/entrega | `website` o `business_messaging` | `initiate_checkout:{lead_id\|visitor_key}:{unit_id}:{yyyy-mm-dd}` | `unit_id` obligatorio                                                                                                       |
| `Lead`             | Deja sus datos en la web                                                                                                 | `website`                        | `lead:{lead_id}`                                                  | —                                                                                                                           |
| `LeadSubmitted`    | Conversa de verdad por WhatsApp (no solo "hola")                                                                         | `business_messaging`             | `wa_lead_submitted:{lead_id}`                                     | CTWA, WABA, dataset de mensajería                                                                                           |
| `QualifiedLead`    | Primera evaluación CRM tibio/caliente                                                                                    | `business_messaging`             | `wa_crm_qualified:{lead_id}`                                      | Igual que hoy                                                                                                               |
| **`Purchase`**     | **Contacto calificado:** tibio/caliente, pide visita o reserva, pregunta financiamiento, da cédula o presupuesto         | `website` o `business_messaging` | `purchase_qualified:{lead_id}:{unit_id\|none}`                    | `lead_id`; por WhatsApp además `contact_id` + identificadores BM. **No enviar `value`**: Nest usa el valor fijo configurado |
| **`VentaCerrada`** | Firma de la venta (CRM)                                                                                                  | `system_generated`               | `venta_cerrada:{sale_id}`                                         | `sale_id`, `lead_id`, `unit_id`, `value`, `currency`, `registered_at`, `sale_at`; `event_time = floor(epoch(sale_at))`      |
| `Schedule`         | Cita web confirmada                                                                                                      | `website`                        | `schedule:{appointment_id}`                                       | Sin cambios (Meta no acepta Schedule por WhatsApp)                                                                          |
| `AddToWishlist`    | Legado                                                                                                                   | `website`                        | `wishlist:{lead_id}:{unit_id}`                                    | Se mantiene por compatibilidad; el favorito nuevo es `InitiateCheckout`                                                     |

Reglas comunes:

- Máximo **un evento por persona, por unidad y por día** (las claves de arriba lo garantizan).
- Siempre con la unidad cuando existe: es lo que alimenta el catálogo inmobiliario.
- Por WhatsApp, Meta no admite `Search`, `Lead` (usar `LeadSubmitted`) ni `Schedule`.
- `Purchase` con `action_source=system_generated` se rechaza
  (`purchase_is_qualified_contact_use_venta_cerrada`): la venta va como `VentaCerrada`.

## Cascada (opcional, `META_SIGNAL_CASCADE_ENABLED`)

Si se dispara un evento alto, Nest encola los inferiores que falten, en el mismo canal:

- `Purchase` con unidad → `InitiateCheckout` + `ViewContent` + `Lead` (`LeadSubmitted` por WhatsApp).
- `Purchase` sin unidad → `Lead` / `LeadSubmitted`.
- `InitiateCheckout` → `ViewContent`.

Sin duplicar: `Lead`/`LeadSubmitted` una vez por lead; `ViewContent`/`InitiateCheckout`
una vez por persona y unidad cada 24 h. Claves `cascade:{Evento}:{clave del evento alto}`,
`event_id` determinista y el mismo `event_time`. La respuesta de `POST /v1/events`
incluye `cascade: [{ event_name, event_id?, delivery }]`.

Consecuencia para el productor: `Lead`/`LeadSubmitted` deben salir en el primer
contacto (antes de la calificación). Si llegan después de una cascada que ya los
generó, se envían dos.

## Interruptores (todos apagados por defecto)

| Variable                                                | Controla                                                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `META_QUALIFIED_PURCHASE_DELIVERY_ENABLED`              | Envío de `Purchase` (contacto calificado)                                                          |
| `META_QUALIFIED_PURCHASE_VALUE` / `_CURRENCY`           | Valor fijo por contacto calificado (moneda por defecto USD). Sin valor, el Purchase queda retenido |
| `META_SALE_DELIVERY_ENABLED` / `META_SALE_ACTIVATED_AT` | Envío de `VentaCerrada` y su corte (ISO)                                                           |
| `META_FUNNEL_EVENTS_DELIVERY_ENABLED`                   | `Search`, `InitiateCheckout` y `ViewContent` por WhatsApp                                          |
| `META_SIGNAL_CASCADE_ENABLED`                           | Cascada                                                                                            |

`META_PURCHASE_DELIVERY_ENABLED` y `META_PURCHASE_ACTIVATED_AT` ya no tienen
efecto; `/api/health` los lista en `deprecated_env_present` y el worker avisa al arrancar.

## Supabase (requisito antes de que el frontend produzca eventos nuevos)

Aplicada en producción el 2026-10-22 (`20261022003647_capi_signal_model_event_names_and_stages`).
Falta copiar `operations/supabase/20261021_capi_signal_model.sql` a las migraciones del frontend. Amplía los CHECK de `meta_capi_outbox.event_name`
y de `meta_capi_conversion_log.stage` (hoy rechaza `transport_failed` y
`meta_unverified`, que Nest sí reporta).

## Campañas (resumen)

1. Lanzamiento: WhatsApp (Interacción y Clientes potenciales, mismo anuncio y
   presupuesto) optimizando por conversaciones; web 360 con Ventas → `ViewContent`.
2. Comparar por costo por contacto calificado (`Purchase`), no por conversación.
3. Cuando `Purchase` pase 50 por semana en una campaña: objetivo Ventas → `Purchase`.
4. `VentaCerrada` nunca se usa para optimizar.
