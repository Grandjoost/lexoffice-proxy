# lexoffice-proxy

Vercel serverless API — Proxy zwischen HubSpot UI Extensions und Lexoffice/HubSpot APIs.

## Environment Variables

| Variable | Zweck |
|---|---|
| `HUBSPOT_TOKEN` | HubSpot Private App Token — für alle HubSpot API-Aufrufe verwenden |
| `LEXOFFICE_API_KEY` | Lexoffice/Lexware API Key |
| `WEBHOOK_SECRET` | HMAC-Secret für Lexoffice Webhooks |
| `NODITCH_BILLING_URL` | URL des noditch-billing Vercel-Deployments |
| `KV_URL` / `KV_REST_API_*` | Vercel KV (Redis) für Idempotenz-Keys |
| `REDIS_URL` | Redis-Verbindung |
| `CRON_SECRET` | Secret für Cron-Job-Endpunkte |

**Wichtig:** Immer `HUBSPOT_TOKEN` verwenden — nicht `PRIVATE_APP_ACCESS_TOKEN` oder andere Varianten erfinden.

## Origin-Check

Alle Endpunkte prüfen via `checkOrigin` ob `?portalId=143405850` im Query-String vorhanden ist.
HubSpot UI Extension Fetches müssen daher immer `&portalId=${PORTAL_ID}` anhängen.

## Deployment

```bash
vercel --prod
```
