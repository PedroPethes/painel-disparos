# Deploy — Log de Eventos (Railway, Nível 2)

Arquitetura de isolamento: **Postgres + 2 serviços** (mesmo repo, comandos de start diferentes).

- **ingestor** — interno, tem a credencial do Metabase, roda o cron diário. **Sem domínio público.**
- **api** — público, tem **só** `DATABASE_URL` + `API_TOKEN` (zero credencial de produção). Serve o painel e a API.

Se a `api` for comprometida, o atacante alcança só os eventos do cliente — nunca o banco da plataforma.

## Passos (feitos junto com o time — exigem `railway login`)

1. **Railway CLI** (interativo — você roda):
   ```bash
   npm i -g @railway/cli
   railway login
   railway link            # selecione o projeto painel-disparos
   ```

2. **Adicionar Postgres** ao projeto:
   ```bash
   railway add             # escolha PostgreSQL  -> cria DATABASE_URL
   ```

3. **Serviço `api`** (é o serviço atual, deploy via GitHub → `main`):
   - Start command: `npm start`
   - Variáveis: `DATABASE_URL` (referência ao Postgres), `API_TOKEN` (gere um token forte)
   - **Remover** `METABASE_URL` / `METABASE_USER` / `METABASE_PASS` (saem da superfície pública)
   - Manter o domínio público

4. **Serviço `ingestor`** (novo, mesmo repo):
   - Start command: `npm run ingest`
   - Variáveis: `DATABASE_URL`, `METABASE_URL`, `METABASE_USER`, `METABASE_PASS`, `LOOKBACK_DAYS=30`
   - Webhook (deixar vazio até o cliente enviar): `CLIENT_WEBHOOK_URL`, `CLIENT_WEBHOOK_SECRET`
   - **Sem domínio público**
   - **Cron schedule:** `0 9 * * *`  (09:00 UTC = 06:00 BRT)

5. **Backfill do histórico** (uma vez):
   ```bash
   railway run --service ingestor node dist/ingest.js --backfill 2024-01-01
   ```
   Ajuste a data inicial para quando os bots de Welcome começaram (dá pra descobrir a
   conversa mais antiga com `current_organization_id` in (1200,1201)).

6. **Conferir:** abrir o painel, informar o `API_TOKEN`, ver o funil + a tabela + o CSV.

## Variáveis de ambiente

| var | api (público) | ingestor (interno) |
| --- | :---: | :---: |
| `DATABASE_URL` | ✅ | ✅ |
| `API_TOKEN` | ✅ | — |
| `METABASE_URL/USER/PASS` | ❌ (removido) | ✅ |
| `LOOKBACK_DAYS` | — | ✅ (30) |
| `CLIENT_WEBHOOK_URL/SECRET` | — | ⬜ (vazio até o cliente) |
| `PORT` | (Railway injeta) | — |

## Endpoints da API

- `GET /api/funil?startDate=&endDate=&segment=` → contagens (funil + série diária)
- `GET /api/eventos?startDate=&endDate=&segment=&etapa=&format=json|csv&limit=&offset=` → log
- Auth: header `Authorization: Bearer <API_TOKEN>` (ou `?token=` para o CSV)
- Período: padrão últimos 30 dias, teto 180; rate limit 60/min · 500/dia

## Rodar local (dev)

```bash
# Postgres local em :5433, base painel_eventos
npm install
npm run dev:ingest -- --backfill 2026-07-01   # popular
npm run dev                                    # sobe a api em :3000
npm test                                       # suíte (usa DATABASE_URL local)
```

## Hardening futuro (opcional)

- Role Postgres **read-only** para a `api` (hoje ela roda `migrate` na subida).
- Definir o sinal do **transbordo** (Fase 2) e adicionar a etapa `vendedor`.
