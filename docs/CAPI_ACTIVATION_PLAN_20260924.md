# Plan ejecutable de activación CAPI — 2026-09-24

Este es el único orden de activación. No autoriza por sí mismo despliegues,
migraciones ni llamadas a Meta.

## Versiones y estado observado

- Backend local y `origin/main`: base
  `6b4e8c2c05bfecbfdabd2e51b16b07835bb7280d`, más el worktree local CAPI aún
  sin commit. La versión candidata solo queda identificada de forma desplegable
  cuando estas correcciones tengan un SHA nuevo.
- Frontend local y `origin/main`: base
  `d0b97ab67dacee2d687c8d736b636c8467d9cdd9`, más el worktree conciliado aún
  sin commit. También necesita un SHA nuevo antes del despliegue.
- Producción consultada por `GET /api/health` a las 21:37:56 UTC del 2026-09-24:
  `META_MODE=live`, sin test code, credenciales web y mensajería presentes, worker
  y drain activos, webhooks WhatsApp challenge/receive activos y reconciliador CTWA
  activo,
  `META_PURCHASE_DELIVERY_ENABLED=true` y corte
  `2026-09-22T21:18:17.000Z`. SQLite se anuncia en
  `/data/lavilet-meta-capi.db`; health mostró 41 `sent` y 2 `cancelled`.
- Ese health no incluye `outbox.result_sync_counts` ni
  `wa_crm_qualification_delivery_enabled`, campos presentes en el candidato
  local. Por ello producción no acredita el backend corregido. El endpoint no
  publica SHA/digest. El acceso SSH autorizado a `138.197.35.10:22` agotó el
  timeout, por lo que el commit, digest del contenedor y montaje durable de `/data`
  siguen sin verificar. La versión desplegada queda identificada por comportamiento
  como anterior al candidato local, pero no se le asigna un SHA supuesto.

Consulta remota de Supabase del mismo día: el registro de migraciones termina en
`20260923163751_marketing_ad_interactions`. Ninguna de las seis migraciones del
paquete siguiente aparece registrada y sus objetos nuevos tampoco existen. La
configuración efectiva `lv_auto_config` es `enabled=true`, `dry_run=false`,
`test_only=true`, con lead de prueba definido. Esto permite procesamiento para ese
lead si el receptor vuelve a estar disponible.

Cambios backend del candidato: conservación de `sale_at`; gates de
`registered_at`, `sale_at` y `event_time`; resultados separados; destino y token
propios de Business Messaging; idempotencia estricta; cola SQLite durable de
resultados; health de dicha cola; pruebas de contrato/reinicio y documentación.

Cambios frontend del candidato: productores con UUID/fecha/carril estables,
Purchase desde `unit_sales_closings` sin fecha fabricada, controles de flush por
evento, contrato completo de LeadSubmitted, lectura de `delivery_outcome` y
sincronización de resultados Nest.

## Bloqueo inicial obligatorio

Producción tiene Purchase activo. Antes de reemplazar contenedor, frontend o SQL:

1. Poner `META_MODE=disabled` en backend. Poner en falso los flags Schedule,
   LeadSubmitted y Purchase. Esto conserva las filas; no borrar ni reenviar.
2. Dejar el proceso levantado el tiempo necesario para que el candidato actual no
   reclame más Graph. Si existe sincronización de resultados pendiente, conservarla
   en SQLite; el backend nuevo la recuperará.
3. Desactivar los flags de captura/flush correspondientes en frontend. No ejecutar
   recoveries ni cambiar `review_hold`/`needs_review` en masa.
4. Confirmar por health `mode=disabled`; contar por evento, estado y carril en
   SQLite de solo lectura. Verificar el mount de `/data` y obtener un backup
   consistente tras parada limpia. No usar `docker compose down -v`.

## Dependencias que deben estar instaladas

Verificar por catálogos, ACL y RLS; no llamar funciones comerciales durante la
instalación.

| Consumidor    | Base de datos requerida                                                                                                                                                                                                                                                                            | Frontend requerido                                                                                | Backend/config requerida                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| ViewContent   | `meta_capi_outbox`, ledger y RPC atómico de identificación; RLS service-role                                                                                                                                                                                                                       | productores showroom/unidad conciliados y Pixel con el mismo `event_id`                           | dataset/token web; Core Setup acordado                                                                          |
| Lead          | migraciones base outbox/consentimiento y `identify_tour_lead_with_meta_outbox`                                                                                                                                                                                                                     | ruta de lead conciliada; fecha de `tour_info_requests`                                            | carril web                                                                                                      |
| AddToWishlist | `20260922180000_meta_measurement_wishlist_purchase_capture.sql`                                                                                                                                                                                                                                    | validación del favorito durable y productor conciliado                                            | carril web                                                                                                      |
| Schedule      | `20260917152000`, `17160000`, `17170000` y `17180000`; RPC `lv_register_meta_schedule_intent`                                                                                                                                                                                                      | persist/flush/recover Schedule conciliados                                                        | flags Schedule apagados hasta su prueba; solo website                                                           |
| LeadSubmitted | `20260918120000`, `20260921221156`, `20260922120000`; tabla `meta_capi_conversion_log`; CTWA scoped. Antes del productor conversacional deben existir `20260923211512_interest_evaluation_evidence.sql` y después `20260923174920_kommo_message_evidence.sql`, en el orden coordinado por frontend | productor conciliado con CTWA/WABA/dataset y flags enabled/delivery/flush                         | `META_WABA_ID`, `META_MESSAGING_DATASET_ID`, token WA y scopes; los dos destinos deben coincidir con el payload |
| Purchase      | `20260922180000`, `20260922190000` y `20260924183000_unit_sales_closings_scoped_authorization.sql`; RLS probada con admin, vendedor asignado y usuario ajeno                                                                                                                                       | lectura autorizada de `unit_sales_closings`; `sale_at`, `registered_at` y `event_time` originales | flag apagado al desplegar; corte nuevo; validación de venta/anulación, importe y moneda                         |

La secuencia base de frontend para sus cuatro migraciones generales es:
`20260923205830_disable_destructive_contact_resets.sql`,
`20260923211512_interest_evaluation_evidence.sql`,
`20260923174920_kommo_message_evidence.sql` y
`20260924183000_unit_sales_closings_scoped_authorization.sql`. El responsable de
base debe registrar cada versión aplicada. Las dos migraciones de observación e
interés no autorizan cambiar puntuación, temperatura ni automatizaciones.

Inventario remoto comprobado por registro y catálogos:

| Migración candidata | Estado remoto 24/09/2026 | Validación requerida |
| --- | --- | --- |
| `20260923205830_disable_destructive_contact_resets.sql` | No registrada | Funciones de reset sin EXECUTE y cuerpo bloqueado; huellas de backups intactas |
| `20260923211512_interest_evaluation_evidence.sql` | No registrada; `lead_interest_evaluations` y `lv_evaluate_message_interest` ausentes | ACL service-role, RLS, evaluación aislada sin cambio de puntuación |
| `20260923174920_kommo_message_evidence.sql` | No registrada; receptor, diario y tablas ausentes | ACL/RLS, atomicidad y configuración de automatización apagada antes de aplicar |
| `20260924183000_unit_sales_closings_scoped_authorization.sql` | No registrada; helper y guardas scoped ausentes | JWT reales: admin, asesor asignado y usuario ajeno; hoy persiste la política permisiva `Authenticated all unit_sales_closings` |
| `20260924213000_hot_lead_capi_signal_staging.sql` | No registrada; staging ausente | Conteos retenidos, exclusiones y ausencia de backfill |
| `20260924214000_enable_crm_qualified_lead_outbox.sql` | No registrada; `meta_capi_signal_activation` ausente | Configuración nace apagada, constraints, RLS e inserción atómica |

`20260923174920_kommo_message_evidence.sql` no es pasiva respecto del sistema ya
publicado: al restaurar `lv_receive_kommo_observation`, el webhook deja de fallar por
RPC ausente y puede volver a entregar eventos a los receptores existentes. Como la
base actualmente permite ejecución para el lead de prueba, no se recomienda
aplicarla hasta comprobar `AUTOMATION_MODE=off` en el runtime y cambiar, mediante una
ventana expresamente autorizada, `lv_auto_config.enabled=false` (o `dry_run=true`).
Después se vuelve a leer ambos controles antes de aplicar. `QualifiedLead=false` no
detiene bots, cola Kommo ni los consumidores comerciales existentes.

## Despliegue con consumidores apagados

1. Crear un commit backend que contenga solamente el candidato revisado y registrar
   su SHA. Crear por separado el commit frontend conciliado y registrar su SHA.
2. Comprobar las dependencias SQL anteriores y las consultas de
   `operations/verify_capi_frontend_contract_readonly.sql`. Detenerse ante una
   función, constraint, ACL o RLS ausente.
3. Desplegar primero backend con `META_MODE=disabled`, los tres flags de entrega en
   falso y el mismo volumen `/data`. Confirmar SHA/digest, migraciones SQLite,
   `meta_result_sync_outbox`, `result_sync_counts`, worker y drain sin error.
4. Desplegar frontend con todos los flags CAPI sensibles apagados. Confirmar que no
   libera `review_hold`, `needs_review` ni históricos.
5. Comparar conteos pre/post. Ninguna fila `sent` puede volver a `pending` y ningún
   `event_id`, fecha o clave puede cambiar.

## Meta Test Events aislado — exclusivamente QualifiedLead

La prueba requiere autorización expresa para una ventana y alcance concretos. La
autorización debe enumerar: SHA backend/frontend, datasets web y mensajería,
eventos permitidos, test code, hora de inicio/fin, identidades de prueba, WABA/CTWA
de prueba, venta de prueba autorizada y responsable que observará Events Manager.

Acciones tras esa autorización:

1. Crear una segunda instancia temporal del **backend candidato**, sin frontend,
   webhooks ni rutas productivas, enlazada solo a loopback o una red privada. Usar
   otro nombre de servicio, puerto, volumen y `DATABASE_PATH`; nunca montar
   `/data/lavilet-meta-capi.db` ni el volumen live.
2. No configurar Supabase en esa instancia: `SUPABASE_DRAIN_ENABLED=false`,
   `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` ausentes. Mantener
   `META_WA_CLOUD_WEBHOOK_CHALLENGE_ENABLED=false`,
   `META_WA_CLOUD_WEBHOOK_RECEIVE_ENABLED=false` y
   `META_WA_CTWA_RECONCILE_ENABLED=false`.
3. Controles temporales exclusivos de esa instancia:
   `META_MODE=test`, `META_TEST_EVENT_CODE=<código de la ventana>`,
   `OUTBOX_ENABLED=true` y
   `META_WA_CRM_QUALIFICATION_DELIVERY_ENABLED=true`. Configurar únicamente el
   token de mensajería, WABA y dataset aprobados para la prueba, más un secreto
   interno temporal. Mantener Schedule, LeadSubmitted y Purchase en `false`; no
   configurar token/dataset web si no son necesarios.
4. Insertar por `POST /api/v1/events` un único hecho nuevo sintético y autorizado:
   `QualifiedLead`, `delivery_lane=test`, `action_source=business_messaging`, canal
   WhatsApp, CTWA de prueba, WABA/dataset correctos, temperatura tibio o caliente y
   evidencia interna. Registrar antes el `event_id`, `event_time` original y
   `wa_crm_qualified:{lead_id}`; cualquier retry conserva exactamente esos valores.
5. **Evidencia de recepción:** exigir respuesta Graph con `events_received>=1`,
   estado GET `meta_accepted` y aparición correlacionada por `event_id` en Meta Test
   Events. Un 2xx/202 interno solo prueba aceptación del backend.
6. **Evidencia publicitaria separada:** sin enviar otro evento ni activar live,
   revisar en los activos concretos que el dataset de mensajería está vinculado a la
   cuenta/WABA correctas y que `QualifiedLead` aparece seleccionable como señal de
   optimización para el conjunto de anuncios y objetivo acordados. Documentar cuenta,
   dataset, WABA, campaña/conjunto y captura/estado. La recepción de Test Events no
   demuestra esta elegibilidad; la selección del objetivo tampoco demuestra que ese
   dataset/evento concreto pueda alimentarlo.
7. Apagar primero `META_WA_CRM_QUALIFICATION_DELIVERY_ENABLED`, después cambiar
   `META_MODE=disabled`. Esperar a que el único resultado ya aceptado quede durable,
   detener la instancia y archivar health, GET, respuesta redactada y copia de su
   SQLite aislada. Revocar el secreto temporal. No copiar filas, IDs ni volumen a
   producción.

Producción no cambia durante esta prueba: conserva sus flags, drain, webhooks,
SQLite y carril actuales hasta una activación live autorizada por separado.

## Paso a live

1. Confirmar test aprobado, cola de resultados sin errores y observabilidad GET.
2. En producción quitar el test code antes de `META_MODE=live`.
3. Activar primero ViewContent/Lead/AddToWishlist; después Schedule; luego
   LeadSubmitted. Habilitar cada flag por separado y observar eventos nuevos.
4. Purchase se activa al final con un corte nuevo posterior al despliegue. Auditar
   individualmente toda fila procesable; no heredar el corte productivo actual ni
   liberar históricos.

## Purchase retenido

`event_time` solo es válido cuando equivale a
`floor(epoch(sale_at original verificado))`. El backend candidato retiene con
`purchase_event_time_required` o `purchase_event_time_mismatch` si falta o difiere.

- Si `event_time` ya es correcto y solo faltan fechas en `payload_redacted`, con
  Purchase apagado se pueden completar las fechas verificadas en la misma fila y
  dentro de una transacción, sin cambiar identidad, carril, payload Graph ni estado.
- Si `event_time` falta o es incorrecto, la fila sigue bloqueada. La resolución
  requiere una herramienta auditada, aún no implementada, que sobre una fila
  Purchase no enviada actualice atómicamente `outbox_events.event_time` y
  `graph_payload.data[0].event_time` al mismo segundo original, con valores esperados
  y exactamente una fila afectada. Hasta disponer de ella, no corregir parcialmente,
  no crear otra identidad y no habilitar esa fila.

## Detención preservando colas y evidencia

1. Desactivar el flag del consumidor afectado. Para detener todo Graph, cambiar
   `META_MODE=disabled`; no borrar filas.
2. Dejar el proceso activo si es posible para que termine la sincronización durable
   ya aceptada. Si Supabase no responde, detener igualmente: la cola SQLite debe
   quedar pendiente y se recuperará sin reenviar Graph.
3. Apagar drain y flush frontend si se necesita detener también la entrada. No
   cancelar ni promover filas automáticamente.
4. Registrar health, conteos por evento/estado/carril, conteos de result sync y SHA/
   digest. Hacer parada limpia y backup consistente del volumen `/data`.
5. Reiniciar con el mismo volumen y flags apagados. Verificar que `sent` permanece
   `sent`, `processing` se recupera, y solo después decidir reanudar un consumidor.

Nunca ejecutar `down -v`, borrar SQLite, regenerar IDs, cambiar fechas para cruzar
el corte ni reenviar históricos.

## Propuesta concreta para aprobación posterior

La aprobación puede referirse a este paquete como `CAPI-20260924-candidato-local-1`:

- backend: base `6b4e8c2c05bfecbfdabd2e51b16b07835bb7280d` más el diff local CAPI revisado;
- frontend: base `d0b97ab67dacee2d687c8d736b636c8467d9cdd9` más el diff local conciliado;
- SQL: las seis migraciones de la tabla anterior, aplicadas individualmente y con
  parada entre fases;
- ensayo externo: una instancia temporal aislada y un solo `QualifiedLead` en
  carril test;
- controles temporales: solo `META_MODE=test`, test code, worker local y flag
  `META_WA_CRM_QUALIFICATION_DELIVERY_ENABLED=true` en esa instancia;
- resultados de aceptación: recepción Test Events correlacionada, y en un acta
  separada elegibilidad del evento/dataset para los activos publicitarios concretos;
- cierre: flags apagados, instancia detenida, SQLite aislada archivada y producción
  intacta.

Antes de convertir esa etiqueta en una versión desplegable deben crearse, tras
autorización, dos commits separados y registrar sus SHA. Si cambia cualquier diff,
migración, dataset, WABA o control, la aprobación debe actualizarse.

## Bloqueos actuales

1. Backend y frontend conciliados carecen de SHA versionado.
2. SHA/digest productivo y mount durable no pudieron verificarse: health no los
   publica y SSH agotó el timeout el 24/09/2026.
3. Producción continúa live con Purchase activo sobre el backend anterior.
4. Las seis migraciones candidatas están ausentes del registro remoto y sus objetos
   característicos también están ausentes. La RLS scoped de cierres sigue pendiente;
   producción conserva una política `ALL` permisiva para `authenticated`.
5. La configuración DB de automatización está activa para un lead de prueba. Falta
   verificar `AUTOMATION_MODE=off` y autorizar el apagado DB antes de restaurar el
   receptor Kommo.
6. Configuración WhatsApp: token de lectura válido, WABA aprobado/verificado, La
   Vilet y Kommo co-suscritos y callback del teléfono apuntando a Nest. La
   suscripción de la app al objeto `whatsapp_business_account/messages` no pudo
   verificarse porque la consulta devolvió error de autorización; no debe declararse
   ausente. El acceso del portfolio tampoco pudo verificarse por falta de
   `business_management`.
7. Meta Test Events no está autorizado ni ejecutado.
8. La elegibilidad de `QualifiedLead`, dataset y activos concretos para el objetivo
   publicitario no está verificada; es una comprobación separada de Test Events.
9. La reparación auditada de `event_time` para Purchase retenido no está
   implementada.
