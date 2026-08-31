# Disparos & Respostas

> **Nota:** este é o espelho público de um projeto real que desenvolvi para um cliente
> (varejo) da empresa onde trabalho. Nome do cliente, URLs de produção, identificadores
> internos e dados pessoais foram removidos ou substituídos por placeholders.

Painel + API de leitura do funil de disparos/respostas dos bots do cliente. Mostra, por
período, quantas conversas o bot iniciou (**disparo**), quantas o cliente respondeu
(**resposta**) e a **taxa**, além de um **log de eventos** (linha a linha, com telefone)
exportável em CSV.

Cobre três produtos, como **visões separadas** (sem misturar os funis):

| Produto | Segmento | Bot (`current_organization_id`) | Fonte |
| --- | --- | --- | --- |
| **Welcome** | Novos (cliente novo) | `1201` | Mongo (plataforma) |
| **Welcome** | Recorrentes (cliente recorrente) | `1200` | Mongo (plataforma) |
| **Carrinho Abandonado** | — | `185` | Mongo (plataforma) |
| **Disparos** | — | `9001` (id sintético) | worker payload-sink (D1) |

> A visão **Disparos** é a única que **não** passa pelo Mongo da plataforma: os disparos
> nascem no HubSpot, passam pelo worker `payload-sink` e ficam no D1
> `payloads`. No Postgres fica só o **resumo por dia**; o log linha a linha é
> lido do worker **na hora**, e não há leads por vendedor — ver
> [Disparos](#disparos-fonte-separada).

Projeto independente do dashboard de leads (`leads-metrics`).

---

## Arquitetura & integrações

```
  MongoDB de produção da plataforma           (fonte da verdade — não é limpo)
        │   (via Metabase API, conta read-only, database 3)
        ▼
  ┌─────────────────┐   ingestão diária + backfill
  │    ingestor      │   deriva eventos e faz UPSERT idempotente
  │  (src/ingest.ts) │────────────────────────────────►┐
  └─────────────────┘                                   │
                                                        ▼
                                            ┌──────────────────────┐
                                            │  Postgres (events)    │  store isolado,
                                            │  só eventos do cliente│  só o mínimo (+telefone)
                                            └──────────┬───────────┘
                                                       │ lê
                                            ┌──────────▼───────────┐
                                            │  API + painel         │  token + rate-limit
                                            │  (src/server.ts)      │  /api/funil, /api/eventos
                                            └──────────────────────┘
```

- **Fonte:** MongoDB da plataforma, consultado via **Metabase API** (`/api/session` + `/api/dataset`,
  aggregation pipeline) com uma conta **read-only**. Só o `ingestor` fala com o Metabase.
- **Store:** **Postgres** guardando apenas os eventos do cliente (espelho derivado). A superfície
  pública (API/painel) lê **só** do Postgres — nunca do Metabase.
- **Deploy atual:** **serviço único** no Railway — a API e a ingestão diária rodam no mesmo
  processo (`INGEST_IN_PROCESS=1`). O passo a passo (e a variante de **dois serviços**, que tira
  a credencial do Metabase da superfície pública) está em [`DEPLOY.md`](./DEPLOY.md).

> **Por que um store?** O MongoDB não é exposto ao cliente; a API entrega só o mínimo. Como há
> **telefone (PII)**, o store isola o que é exposto do resto do banco da plataforma.

---

## Lógica (o que é cada número)

- **Disparo** = conversa criada pelo bot → `conversations.created_at` (1 disparo por conversa).
- **Resposta** = a conversa tem ≥1 mensagem **real** do cliente
  (`message_history_bases` com `role="user"` e `is_span=false`). Follow-ups automáticos do bot
  (`role="assistant"`) **não** contam. `ts` da resposta = instante da 1ª mensagem real.
- **Telefone** = `conversations.external_id` (número do WhatsApp; começa com `55`).
- **Taxa de resposta** = respostas ÷ disparos.
- **Fuso:** tudo em **Brasília (UTC−3)**; a meia-noite BR é 03:00 UTC.

### Duas semânticas (importante)

| Visão | Como conta | Onde aparece |
| --- | --- | --- |
| **Funil / taxa** | por **coorte do disparo**: a resposta é atribuída ao **dia do disparo** (mesmo que tenha chegado dias depois) | `/api/funil`, cards e gráficos |
| **Log de eventos** | pelo **instante do evento**: a resposta aparece no dia em que **de fato** chegou | `/api/eventos`, tabela, CSV |

Isso mantém a taxa coerente por coorte, e ao mesmo tempo o log cronologicamente fiel.

### Disparos (fonte separada)

Os disparos desse agente **não** viram conversa no Mongo — eles vivem no D1 do worker
`payload-sink`:

```
  HubSpot ──► worker payload-sink ──► WhatsApp (plataforma)
                    │  D1 payloads
                    │    payloads   (disparos enviados)
                    │    respostas  (mensagens recebidas do cliente)
                    ▼
              GET /export  (token só-leitura METRICS_TOKEN)
                ?tipo=disparos|respostas|entregas&dia=..  -> linhas de um dia
                ?tipo=contagem&de=&ate=            -> quantos por dia
                    │
        ┌───────────┴────────────┐
        ▼                        ▼
  ingestor (1x/dia)        API, a cada request
  cruza por TELEFONE       log de eventos AO VIVO
        ▼                        ▼
  Postgres: agente_diario   /api/eventos?segment=agente
  (1 linha por dia)         (nada é guardado)
```

- **Disparo** = número que recebeu de fato: payload `processed` **cujo telefone teve entrega
  confirmada (`delivered`) pela Meta** a partir do instante do disparo, procurando no dia e
  no dia seguinte. Conta **um por número**, não por mensagem (o mesmo número disparado 2x no
  dia é 1 disparo). Em 27/07, por exemplo: 8.508 payloads → 8.462 números → **7.291 entregues**.
  Não dá pra ligar payload↔entrega por id (o worker não guarda o id da mensagem no provedor),
  por isso o elo também aqui é o telefone.
  ⚠️ Não confundir com "todos os `delivered` do dia" (8.307 em 27/07): aquilo inclui a entrega
  das mensagens da conversa (respostas da IA/vendedor), não só a do disparo.
- **Resposta** = qualquer mensagem recebida daquele número em até **72h** — inclusive o
  clique no botão *Acessar* do template (hoje ~metade das respostas).
- **Cruzamento:** não existe id em comum entre disparo e resposta, então o elo é o telefone.
  Cada resposta marca o **disparo mais recente** feito àquele número antes dela (dentro das
  72h) e cada disparo guarda a **primeira** resposta que casar — assim ninguém conta duas vezes.
  O telefone é comparado **sem o nono dígito**, porque a Meta devolve números antigos sem ele.
- **No banco fica só o resumo do dia** (`agente_diario`): são ~15 mil disparos/dia e o disco
  do Postgres no Railway é de 500 MB — guardar linha a linha encheria o disco em ~2 meses.
- **O log de eventos é ao vivo:** `/api/eventos?segment=agente` monta a página na hora lendo
  o worker. Pra saber o total e em que dia a página começa sem baixar o período inteiro, usa
  os **disparos por dia já resumidos** (`agente_diario` — contar entrega a cada clique seria
  caro) e as **respostas por dia** do `?tipo=contagem`; só então baixa o(s) dia(s) daquela
  página. Dia recente ainda sem resumo é contado ao vivo. Cache de 5 min (máx. 3 dias
  em memória).
- **Histórico:** as payloads existem desde **07/07/2026**, mas a **confirmação de entrega só
  a partir de 13/07** e as **respostas a partir de 16/07** (antes disso o worker não recebia
  esses eventos) — então 07 a 12/07 aparecem zerados e a taxa antes de 16/07 é falsa.
- **Atualização:** ver "Atualização de 5 em 5 minutos" abaixo — vale para **todas** as visões.

### Atualização de 5 em 5 minutos (todas as visões)

Duas rodadas convivem, e as duas contam dia de **Brasília**:

| Rodada | O quê | Quando |
| --- | --- | --- |
| **diária** (`runDailyIngest`) | `LOOKBACK_DAYS` (30) — pega resposta atrasada e corrige histórico | no boot + a cada 24h |
| **curta** (`runRefresh`) | só **hoje** (e **ontem** a cada 6 voltas) — Welcome, Carrinho, leads e Disparos | a cada `REFRESH_MIN` (padrão 5 min) |

A rodada curta cobre as **quatro** visões. Antes ela existia só para a de Disparos, e os
bots do Mongo (Welcome e Carrinho) dependiam da diária — na prática o Carrinho passava o
dia inteiro parado no número da manhã (visto em 30/07: painel marcando 103 enquanto o
worker já havia mandado 215).

Detalhes de implementação:
- As duas fontes (Metabase e worker) falham **em separado** dentro de `runRefresh`: o
  Metabase fora do ar não impede a visão de Disparos de atualizar, e vice-versa.
- Se uma rodada demora mais que o intervalo, a volta seguinte é **pulada** em vez de
  empilhar (log: `rodada anterior ainda em curso`).
- O **painel** também se atualiza sozinho a cada 5 min (`autoRefresh` no `index.html`),
  preservando período, visão e página do log; a hora da última atualização aparece ao lado
  do botão Pesquisar. Aba em segundo plano não busca — atualiza ao voltar pra tela.
- `REFRESH_MIN` é o nome novo; `AGENTE_REFRESH_MIN` continua sendo aceito (é o que já está
  configurado no Railway).

### Fuso: tudo é dia de Brasília (UTC-3)

Servidor e painel usam o mesmo critério — meia-noite de Brasília = 03:00 UTC:
`events.ts` (`BR_OFFSET`), `db.ts` (`rangeUtc`, `TS_BR`, `AT TIME ZONE 'America/Sao_Paulo'`),
`ingest.ts`/`agente.ts` (`brToday`/`hojeBr`) e, no `dashboard/index.html`, `brToday()`.

⚠️ O painel calculava "hoje" com `toISOString()` puro, que é **UTC**: das **21h à
meia-noite** ele abria já no dia seguinte (vazio), e para quem abrisse de outro fuso o
período vinha errado. Corrigido em 30/07 — se mexer nas datas do front, use `brToday()` /
`shiftDay()`, nunca `new Date()` cru.

### Detalhe: teto de 2000 do Metabase

O Metabase corta cada consulta em **2000 linhas**. Como a derivação retorna **1 linha por
conversa**, semanas cheias estouram esse teto. Por isso o ingestor **pagina** (ordena por `_id`
e busca em blocos de 1500) — senão dias de pico viriam truncados.

---

## Banco de dados (Postgres)

Migração idempotente em [`migrations/001_init.sql`](./migrations/001_init.sql).

```sql
events (
  conversation_id text,        -- chave interna de dedup; NUNCA exposta na API
  etapa           text,        -- 'disparo' | 'resposta'  (| 'vendedor' na Fase 2)
  ts              timestamptz, -- instante do evento (UTC)
  bot             integer,     -- 1201 | 1200 | 185
  telefone        text,        -- external_id (WhatsApp) — PII
  PRIMARY KEY (conversation_id, etapa)   -- upsert idempotente por (conversa, etapa)
)
agente_diario (
  dia       date PRIMARY KEY,   -- dia de Brasília
  disparos  integer,            -- disparos daquele dia (visão Disparos)
  respostas integer             -- quantos deles o cliente respondeu (coorte)
)
ingest_runs (...)              -- observabilidade das rodadas (kind, janela, contagens, tempo)
```

A ingestão faz `INSERT ... ON CONFLICT (conversation_id, etapa) DO UPDATE` — rodar de novo
**atualiza, não duplica**. A janela diária reprocessa os últimos `LOOKBACK_DAYS` (padrão 30),
o que também captura **respostas tardias**.

---

## API

Autenticação: header `Authorization: Bearer <API_TOKEN>` (ou `?token=` para links de CSV).
Período padrão: últimos 30 dias; teto 180. Rate limit: 60 req/min e 500 req/dia por token.

### `GET /api/funil?startDate&endDate&segment`
Contagens agregadas: totais do funil **e** série diária por bot (coorte). Alimenta cards e gráficos.

### `GET /api/eventos?startDate&endDate&segment&etapa&format&limit&offset`
Log de eventos (por instante). `format=json` (paginado) ou `format=csv`.

**`segment`:** `novos` · `recorrentes` · `ambos` (= só Welcome) · `carrinho` · `agente` · vazio (= todos).
**`etapa`:** `disparo` · `resposta` · `todas`.
Resposta CSV: colunas `timestamp,segmento,etapa,telefone`.

Com `segment=agente` o log **não** vem do Postgres: é montado na hora a partir do worker
(ver [Disparos](#disparos-fonte-separada)). Como as duas fontes não se misturam numa mesma
paginação, o `segment` vazio (= todos) segue devolvendo só os bots que vêm do Mongo.

Guia de uso da API (para o cliente): [`docs/guia-api/guia-api.html`](./docs/guia-api/guia-api.html).
Usa `SEU_TOKEN` como placeholder — o token real vai por canal separado.

---

## Painel

`dashboard/index.html` (HTML/CSS/JS puro + Chart.js), servido pela própria API:

- **Portão de token** (a API é protegida; o painel pede o token e guarda no `localStorage`).
- Seletor de **Visão**: *Welcome (ambos) · Welcome Novos · Welcome Recorrentes · Carrinho
  Abandonado · Disparos*. Na visão **Disparos** somem os leads por vendedor (não existem
  pra ela) e aparece uma nota explicando de onde vêm os números; o log de eventos continua,
  só que lido do worker na hora.
- **Funil** (disparo → resposta → *vendedor: fase 2*) + cards + gráficos diários + **tabela de log**
  paginada + **exportar CSV** — tudo respeitando período + visão.

---

## Variáveis de ambiente

| Var | Onde | Para quê |
| --- | --- | --- |
| `DATABASE_URL` | api + ingestor | conexão Postgres |
| `API_TOKEN` | api | token de acesso à API/painel |
| `METABASE_URL` / `METABASE_USER` / `METABASE_PASS` | ingestor | fonte (read-only) |
| `LOOKBACK_DAYS` | ingestor | janela diária reprocessada (padrão 30) |
| `SINK_URL` | ingestor | URL do worker payload-sink (fonte da visão Disparos) |
| `SINK_TOKEN` | ingestor | token só-leitura do worker (`METRICS_TOKEN` lá) |
| `AGENTE_LOOKBACK_DAYS` | ingestor | janela diária da visão Disparos (padrão 5) |
| `REFRESH_MIN` | api | de quantos em quantos minutos refazer o dia de hoje, em TODAS as visões (padrão 5). `AGENTE_REFRESH_MIN` ainda é aceito como nome antigo |
| `INGEST_IN_PROCESS` | api | `1` = roda a ingestão diária no mesmo serviço |
| `CLIENT_WEBHOOK_URL` / `CLIENT_WEBHOOK_SECRET` | ingestor | push diário opcional (HMAC); vazio = desligado |
| `PORT` | api | porta (o Railway injeta) |

---

## Rodar local

### Demonstração rápida (dados fictícios)

Sem nenhuma variável de ambiente o servidor sobe em **modo demo**: painel e API
funcionam com **dados 100% fictícios** gerados em memória por um PRNG determinístico
(`src/demo.ts`) — números, telefones e nomes de vendedores são todos de exemplo.
Não precisa de banco, Metabase nem token:

```bash
npm install
npm run dev        # http://localhost:3000 — acesso livre, sem token
```

A lógica de requisições, derivação e agregação é exatamente a mesma dos modos
reais — só a fonte dos dados muda.

### Modo completo

Pré-requisitos: Node 18+ e um Postgres local.

```bash
npm install

# .env na raiz (exemplo de dev):
#   METABASE_URL=... METABASE_USER=... METABASE_PASS=...
#   DATABASE_URL=postgresql://postgres@localhost:5433/painel_eventos
#   API_TOKEN=dev-local-token   LOOKBACK_DAYS=30   PORT=3000

npm run dev:ingest -- --backfill 2026-06-01   # popula o Postgres a partir da fonte
npm run dev:ingest -- --agente 2026-07-07     # só a visão Disparos (não toca no Metabase)
npm run dev                                   # sobe a API/painel em :3000
npm test                                      # suíte (usa DATABASE_URL local)
```

Scripts: `build` (tsc) · `start` (api) · `ingest` (ingestor prod) · `dev` / `dev:ingest` (tsx) · `test`.

---

## Estrutura

```
src/
├── metabase-client.ts   # cliente Metabase (login + query MongoDB) — usado só pelo ingestor
├── events.ts            # config (segmentos/bots) + derivação Mongo (paginada) + tipos
├── agente.ts            # visão Disparos: lê o worker payload-sink e cruza disparo×resposta
├── db.ts                # Postgres: migração, upsert idempotente, leituras (funil/eventos)
├── ingest.ts            # ingestor: janela diária + backfill + webhook (CLI e in-process)
├── webhook.ts           # push diário opcional (HMAC + retry)
├── server.ts            # API pública (token, rate-limit) + painel + agendador in-process
└── types.ts             # tipos
migrations/001_init.sql  # schema (events + leads + agente_diario + ingest_runs)
dashboard/index.html     # painel (opção C: funil + tabela + CSV, por visão)
test/                    # unit + integração (coorte × log, idempotência, resposta tardia)
docs/specs/              # spec de design
DEPLOY.md                # deploy no Railway (serviço único e variante de 2 serviços)
```

---

## Segurança & LGPD

O store e a API contêm **telefone (dado pessoal)**. O acesso é restrito por `API_TOKEN`
(e HMAC no webhook), sobre HTTPS. O cliente nunca acessa o banco da plataforma — só a API,
que expõe o mínimo. Dado hospedado no Railway (infra nos EUA).

## Fase 2 (pendente)

- **Etapa "direcionado ao vendedor"** (transbordo) — entra como novo valor de `etapa`
  quando o sinal for definido na fonte (candidatos: `automation_paused`, `tags`,
  `steps_occurred` em `conversations`).
- **Backfill do histórico completo** (hoje o store tem os últimos ~30 dias de cada bot).
- **Hardening de dois serviços** (tirar a credencial do Metabase da superfície pública) —
  junto da migração do projeto para um workspace da empresa no Railway.
