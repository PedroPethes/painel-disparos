# Disparos & Respostas

> **Nota:** este é o espelho público de um projeto real que desenvolvi para um cliente
> (varejo) da empresa onde trabalho. Nome do cliente, URLs de produção, identificadores
> internos e dados pessoais foram removidos ou substituídos por placeholders.

Painel + API de leitura do funil de disparos/respostas dos bots do cliente. Mostra, por
período, quantas conversas o bot iniciou (**disparo**), quantas o cliente respondeu
(**resposta**) e a **taxa**, além de um **log de eventos** (linha a linha, com telefone)
exportável em CSV.

**▶ [Abrir o painel (demonstração)](https://pedropethes.github.io/painel-disparos/)** — o
painel de verdade rodando no navegador com dados fictícios: todas as visões, filtros,
gráficos, paginação e exportação em CSV funcionam, sem instalar nada.

Cada produto é uma **visão separada** no painel (sem misturar os funis):

| Visão | Bot (id sintético) | Fonte dos disparos | Fonte das respostas |
| --- | --- | --- | --- |
| **Welcome** | `9101` | worker de fluxos (D1) | worker payload-sink (D1) |
| **Welcome TOF** | `9102` | worker de fluxos (D1) | worker payload-sink (D1) |
| **Carrinho Abandonado** | `9103` | worker de fluxos (D1) | worker payload-sink (D1) |
| **Up-sell** | `9104` | worker de fluxos (D1) | worker payload-sink (D1) |
| **PageView** | `9105` | worker de fluxos (D1) | worker payload-sink (D1) |
| **Disparos** | `9001` | worker payload-sink (D1) | worker payload-sink (D1) |

> **Nenhuma visão atual passa pelo Mongo da plataforma.** As cinco visões de fluxo vêm do
> [worker de fluxos](./worker-fluxos/) — que classifica o cliente como novo ou recorrente
> e roteia cada disparo para o webhook do fluxo certo (ver [Fluxos](#fluxos-welcome-welcome-tof-carrinho-up-sell-pageview)).
> A visão **Disparos** vem do worker `payload-sink`, alimentado pelo CRM (ver
> [Disparos](#disparos-fonte-separada)).

**Histórico no Mongo.** Os bots antigos de Welcome (`1201` novos, `1200` recorrentes) e o
Carrinho antigo (`185`) rodavam na plataforma e foram derivados do Mongo. Eles saíram do
seletor do painel, mas o histórico continua no Postgres e acessível pela API
(`segment=novos|recorrentes|ambos|carrinho_antigo`) — por isso o ingestor do Metabase
segue documentado abaixo.

Projeto independente do dashboard de leads (`leads-metrics`).

---

## Arquitetura & integrações

```
  CRM do cliente                        MongoDB da plataforma (histórico)
     │                                        │  via Metabase API (read-only, db 3)
     ▼                                        │
  worker de fluxos ──► WhatsApp               │
  worker payload-sink ──► WhatsApp            │
     │  D1: disparos e respostas              │
     │  (GET /export, token só-leitura)       │
     ▼                                        ▼
  ┌──────────────────────────────────────────────────┐
  │                    ingestor                       │  deriva eventos e faz
  │                 (src/ingest.ts)                   │  UPSERT idempotente
  └───────────────────────┬───────────────────────────┘
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

- **Fontes atuais:** os dois **workers Cloudflare** (fluxos e payload-sink), lidos pelo
  `GET /export` com token só-leitura. O worker de fluxos está neste repositório, em
  [`worker-fluxos/`](./worker-fluxos/).
- **Fonte do histórico:** MongoDB da plataforma, consultado via **Metabase API** (`/api/session`
  + `/api/dataset`, aggregation pipeline) com uma conta **read-only**. Só o `ingestor` fala com
  o Metabase.
- **Store:** **Postgres** guardando apenas os eventos do cliente (espelho derivado). A superfície
  pública (API/painel) lê **só** do Postgres — nunca do Metabase.
- **Deploy atual:** **serviço único** no Railway — a API e a ingestão diária rodam no mesmo
  processo (`INGEST_IN_PROCESS=1`). O passo a passo (e a variante de **dois serviços**, que tira
  a credencial do Metabase da superfície pública) está em [`DEPLOY.md`](./DEPLOY.md).

> **Por que um store?** O MongoDB não é exposto ao cliente; a API entrega só o mínimo. Como há
> **telefone (PII)**, o store isola o que é exposto do resto do banco da plataforma.

---

## Lógica (o que é cada número)

- **Disparo** = uma mensagem que o bot enviou para um número. Cada fonte define isso de um
  jeito (ver as seções abaixo): nos **fluxos** é uma linha `status='sent'` no worker; em
  **Disparos** é um envio com entrega confirmada pela Meta; no **histórico do Mongo** era uma
  conversa criada pelo bot (`conversations.created_at`).
- **Resposta** = o cliente respondeu àquele disparo. Nos fluxos e em Disparos, qualquer
  mensagem recebida daquele número em até **72h**; no histórico do Mongo, a 1ª mensagem
  **real** do cliente na conversa (`message_history_bases` com `role="user"` e `is_span=false`
  — follow-up automático do bot não conta).
- **Telefone** — o elo entre disparo e resposta, comparado **sem o nono dígito**.
- **Taxa de resposta** = respostas ÷ disparos.
- **Fuso:** tudo em **Brasília (UTC−3)**; a meia-noite BR é 03:00 UTC.

### Duas semânticas (importante)

| Visão | Como conta | Onde aparece |
| --- | --- | --- |
| **Funil / taxa** | por **coorte do disparo**: a resposta é atribuída ao **dia do disparo** (mesmo que tenha chegado dias depois) | `/api/funil`, cards e gráficos |
| **Log de eventos** | pelo **instante do evento**: a resposta aparece no dia em que **de fato** chegou | `/api/eventos`, tabela, CSV |

Isso mantém a taxa coerente por coorte, e ao mesmo tempo o log cronologicamente fiel.

### Fluxos (Welcome, Welcome TOF, Carrinho, Up-sell, PageView)

As cinco visões de fluxo nascem no [worker de fluxos](./worker-fluxos/) — os bots desses
fluxos não vivem no Mongo da plataforma, então **nada aqui passa pelo Metabase**:

```
  CRM do cliente
        │  POST (lead)
        ▼
  worker de fluxos ──► classifica novo/recorrente (HubSpot)
        │            └► roteia pro webhook do fluxo ──► WhatsApp
        │  D1 fluxos_logs (uma linha por tentativa, com o fluxo e o status)
        ▼
  GET /export?tipo=disparos&dia=..   (token só-leitura)   ─┐
                                                           ├─► ingestor cruza
  worker payload-sink: tabela `respostas` do mesmo número ─┘    por TELEFONE
                                                                    │
                                                                    ▼
                                                    Postgres: events (bot 910x)
```

- **Disparo** = linha do worker com `status='sent'`, já com o **fluxo canônico**
  (`welcome`, `welcometof`, `carrinho`, `upsell`, `pageview`; variações de escrita são
  normalizadas no worker). Fluxo não mapeado (`outro`) fica fora do painel.
- **Resposta** = vem da tabela `respostas` do worker `payload-sink`, porque o inbound do
  número de WhatsApp desses bots cai lá. O cruzamento usa a **mesma regra da visão
  Disparos**: janela de 72h, primeira resposta por disparo, elo pelo telefone.
- **Cruzamento com os fluxos juntos:** se dois fluxos dispararam para o mesmo número, a
  resposta marca só o **disparo mais recente** — senão a mesma resposta contaria uma vez
  em cada fluxo.
- **Bots sintéticos `9101`–`9105`:** cada fluxo recebe um id próprio para caber na tabela
  `events` sem inventar um caminho novo. O volume é de centenas por dia (contra ~15 mil da
  visão Disparos), então aqui **cabe o evento linha a linha** no Postgres — funil e log
  funcionam sem tratamento especial.
- **Histórico:** o worker de fluxos começou a receber disparos reais em **26/08/2026**;
  antes disso as visões aparecem zeradas.

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
| **curta** (`runRefresh`) | só **hoje** (e **ontem** a cada 6 voltas) — fluxos, leads e Disparos | a cada `REFRESH_MIN` (padrão 5 min) |

A rodada curta cobre **todas** as visões. Antes ela existia só para a de Disparos, e as
demais dependiam da diária — na prática o Carrinho passava o dia inteiro parado no número
da manhã (visto em 30/07: painel marcando 103 enquanto o worker já havia mandado 215).

Detalhes de implementação:
- Cada fonte (Metabase, worker de fluxos e payload-sink) falha **em separado** dentro de
  `runRefresh`: uma fora do ar não impede as outras visões de atualizar.
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
  bot             integer,     -- 9101..9105 (fluxos) | 1201, 1200, 185 (histórico Mongo)
  telefone        text,        -- número do WhatsApp — PII
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

**`segment`** — as visões do painel: `welcome` · `welcometof` · `carrinho` · `upsell` ·
`pageview` · `agente` (= Disparos). Histórico dos bots antigos: `novos` · `recorrentes` ·
`ambos` (os dois de Welcome) · `carrinho_antigo`. Vazio = todos.
**`etapa`:** `disparo` · `resposta` · `todas`.
Resposta CSV: colunas `timestamp,segmento,etapa,telefone`.

Com `segment=agente` o log **não** vem do Postgres: é montado na hora a partir do worker
(ver [Disparos](#disparos-fonte-separada)). Como as duas fontes não se misturam numa mesma
paginação, o `segment` vazio (= todos) devolve só o que está no Postgres.

Guia de uso da API (para o cliente): [`docs/guia-api/guia-api.html`](./docs/guia-api/guia-api.html).
Usa `SEU_TOKEN` como placeholder — o token real vai por canal separado.

---

## Painel

`dashboard/index.html` (HTML/CSS/JS puro + Chart.js), servido pela própria API:

- **Portão de token** (a API é protegida; o painel pede o token e guarda no `localStorage`).
- Seletor de **Visão**: *Welcome · Welcome TOF · Carrinho Abandonado · Up-sell · PageView ·
  Disparos*. Na visão **Disparos** o log de eventos é lido do worker na hora (não sai do
  Postgres) e os cards falam em disparo **entregue** (confirmado pela Meta).
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
| `SINK_URL` | ingestor | URL do worker payload-sink (visão Disparos + respostas dos fluxos) |
| `SINK_TOKEN` | ingestor | token só-leitura do worker (`METRICS_TOKEN` lá) |
| `FLUXOS_URL` | ingestor | URL do [worker de fluxos](./worker-fluxos/) (visões Welcome, TOF, Carrinho, Up-sell, PageView) |
| `FLUXOS_TOKEN` | ingestor | token só-leitura do worker de fluxos (`METRICS_TOKEN` lá) |
| `AGENTE_LOOKBACK_DAYS` | ingestor | janela diária da visão Disparos (padrão 5) |
| `FLUXOS_LOOKBACK_DAYS` | ingestor | janela diária das visões de fluxo |
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
Não precisa de banco, Metabase, workers nem token:

```bash
npm install
npm run dev        # http://localhost:3000 — acesso livre, sem token
```

Abre direto no painel, com **as seis visões preenchidas** (Welcome, Welcome TOF,
Carrinho Abandonado, Up-sell, PageView e Disparos): funil, cards, gráficos diários,
tabela de log paginada e exportação em CSV, com 60 dias de histórico.

A lógica de requisições, derivação e agregação é exatamente a mesma dos modos
reais — só a fonte dos dados muda.

### Versão publicada (GitHub Pages)

A [demonstração online](https://pedropethes.github.io/painel-disparos/) é esse mesmo
painel **sem servidor nenhum**: `src/browser-demo.ts` intercepta as chamadas da API no
navegador e responde com as mesmas funções de agregação do modo demo, então a página
publicada não diverge do painel real. Para regerar depois de mexer no painel:

```bash
npm run build:pages   # compila o shim e monta docs/index.html a partir de dashboard/index.html
```

Publicada em **Settings → Pages → Source: `main` / pasta `/docs`**.

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
├── fluxos.ts            # visões de fluxo: lê o worker de fluxos + respostas do sink
├── db.ts                # Postgres: migração, upsert idempotente, leituras (funil/eventos)
├── ingest.ts            # ingestor: janela diária + backfill + webhook (CLI e in-process)
├── webhook.ts           # push diário opcional (HMAC + retry)
├── server.ts            # API pública (token, rate-limit) + painel + agendador in-process
├── demo.ts              # dados fictícios do modo demo (PRNG determinístico)
├── browser-demo.ts      # shim da demo estática: responde à API dentro do navegador
└── types.ts             # tipos
migrations/001_init.sql  # schema (events + leads + agente_diario + ingest_runs)
dashboard/index.html     # painel (opção C: funil + tabela + CSV, por visão)
test/                    # unit + integração (coorte × log, idempotência, resposta tardia)
docs/specs/              # spec de design
docs/index.html          # demo estática publicada no GitHub Pages (gerada)
tools/build-pages.mjs    # monta a demo estática a partir do painel real
worker-fluxos/           # Worker Cloudflare: origem dos disparos das visões de fluxo
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
