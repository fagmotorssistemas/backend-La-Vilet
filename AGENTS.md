# AGENTS.md — lavilet-meta-capi

1. Dataset canónico: `923439043758658` (La Vilet Web).
2. Eventos: `ViewContent`, `Lead`, `Schedule`, `LeadSubmitted`, `QualifiedLead`, `AddToWishlist`, `Purchase`.
   QualifiedLead: `META_WA_CRM_QUALIFICATION_DELIVERY_ENABLED`; solo primera
   evaluación CRM persistida `tibio|caliente`, con identidad `wa_crm_qualified:{lead_id}`.
   Purchase: `META_PURCHASE_DELIVERY_ENABLED` + `META_PURCHASE_ACTIVATED_AT` (ISO).
   Elegibilidad: `registered_at` Y `sale_at` (confirmación comercial existente) ambos ≥ corte.
   `action_source=system_generated` (cierre CRM). No `website` por registrar en CRM ni
   `business_messaging` por procedencia WA del lead.
   Catálogo inmobiliario (`Catalog_Real_Estate`): con `unit_id`, Nest asegura
   `content_type=home_listing` + `content_ids=[unit_id]` y los preserva bajo
   `META_CORE_SETUP_CONSERVATIVE` (no inventar en `showroom_general`).
3. Despliegue: DigitalOcean con Docker + volumen `/data`. No asumir secretos en Vercel.
4. Nunca loguear ni commitear tokens ni PII en claro.
5. `META_MODE=live` incompatible con `META_TEST_EVENT_CODE`.
6. Cola outbox debe sobrevivir reinicios (recuperar `processing` → `pending`).
7. Ver `docs/DEPLOY_DIGITALOCEAN.md` antes de desplegar.
