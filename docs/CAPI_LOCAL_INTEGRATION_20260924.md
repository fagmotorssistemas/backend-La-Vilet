# Integración local frontend/backend CAPI — 2026-09-24

Ejecución exclusivamente local. SQLite usa un directorio temporal; Graph y
Supabase se interceptan mediante `fetch` simulado. No acredita Meta Test Events,
la versión desplegada ni RLS con identidades reales.

## Cobertura ejecutada

- Siete fixtures: los seis eventos y `ViewContent` en `showroom_general` y
  `detalle_unidad`.
- Conservación de `event_id`, `event_time`, `delivery_lane`, `action_source`,
  dataset y campos propios de Purchase y Business Messaging.
- Repetición idéntica sin otra fila; cambio de fecha con la misma clave devuelve
  `409 idempotency_key_conflict`.
- Lectura GET de `backend_accepted`, `transport_failed`, `meta_rejected`,
  `meta_unverified`, `meta_accepted` y `cancelled`.
- Reinicio real de la instancia SQLite entre fallo y recuperación de la
  sincronización de resultado. La fila Graph permanece `sent` y no vuelve a
  enviarse.
- Modo test solo reclama test; una fila live queda `held:lane_mismatch`.
- Purchase sin fechas queda pendiente con `purchase_registered_at_required` o
  `purchase_sale_at_required` antes de cualquier intento Graph.

Los payloads de `CAPI_LOCAL_TEST_PAYLOADS.json` son fixtures escritos a mano. La
validación de productores se ejecuta por separado sobre el checkout frontend:
tests de contrato final, ViewContent/Pixel, Lead, wishlist, Schedule,
LeadSubmitted y Purchase. Ningún test del backend considera el fixture como
prueba suficiente del productor.

## Incorporar una fecha original verificada a Purchase

Este procedimiento corrige la misma identidad. No crea otra clave ni otro
`event_id`, y no promueve históricos por barrido.

1. Mantener `META_PURCHASE_DELIVERY_ENABLED=false` y detener el worker durante la
   intervención.
2. Verificar `sale_at` y `registered_at` contra la fila concreta de
   `unit_sales_closings`, identificada por `sale_id`. Registrar quién verificó la
   fuente y cuándo, fuera del payload publicitario.
3. Localizar una única fila SQLite por `event_id`,
   `idempotency_key='purchase:' || sale_id`, `event_name='Purchase'` y estado no
   enviado. Si ya contiene una fecha distinta, detenerse: es un conflicto que
   requiere revisión, no una sobrescritura.
4. Comprobar que `event_time = floor(epoch(sale_at))`. Si ya coincide con el hecho
   original verificado, dentro de una transacción se pueden completar únicamente
   `$.sale_at` y/o `$.registered_at` en `payload_redacted`; no modificar identidad,
   carril, payload Graph, estado ni intentos. Exigir exactamente una fila afectada.
   Si `event_time` falta o es incorrecto, mantener la fila bloqueada con
   `purchase_event_time_required` o `purchase_event_time_mismatch`. Su resolución
   requiere una reparación auditada de la misma fila que actualice atómicamente
   `outbox_events.event_time` y `graph_payload.data[0].event_time` al instante
   original verificado. Esa herramienta no existe todavía: no editar parcialmente,
   no repetir el POST con otra identidad y no habilitar la fila.
5. Leer el evento por GET y revisar nuevamente identidad, carril, importe,
   moneda y las dos fechas. Mantener Purchase apagado.
6. Activar esa venta solo mediante el procedimiento general: corte
   `META_PURCHASE_ACTIVATED_AT`, controles de venta/anulación, prueba aislada y
   habilitación explícita. Las filas anteriores al corte siguen retenidas.

Una repetición del POST no sirve para completar fechas ausentes: la idempotencia
preserva la fila existente y no muta su payload. Tampoco debe generarse una nueva
identidad para eludir el conflicto.

## Pendientes de activación

- Meta Test Events con evidencia real.
- Confirmación del commit desplegado.
- RLS y permisos con JWT/identidades reales.
- Valores autorizados de WABA, dataset de mensajería y credenciales por carril.
- Revisión operativa de cada Purchase antes de habilitar su flag.

Purchase continúa reservado a ventas reales. No existe señal de temperatura en
esta integración.
