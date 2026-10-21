-- Modelo de señales CAPI (2026-10-21). Ver docs/CAPI_SIGNAL_MODEL_20261021.md.
-- NO aplicado. Copiar a las migraciones del frontend y aplicar con aprobación.
-- Idempotente: se puede ejecutar más de una vez.
begin;

-- 1) Eventos nuevos en la cola Supabase → Nest.
alter table public.meta_capi_outbox
  drop constraint if exists meta_capi_outbox_event_name_check;
alter table public.meta_capi_outbox
  add constraint meta_capi_outbox_event_name_check
  check (event_name = any (array[
    'ViewContent', 'Search', 'InitiateCheckout', 'Lead', 'Schedule',
    'LeadSubmitted', 'QualifiedLead', 'AddToWishlist', 'Purchase',
    'VentaCerrada'
  ]::text[]));

-- 2) Etapas que Nest sincroniza y el CHECK actual rechaza
--    (transport_failed, meta_unverified): hoy esos resultados nunca llegan al CRM.
alter table public.meta_capi_conversion_log
  drop constraint if exists meta_capi_conversion_log_stage_check;
alter table public.meta_capi_conversion_log
  add constraint meta_capi_conversion_log_stage_check
  check (stage = any (array[
    'evaluated', 'blocked', 'enqueued', 'backend_accepted', 'meta_accepted',
    'meta_rejected', 'transport_failed', 'meta_unverified'
  ]::text[]));

commit;
