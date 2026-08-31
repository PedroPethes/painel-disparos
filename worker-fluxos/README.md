# Worker de fluxos (Cloudflare Worker)

A **origem dos disparos** que o painel mostra nas visões de fluxo. Roda na edge
(Cloudflare Workers) e é o elo entre o CRM do cliente e a plataforma de
atendimento no WhatsApp.

> Como no resto do repositório: URLs de produção, ids e nomes de campanha foram
> substituídos por placeholders. A lógica é a real.

## O que ele faz

```
  CRM / automação do cliente
        │  POST (payload do lead, formato varia por origem)
        ▼
  ┌───────────────────────────────────────────────┐
  │                fluxos-worker                  │
  │  1. normaliza o payload (nome/e-mail/fone)    │
  │  2. classifica: cliente novo ou recorrente?   │
  │     (HubSpot; fallback via service binding)   │
  │  3. resolve a rota pelo campo `fluxo`         │
  │  4. injeta UTMs no link de checkout (carrinho)│
  │  5. encaminha ao webhook do fluxo certo       │
  │  6. registra tudo no D1 (fluxos_logs)         │
  └──────────────┬────────────────────┬───────────┘
                 │ webhook            │ GET /export (token)
                 ▼                    ▼
      plataforma de atendimento    painel de Disparos & Respostas
          (dispara WhatsApp)         (este repositório)
```

## Decisões de projeto

- **Roteamento por tabela** (`src/rotas.js`): cada fluxo (welcome, carrinho
  abandonado, upsell, pageview) aponta para um webhook; o carrinho roteia por
  **tipo de cliente** — novo e recorrente recebem fluxos diferentes. Variantes
  de campanha caem no mesmo webhook por prefixo (`welcometof*`).
- **Classificação novo × recorrente**: busca o contato no HubSpot (por e-mail e
  telefone) e verifica se existe negócio com entrega concluída. Sem token do
  HubSpot, cai num **service binding** para outro worker que sabe classificar.
  Se tudo falhar, assume `novo` — o disparo nunca é bloqueado por erro de
  classificação.
- **Log primeiro, resposta rápida**: o encaminhamento e o log rodam em
  `ctx.waitUntil`, então o CRM recebe `200` sem esperar o webhook. Todo payload
  vira uma linha em `fluxos_logs` (D1) com o status final — é daí que o painel
  lê os disparos.
- **Segurança**: tokens comparados em **tempo constante** (`safeEqual`);
  `/export` e `/logs` exigem token só-leitura; o POST de ingestão pode exigir
  token próprio (`INGEST_TOKEN`). Segredos ficam em `wrangler secret`, nunca no
  código.
- **`?dry_run=1`** simula o fluxo inteiro (classificação + rota) sem disparar
  nada — usado para teste em produção sem efeito colateral.

## Endpoints

| Método | Rota | Para quê |
| --- | --- | --- |
| `POST` | `/` | Ingestão: recebe o lead, classifica, roteia e encaminha |
| `GET` | `/export?tipo=contagem&de=&ate=` | Disparos por dia/fluxo (painel) |
| `GET` | `/export?tipo=disparos&dia=` | Linhas de um dia, paginado (painel) |
| `GET` | `/logs?telefone=&status=` | Consulta de debug no log |
| `GET` | `/health` | Liveness |

## Deploy

```bash
wrangler d1 create fluxos-logs           # cria o banco e preencha o id no wrangler.toml
wrangler d1 execute fluxos-logs --file schema.sql
wrangler secret put HUBSPOT_TOKEN
wrangler secret put METRICS_TOKEN
wrangler deploy
```
