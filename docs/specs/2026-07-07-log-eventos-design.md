# Design — Log de Eventos (Disparo / Resposta / Vendedor) + API + Webhook

**Data:** 2026-07-07
**Projeto:** `painel-disparos` (Dashboard Disparos & Respostas)
**Status:** aprovado e implementado

---

## 1. Objetivo

O cliente pediu um **log de eventos** do funil de Welcome: cada evento vira uma linha
marcada com a etapa do funil. Uso declarado: **analítico**, com o **telefone** incluído
para eles **cruzarem internamente** (CRM/planilhas). Atualização **1x/dia** é suficiente.

Etapas do funil:

1. **Disparo** — o bot iniciou a conversa.
2. **Resposta** — o cliente respondeu (≥1 mensagem real).
3. **Direcionado ao vendedor** — transbordo pro humano. → **Fase 2** (definição pendente).

Entrega desta fase: **etapas 1 e 2**, com a etapa 3 pré-encaixada para entrar depois
sem quebrar contrato.

## 2. Escopo

**Dentro (Fase 1):**
- Painel (opção C): funil resumido + tabela de eventos + exportar CSV.
- API de leitura (pull) protegida por token.
- Webhook diário (push) opcional, configurável por variável de ambiente.
- Store isolado (Postgres) + ingestão diária + backfill do histórico.
- Topologia de **isolamento (Nível 2)**: superfície pública sem credencial de produção.

**Fora (agora):**
- Etapa "direcionado ao vendedor" (Fase 2 — depende de descobrir o sinal na fonte).
- Tempo real / streaming (combinado: 1x/dia basta).
- Autoatendimento de múltiplos clientes (isto é dedicado ao cliente).

## 3. Princípio de segurança (decisão central)

O cliente **nunca** acessa o banco da plataforma. Ele fala só com a **nossa** superfície,
que expõe **o mínimo necessário**. Como agora há **telefone (PII)**, adotamos o **Nível 2**:
a superfície pública **não carrega credenciais de produção** — ela só enxerga um store
isolado que contém **apenas os eventos do cliente**.

**Campos expostos por evento:** `timestamp` · `segmento` (rótulo) · `etapa` · `telefone`.
**Nunca expostos:** conteúdo de mensagem, `conversation_id`, IDs internos de bot,
`user_name`/nome, qualquer outra coleção, qualquer dado de outros clientes.

> O `conversation_id` é usado **só internamente** como chave de deduplicação; não sai na API.
> O nome (`user_name`) fica **desligado por padrão** (minimiza PII); trivial de ligar se pedirem.

## 4. Fonte de dados (verificado em 2026-07-07)

MongoDB de produção (Metabase database 3), workspace do cliente. Bots:
`1201` = Welcome Novos · `1200` = Welcome Recorrentes.

**Coleção `conversations`** (1 doc por disparo):
- `created_at` → **timestamp do disparo** (UTC).
- `current_organization_id` → bot (segmento).
- `external_id` → **telefone** (WhatsApp; numérico, começa com `55`, 12–13 dígitos). ✅ confirmado.
- Sem join: o telefone está no próprio doc (não existe coleção `contacts`/`leads`).
- Pistas para Fase 2 (transbordo): `automation_paused`, `tags`, `steps_occurred`, `next_stepper`.

**Coleção `message_history_bases`** (mensagens):
- `role='user'` + `is_span=false` = mensagem **real** do cliente.
- `created_at` da 1ª dessas por conversa → **timestamp da resposta**.
- `conversation_id` liga à conversa.

Confirmado que a fonte **não expira** dados antigos → backfill do histórico é seguro e único.

### Definição dos eventos
- **Disparo:** 1 por conversa. `ts = conversations.created_at`.
- **Resposta:** existe sse a conversa tem ≥1 msg real do cliente. `ts = min(created_at)` dessas msgs.
  ⚠️ A resposta pode chegar **dias depois** do disparo — a ingestão precisa reavaliar uma
  janela retroativa (ver §6).

## 5. Arquitetura (Nível 2 — isolamento)

Três peças num mesmo projeto Railway / mesmo repositório:

```
                 ┌───────────────────────────┐
   (cron diário) │  ingestor  (SEM domínio)  │  tem credencial do Metabase
                 │  - deriva eventos (Mongo) │────► Metabase → Mongo (prod, read-only)
                 │  - upsert no Postgres     │
                 │  - dispara webhook diário │────► URL do cliente (HMAC)
                 └────────────┬──────────────┘
                              │ grava
                     ┌────────▼─────────┐
                     │  Postgres (Railway)         │  só eventos do cliente (PII: telefone)
                     └────────▲─────────┘
                              │ lê (só leitura)
                 ┌────────────┴──────────────┐
   (público)     │  api  (domínio público)   │  SEM credencial de produção
                 │  - painel (opção C)       │  env: DATABASE_URL + API_TOKEN
                 │  - GET /api/eventos        │
                 └───────────────────────────┘
```

- **`ingestor`**: serviço sem domínio público. Env: `DATABASE_URL`, `METABASE_URL/USER/PASS`,
  `LOOKBACK_DAYS`, `CLIENT_WEBHOOK_URL?`, `CLIENT_WEBHOOK_SECRET?`. Roda via **Railway Cron**
  (~06:00 BRT = 09:00 UTC). Também aceita modo `--backfill <data-inicial>`.
- **`api`**: serviço público (o domínio atual). Env: `DATABASE_URL`, `API_TOKEN`. **Sem Metabase.**
  Serve o painel e a API de leitura, lendo **exclusivamente** do Postgres.
- **`Postgres`**: plugin gerenciado do Railway. Contém só os eventos mínimos do cliente.

Se a `api` for comprometida, o atacante alcança **apenas** os eventos do cliente — nunca o
banco inteiro da plataforma.

## 6. Ingestão (o coração)

Uma função central **`deriveEvents(startDate, endDate)`** roda uma única agregação no Mongo
que retorna, por conversa na janela: `conversation_id`, `bot`, `phone (external_id)`,
`disparo_ts (created_at)`, `resposta_ts (min da 1ª msg real, ou null)`.

O `ingestor` faz **upsert idempotente** no Postgres:
- sempre grava o evento **disparo**;
- grava **resposta** se `resposta_ts` não for nulo.
- Chave natural (única): `(conversation_id, etapa)` → rodar de novo **atualiza**, não duplica.

**Janela diária:** reprocessa conversas com `created_at` nos últimos `LOOKBACK_DAYS`
(padrão **30**). Isso captura, de forma natural: (a) disparos novos e (b) **respostas tardias**
que chegaram desde a última rodada. Como é upsert, reprocessar é seguro.

**Backfill:** mesma função, varrendo o histórico completo em **blocos mensais**, uma vez.

## 7. Contrato da API (pull)

```
GET /api/eventos?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&segment=novos|recorrentes|ambos
                 &etapa=disparo|resposta|todas&format=json|csv&limit=&offset=
Header: Authorization: Bearer <API_TOKEN>
```

- **Auth:** token no header. Sem token / inválido → `401`.
- **Período:** padrão = últimos **30 dias**; teto = **180 dias** (janela maior → `400`).
- **Paginação (json):** `limit` (padrão 1000, máx 5000) + `offset`. Resposta inclui `total`.
- **CSV:** download completo do período (stream), colunas `timestamp,segmento,etapa,telefone`.
- **Rate limit:** modesto (ex.: 60 req/min e/ou 500 req/dia por token) → excedeu = `429`.

Resposta JSON:
```json
{
  "period": { "startDate": "...", "endDate": "..." },
  "total": 1656,
  "events": [
    { "timestamp": "2026-07-06T09:02:11-03:00", "segmento": "Welcome Novos",
      "etapa": "disparo", "telefone": "55..." }
  ]
}
```

Endpoint auxiliar do painel: `GET /api/funil?startDate&endDate&segment` → contagens agregadas
(totais do funil **e a série diária** por bot, para os gráficos atuais), calculadas via SQL
sobre o store. Substitui o `/api/disparos` atual (que hoje lê o Metabase ao vivo) — assim os
gráficos diários continuam funcionando, mas a credencial some da superfície pública.

## 8. Contrato do Webhook (push, diário, opcional)

Após a ingestão diária, se `CLIENT_WEBHOOK_URL` estiver configurada, o `ingestor` faz `POST`
com os eventos do **dia anterior** (lidos do Postgres):

- Corpo: `{ date, funil: { disparos, respostas, taxa }, events: [...] }` (mesmos campos da API).
- Assinatura: header `X-Signature: sha256=<HMAC(secret, body)>` para o cliente validar.
- **Retry:** até 3 tentativas com backoff; falha é logada e **não derruba** a ingestão.
- Sem `CLIENT_WEBHOOK_URL` → simplesmente não dispara (não bloqueia nada).

## 9. Painel (opção C)

`dashboard/index.html` ganha, além dos gráficos diários atuais (agora servidos do Postgres):
- **Funil** no topo: Disparo → Resposta com contagem e **taxa/queda**; 3º estágio tracejado ("Fase 2").
- **Tabela de eventos** embaixo: `data/hora · segmento · etapa` (+ telefone), paginada.
- **Exportar CSV** (usa `/api/eventos?format=csv`).
- Reaproveita os filtros existentes de **período** e **segmento**.

## 10. Estrutura de código (mudanças no repo)

```
src/
├── metabase-client.ts     # (existe) usado SÓ pelo ingestor agora
├── events.ts              # NOVO: deriveEvents() — agregação Mongo por conversa
├── db.ts                  # NOVO: pool Postgres + upsert/leitura de eventos
├── ingest.ts              # NOVO: entrypoint do ingestor (diário + --backfill + webhook)
├── webhook.ts             # NOVO: monta payload + assina (HMAC) + POST com retry
├── server.ts              # api pública: /api/eventos, /api/funil, painel, auth, rate-limit
└── queries/disparos.ts    # (existe) lógica de agregação — refatorada p/ events.ts
migrations/
└── 001_init.sql           # NOVO: tabela events + índices
dashboard/index.html       # + funil, tabela, CSV
```

Tabela `events`: `conversation_id (text)`, `etapa (text)`, `ts (timestamptz)`,
`bot (int)`, `telefone (text)`, `PRIMARY KEY (conversation_id, etapa)`,
índices em `(ts)` e `(bot, ts)`.

## 11. Erros e resiliência

- **Ingestor:** Metabase fora → loga e sai com código ≠ 0 (idempotente, próxima rodada corrige).
  Upsert por bloco em transação. Backfill é retomável (por bloco mensal).
- **API:** Postgres fora → `503`; token inválido → `401`; período inválido → `400`; excesso → `429`.
- **Webhook:** cliente inacessível → retry+backoff, loga, não afeta a ingestão.

## 12. Testes

- **Unit:** `deriveEvents` (fixture/consulta conhecida), formatação CSV, assinatura HMAC,
  helpers de fuso (Brasília) e validação de período.
- **Integração:** ingest → Postgres → leitura via API; **idempotência** (rodar 2x = 0 duplicatas);
  **resposta tardia** (resposta chega depois do disparo, em rodada posterior).
- **E2E / regressão:** rodar backfill num intervalo pequeno e conferir contra números reais já
  conhecidos (ex.: 05/07 Novos 339/87, Recorrentes 40/13) — oráculo de sanidade.

## 13. Fases

- **Fase 1 (esta):** Postgres + ingestor (backfill+diário) + api (pull + painel C) + webhook.
  Eventos: **disparo + resposta**. Topologia Nível 2.
- **Fase 2 (depois):** etapa **"direcionado ao vendedor"** — só um novo valor de `etapa`
  (aditivo, não quebra contrato), assim que o sinal for confirmado na fonte
  (candidatos: `automation_paused` / `tags` / `steps_occurred` / uma function do fluxo).

## 14. Itens em aberto (para o time / cliente)

1. **URL + segredo do webhook** do cliente (dependência externa; webhook fica desligado até vir).
2. **Sinal do transbordo** (Fase 2) — qual campo representa "direcionado ao vendedor".
3. **Expor `nome`?** Padrão: **não** (minimiza PII). Ligar se o cliente pedir.
4. **Confirmar defaults:** período padrão 30d / teto 180d; rate limit 60/min · 500/dia.
5. **LGPD:** o store e a API passam a conter telefone (PII). Acesso restrito ao cliente
   (token + HMAC + HTTPS). Registrar a base legal do compartilhamento no lado do negócio.
