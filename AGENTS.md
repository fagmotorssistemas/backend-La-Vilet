# AGENTS.md — lavilet-meta-capi

1. Dataset canónico: `923439043758658` (La Vilet Web).
2. Eventos: `ViewContent`, `Lead`, `Schedule`. No Purchase por temperatura.
3. Despliegue: DigitalOcean con Docker + volumen `/data`. No asumir secretos en Vercel.
4. Nunca loguear ni commitear tokens ni PII en claro.
5. `META_MODE=live` incompatible con `META_TEST_EVENT_CODE`.
6. Cola outbox debe sobrevivir reinicios (recuperar `processing` → `pending`).
7. Ver `docs/DEPLOY_DIGITALOCEAN.md` antes de desplegar.
