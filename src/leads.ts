// Leads por vendedor — portado do leads-metrics e ligado ao bot de origem.
//
// Fonte: PostgreSQL de produção (Metabase db 2), tabela `user_conversations`.
// Um "lead" = uma conversa atribuída a um vendedor humano do cliente.
// A coluna `user_conversations.conversation_id` casa com `conversations._id` (Mongo),
// de onde tiramos o bot (`current_organization_id`) — é o elo lead → bot.
// Verificado em 2026-07-15: 100% dos leads casaram com uma conversa.
//
// Usado SÓ pelo ingestor e pelo modo "ao vivo" (a superfície pública nunca toca no Metabase).
import type { MetabaseClient } from './metabase-client';
import { MONGO_DB } from './events';

// Contas do cliente na plataforma (mesma constante do leads-metrics).
export const CLIENT_ACCOUNT_IDS = '(101, 102, 103)'; // ids de exemplo — os reais ficam fora do repositório público

/** Uma linha agregada por (vendedor, dia, bot) — o que vai pro store e alimenta o painel. */
export interface LeadDaily {
  vendedor_id: number;
  vendedor_nome: string;
  dia: string; // 'YYYY-MM-DD' (dia de Brasília)
  bot: number; // bot de origem; 0 = desconhecido / fora dos bots do painel
  total: number;
}

/** Saída da API: total por vendedor no período (barras). */
export interface LeadVendorRow {
  vendedor_id: number;
  vendedor_nome: string;
  total: number;
}

/** Saída da API: série diária por vendedor (linha). */
export interface LeadDailyRow {
  day: string; // 'YYYY-MM-DD'
  vendedor_nome: string;
  total: number;
}

const BR_CREATED = "(uc.created_at - INTERVAL '3 hours')";

/**
 * SQL nativo (PostgreSQL) que devolve UMA LINHA POR LEAD (conversa direcionada a um vendedor),
 * com o vendedor, o `conversation_id` (elo com o Mongo) e o dia de Brasília. Paginável.
 */
export function leadsRawSql(startDate: string, endDate: string, skip = 0, limit = 0): string {
  const pag = limit > 0 ? `OFFSET ${skip} LIMIT ${limit}` : '';
  return `
    WITH client_users AS (
      SELECT DISTINCT admin_user_id
      FROM admin_user_accesses
      WHERE admin_core_account_id IN ${CLIENT_ACCOUNT_IDS}
    )
    SELECT
      au.id AS vendedor_id,
      au.name AS vendedor_nome,
      uc.conversation_id AS conversation_id,
      (${BR_CREATED})::date AS dia
    FROM user_conversations uc
    INNER JOIN client_users mu ON mu.admin_user_id = uc.admin_user_id
    INNER JOIN admin_users au ON au.id = uc.admin_user_id
    WHERE uc.conversation_id IS NOT NULL
      AND ${BR_CREATED} >= '${startDate}'
      AND ${BR_CREATED} < '${endDate}'::date + INTERVAL '1 day'
    ORDER BY uc.id ASC
    ${pag}
  `;
}

interface RawLead { vendedor_id: number; vendedor_nome: string; conversation_id: string; dia: string; }

/**
 * Deriva os leads agregados por (vendedor, dia, bot) para o período.
 * 1) puxa os leads do PostgreSQL (paginado, pra não bater no teto de 2000 do Metabase);
 * 2) descobre o bot de cada lead casando o `conversation_id` com o Mongo;
 * 3) agrega. Usado pelo ingestor (grava no store) e pelo modo "ao vivo".
 */
export async function deriveLeads(
  client: MetabaseClient, startDate: string, endDate: string,
): Promise<LeadDaily[]> {
  const pgDb = parseInt(process.env.METABASE_DB_PG || '2', 10);
  const PAGE = 1500; // < teto de 2000 do Metabase

  // 1) leads crus (paginado)
  const raw: RawLead[] = [];
  let skip = 0;
  for (;;) {
    const page = await client.querySqlAsObjects<RawLead>(leadsRawSql(startDate, endDate, skip, PAGE), pgDb);
    raw.push(...page);
    if (page.length < PAGE) break;
    skip += PAGE;
  }

  // 2) mapa conversation_id -> bot (via Mongo; todos os bots, inclusive fora do painel)
  const ids = [...new Set(raw.map((r) => String(r.conversation_id)).filter(Boolean))];
  const botOf = new Map<string, number>();
  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const found = await client.queryMongoAsObjects<{ id: string; bot: number }>('conversations', [
      { $match: { $expr: { $in: [{ $toString: '$_id' }, chunk] } } },
      { $project: { _id: 0, id: { $toString: '$_id' }, bot: '$current_organization_id' } },
    ], MONGO_DB);
    for (const r of found) botOf.set(String(r.id), Number(r.bot));
  }

  // 3) agrega por (vendedor, dia, bot). bot 0 = conversa não encontrada / fora dos bots.
  const agg = new Map<string, LeadDaily>();
  for (const r of raw) {
    const cid = String(r.conversation_id);
    const bot = botOf.has(cid) ? botOf.get(cid)! : 0;
    const dia = String(r.dia).slice(0, 10);
    const key = `${r.vendedor_id}|${dia}|${bot}`;
    let row = agg.get(key);
    if (!row) { row = { vendedor_id: Number(r.vendedor_id), vendedor_nome: String(r.vendedor_nome), dia, bot, total: 0 }; agg.set(key, row); }
    row.total++;
  }
  return [...agg.values()];
}
