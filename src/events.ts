// Derivação de eventos do funil a partir do MongoDB (via Metabase, database 3).
//
// Um "evento" é uma linha do log: { conversation_id, etapa, ts, bot, telefone }.
//   - Disparo  = conversa criada pelo bot        -> ts = conversations.created_at
//   - Resposta = 1ª mensagem REAL do cliente     -> ts = min(message_history_bases.created_at
//                (role="user", is_span=false))         das mensagens reais daquela conversa)
//
// O telefone vem de conversations.external_id (número WhatsApp, verificado: começa com 55).
// Usado SÓ pelo ingestor (a superfície pública nunca toca no Metabase).
//
// ATENÇÃO: o "Novo Agente" NÃO vem daqui — a fonte dele é o worker payload-sink
// (ver src/agente.ts). Este arquivo cuida só dos bots que existem no Mongo.
import { AGENTE_BOT, AGENTE_LABEL } from './agente';

export const MONGO_DB = 3;

// Segmentos do painel. `fonte` diz de onde os dados vêm:
//   mongo  -> conversas da plataforma (bots de Welcome do cliente, workspace do cliente)
//   sink   -> D1 do worker payload-sink (novo agente; ver src/agente.ts)
//   fluxos -> worker fluxos-worker + respostas do sink (ver src/fluxos.ts)
export const SEGMENTS = {
  novos: { bot: 1201, label: 'Welcome Novos', produto: 'welcome', fonte: 'mongo' },
  recorrentes: { bot: 1200, label: 'Welcome Recorrentes', produto: 'welcome', fonte: 'mongo' },
  carrinho: { bot: 185, label: 'Carrinho (antigo)', produto: 'carrinho', fonte: 'mongo' },
  agente: { bot: AGENTE_BOT, label: AGENTE_LABEL, produto: 'agente', fonte: 'sink' },
  fluxo_welcome: { bot: 9101, label: 'Welcome', produto: 'welcome', fonte: 'fluxos' },
  welcometof: { bot: 9102, label: 'Welcome TOF', produto: 'welcometof', fonte: 'fluxos' },
  fluxo_carrinho: { bot: 9103, label: 'Carrinho Abandonado', produto: 'carrinho', fonte: 'fluxos' },
  upsell: { bot: 9104, label: 'Up-sell', produto: 'upsell', fonte: 'fluxos' },
  pageview: { bot: 9105, label: 'PageView', produto: 'pageview', fonte: 'fluxos' },
} as const;

export type SegmentKey = keyof typeof SEGMENTS;

/** Só os bots que existem no Mongo — é o que o pipeline de conversas consulta. */
export const BOT_IDS = Object.values(SEGMENTS).filter((s) => s.fonte === 'mongo').map((s) => s.bot);

/** Mapa bot_id -> chave do segmento. */
export const BOT_TO_SEGMENT: Record<number, SegmentKey> = {
  1201: 'novos',
  1200: 'recorrentes',
  185: 'carrinho',
  [AGENTE_BOT]: 'agente',
  9101: 'fluxo_welcome',
  9102: 'welcometof',
  9103: 'fluxo_carrinho',
  9104: 'upsell',
  9105: 'pageview',
};

/** Rótulo amigável do segmento a partir do bot (o que vai exposto na API). */
export function segmentLabel(bot: number): string {
  const key = BOT_TO_SEGMENT[bot];
  return key ? SEGMENTS[key].label : `bot ${bot}`;
}

// Etapas do funil. 'vendedor' fica pré-declarado para a Fase 2 (transbordo),
// mas NÃO é gerado ainda — a derivação só produz disparo/resposta.
export type Etapa = 'disparo' | 'resposta' | 'vendedor';

/** Uma conversa já reduzida aos instantes que interessam. */
export interface ConversationDerived {
  conversation_id: string;
  bot: number;
  telefone: string | null;
  disparo_ts: string; // ISO
  resposta_ts: string | null; // ISO ou null se o cliente nunca respondeu
}

/** Uma linha do log de eventos (o que vai pro Postgres). */
export interface EventRow {
  conversation_id: string;
  etapa: Etapa;
  ts: string; // ISO
  bot: number;
  telefone: string | null;
}

// O cliente trabalha no fuso de Brasília (UTC-3, sem horário de verão).
// Meia-noite de Brasília = 03:00 UTC.
const BR_OFFSET = 'T03:00:00.000Z';

/** Soma 1 dia a uma data 'YYYY-MM-DD' (aritmética em UTC). */
export function nextDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Pipeline de agregação: para cada conversa (disparo) no intervalo [startDate, endDate]
 * (dias de Brasília, inclusivo), retorna o instante do disparo, o telefone e o instante
 * da primeira resposta real do cliente (ou null).
 */
export function deriveConversationsPipeline(
  startDate: string, endDate: string, skip = 0, limit = 0,
): any[] {
  const startUtc = `${startDate}${BR_OFFSET}`;
  const endUtc = `${nextDay(endDate)}${BR_OFFSET}`;
  // O Metabase corta o resultado em 2000 linhas. Como retornamos 1 linha por CONVERSA,
  // semanas cheias estouram esse teto — por isso paginamos (sort estável + skip/limit).
  const pagination = limit > 0 ? [{ $skip: skip }, { $limit: limit }] : [];

  return [
    {
      $match: {
        current_organization_id: { $in: BOT_IDS },
        created_at: { $gte: { $date: startUtc }, $lt: { $date: endUtc } },
      },
    },
    { $sort: { _id: 1 } },
    ...pagination,
    // Instante da 1ª mensagem real do cliente naquela conversa (se houver).
    {
      $lookup: {
        from: 'message_history_bases',
        let: { cid: '$_id' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$conversation_id', '$$cid'] },
                  { $eq: ['$role', 'user'] },
                  { $eq: ['$is_span', false] },
                ],
              },
            },
          },
          { $group: { _id: null, first: { $min: '$created_at' } } },
        ],
        as: 'reply',
      },
    },
    {
      $project: {
        _id: 0,
        conversation_id: { $toString: '$_id' },
        bot: '$current_organization_id',
        telefone: '$external_id',
        disparo_ts: '$created_at',
        resposta_ts: { $ifNull: [{ $arrayElemAt: ['$reply.first', 0] }, null] },
      },
    },
  ];
}

/** Achata as conversas derivadas em linhas de evento (1 disparo + 0/1 resposta cada). */
export function toEventRows(conversas: ConversationDerived[]): EventRow[] {
  const rows: EventRow[] = [];
  for (const c of conversas) {
    rows.push({
      conversation_id: c.conversation_id,
      etapa: 'disparo',
      ts: c.disparo_ts,
      bot: c.bot,
      telefone: c.telefone,
    });
    if (c.resposta_ts) {
      rows.push({
        conversation_id: c.conversation_id,
        etapa: 'resposta',
        ts: c.resposta_ts,
        bot: c.bot,
        telefone: c.telefone,
      });
    }
  }
  return rows;
}
