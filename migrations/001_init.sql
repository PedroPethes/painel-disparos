-- Store isolado de eventos do funil (Fase 1: disparo, resposta).
-- Contém SÓ o mínimo exposto: quando, qual bot/segmento, etapa e telefone.
-- É idempotente (IF NOT EXISTS) — pode rodar em toda subida.

CREATE TABLE IF NOT EXISTS events (
  conversation_id text        NOT NULL,   -- chave interna de dedup; NUNCA exposta na API
  etapa           text        NOT NULL,   -- 'disparo' | 'resposta' (| 'vendedor' na Fase 2)
  ts              timestamptz NOT NULL,   -- instante do evento (UTC)
  bot             integer     NOT NULL,   -- 1201 (novos) | 1200 (recorrentes)
  telefone        text,                   -- external_id (WhatsApp); PII
  PRIMARY KEY (conversation_id, etapa)    -- upsert idempotente por (conversa, etapa)
);

CREATE INDEX IF NOT EXISTS events_ts_idx     ON events (ts);
CREATE INDEX IF NOT EXISTS events_bot_ts_idx ON events (bot, ts);

-- Leads por vendedor (quantidade de conversas direcionadas a cada vendedor humano do cliente).
-- Fonte: PostgreSQL de produção; agregado por (vendedor, dia, bot) — NÃO guarda dados do cliente.
-- `bot` = bot de origem do lead (via conversation_id -> conversas do Mongo); 0 = desconhecido.
CREATE TABLE IF NOT EXISTS leads (
  vendedor_id   integer NOT NULL,
  dia           date    NOT NULL,          -- dia de Brasília
  bot           integer NOT NULL DEFAULT 0,-- bot de origem (0 = desconhecido / fora do painel)
  vendedor_nome text    NOT NULL,
  total         integer NOT NULL,
  PRIMARY KEY (vendedor_id, dia, bot)       -- upsert idempotente por (vendedor, dia, bot)
);

CREATE INDEX IF NOT EXISTS leads_dia_idx     ON leads (dia);
CREATE INDEX IF NOT EXISTS leads_bot_dia_idx ON leads (bot, dia);

-- Novo agente (fonte: worker payload-sink, NÃO o Mongo da plataforma).
-- Aqui guardamos só o RESUMO DO DIA, não evento por evento: são ~15 mil disparos
-- por dia e o disco do Postgres é pequeno (500 MB). Semântica de coorte, igual ao
-- resto do painel: a resposta é contada no dia do DISPARO.
CREATE TABLE IF NOT EXISTS agente_diario (
  dia       date    PRIMARY KEY,   -- dia de Brasília
  disparos  integer NOT NULL,
  respostas integer NOT NULL
);

-- Observabilidade das rodadas de ingestão (diária / backfill).
CREATE TABLE IF NOT EXISTS ingest_runs (
  id           serial      PRIMARY KEY,
  kind         text        NOT NULL,      -- 'daily' | 'backfill'
  window_start date,
  window_end   date,
  conversas    integer,
  eventos      integer,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
