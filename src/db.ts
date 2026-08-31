// Camada Postgres: o store isolado de eventos.
// A API pública lê SÓ daqui (sem credencial de produção). O ingestor escreve aqui.
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { EventRow, Etapa, nextDay } from './events';
import { AGENTE_BOT, type AgenteDia } from './agente';
import { LeadDaily, LeadVendorRow, LeadDailyRow } from './leads';
import { mode } from './mode';
import { demoFunnel, demoQueryEvents, demoIterEvents, demoLeads } from './demo';
import { liveFunnel, liveQueryEvents, liveIterEvents, liveLeads } from './live';

let _pool: Pool | null = null;

export function pool(): Pool {
  if (!_pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL não configurada');
    _pool = new Pool({ connectionString, max: 5 });
  }
  return _pool;
}

/** Fecha o pool (usado pelos scripts do ingestor para sair limpo). */
export async function endPool(): Promise<void> {
  if (_pool) { await _pool.end(); _pool = null; }
}

/** Aplica o schema (idempotente). Só no modo store (nos outros não há banco). */
export async function migrate(): Promise<void> {
  if (mode() !== 'store') return;
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '001_init.sql'), 'utf8');
  await pool().query(sql);
}

// Limites de um dia de Brasília -> instantes UTC (meia-noite BR = 03:00 UTC).
function rangeUtc(startDate: string, endDate: string): [string, string] {
  return [`${startDate}T03:00:00.000Z`, `${nextDay(endDate)}T03:00:00.000Z`];
}

// Expressão SQL que formata o ts no ISO de Brasília (constante -03:00, sem horário de verão).
const TS_BR = `to_char(ts AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD"T"HH24:MI:SS') || '-03:00'`;

/** Upsert idempotente de eventos, em blocos e numa transação. Retorna quantos gravou. */
export async function upsertEvents(rows: EventRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const CHUNK = 500;
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const values: any[] = [];
      const tuples = chunk.map((r, j) => {
        const b = j * 5;
        values.push(r.conversation_id, r.etapa, r.ts, r.bot, r.telefone);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`;
      });
      await client.query(
        `INSERT INTO events (conversation_id, etapa, ts, bot, telefone)
         VALUES ${tuples.join(',')}
         ON CONFLICT (conversation_id, etapa)
         DO UPDATE SET ts = EXCLUDED.ts, bot = EXCLUDED.bot, telefone = EXCLUDED.telefone`,
        values,
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return rows.length;
}

export interface EventFilter {
  startDate: string;
  endDate: string;
  bots?: number[];
  etapa?: Etapa;
  limit: number;
  offset: number;
}

export interface EventOut {
  timestamp: string;
  bot: number;
  etapa: Etapa;
  telefone: string | null;
}

/** Leitura paginada do log de eventos (para /api/eventos). */
export async function queryEvents(f: EventFilter): Promise<{ total: number; events: EventOut[] }> {
  const m = mode();
  if (m === 'demo') return demoQueryEvents(f);
  if (m === 'live') return liveQueryEvents(f);
  const [start, end] = rangeUtc(f.startDate, f.endDate);
  const cond = ['ts >= $1', 'ts < $2'];
  const params: any[] = [start, end];
  if (f.bots && f.bots.length) { params.push(f.bots); cond.push(`bot = ANY($${params.length}::int[])`); }
  if (f.etapa) { params.push(f.etapa); cond.push(`etapa = $${params.length}`); }
  const where = cond.join(' AND ');

  const totalRes = await pool().query(`SELECT count(*)::int AS total FROM events WHERE ${where}`, params);
  const total: number = totalRes.rows[0].total;

  const p = [...params, f.limit, f.offset];
  const res = await pool().query(
    `SELECT ${TS_BR} AS timestamp, bot, etapa, telefone
       FROM events WHERE ${where}
      ORDER BY ts ASC
      LIMIT $${p.length - 1} OFFSET $${p.length}`,
    p,
  );
  return { total, events: res.rows as EventOut[] };
}

/** Assíncrono por bloco: itera TODOS os eventos do período (para o CSV, sem estourar memória). */
export async function* iterEvents(startDate: string, endDate: string, bots?: number[]): AsyncGenerator<EventOut> {
  const m = mode();
  if (m === 'demo') { for (const e of demoIterEvents(startDate, endDate)) yield e; return; }
  if (m === 'live') { for (const e of await liveIterEvents(startDate, endDate)) yield e; return; }
  const [start, end] = rangeUtc(startDate, endDate);
  // Filtra o bot já no SQL: o CSV do novo agente traria milhares de linhas
  // de outros segmentos só pra descartar depois.
  const botFilter = bots && bots.length ? ' AND bot = ANY($3::int[])' : '';
  const baseParams: any[] = bots && bots.length ? [start, end, bots] : [start, end];
  const PAGE = 5000;
  let offset = 0;
  for (;;) {
    const res = await pool().query(
      `SELECT ${TS_BR} AS timestamp, bot, etapa, telefone
         FROM events WHERE ts >= $1 AND ts < $2${botFilter}
        ORDER BY ts ASC LIMIT ${PAGE} OFFSET ${offset}`,
      baseParams,
    );
    if (res.rows.length === 0) break;
    for (const r of res.rows) yield r as EventOut;
    if (res.rows.length < PAGE) break;
    offset += PAGE;
  }
}

export interface DailyRow { day: string; bot: number; disparos: number; respostas: number; }

/**
 * Contagens do funil: série diária por bot + totais (para /api/funil e o painel).
 *
 * Semântica de COORTE: cada disparo é contado no seu dia, e a resposta é atribuída
 * ao dia do DISPARO (não ao dia em que a resposta chegou). Isso mantém a taxa
 * respostas/disparos coerente por coorte — igual ao pipeline original confiável.
 */
export async function queryFunnel(
  startDate: string, endDate: string, bots?: number[],
): Promise<{ daily: DailyRow[]; totals: { disparos: number; respostas: number } }> {
  const m = mode();
  if (m === 'demo') return demoFunnel(startDate, endDate, bots);
  if (m === 'live') return liveFunnel(startDate, endDate, bots);

  // O novo agente não tem linhas em `events` (só resumo por dia) — entra por fora.
  const querAgente = !bots || bots.includes(AGENTE_BOT);
  const soAgente = !!bots && bots.every((b) => b === AGENTE_BOT);
  const linhasAgente = querAgente ? await agenteDaily(startDate, endDate) : [];
  if (soAgente) {
    const totals = linhasAgente.reduce(
      (a, r) => ({ disparos: a.disparos + r.disparos, respostas: a.respostas + r.respostas }),
      { disparos: 0, respostas: 0 },
    );
    return { daily: linhasAgente, totals };
  }

  const [start, end] = rangeUtc(startDate, endDate);
  const cond = ["d.etapa = 'disparo'", 'd.ts >= $1', 'd.ts < $2'];
  const params: any[] = [start, end];
  if (bots && bots.length) { params.push(bots); cond.push(`d.bot = ANY($${params.length}::int[])`); }
  const where = cond.join(' AND ');

  // LEFT JOIN (e não EXISTS por linha): o novo agente traz dezenas de milhares
  // de disparos por dia, e o hash join aguenta isso sem sofrer.
  const res = await pool().query(
    `SELECT (d.ts AT TIME ZONE 'America/Sao_Paulo')::date::text AS day,
            d.bot,
            count(*)::int AS disparos,
            count(r.conversation_id)::int AS respostas
       FROM events d
       LEFT JOIN events r
         ON r.conversation_id = d.conversation_id AND r.etapa = 'resposta'
      WHERE ${where}
      GROUP BY day, d.bot
      ORDER BY day, d.bot`,
    params,
  );
  const daily = [...(res.rows as DailyRow[]), ...linhasAgente]
    .sort((a, b) => (a.day === b.day ? a.bot - b.bot : a.day < b.day ? -1 : 1));
  const totals = daily.reduce(
    (a, r) => ({ disparos: a.disparos + r.disparos, respostas: a.respostas + r.respostas }),
    { disparos: 0, respostas: 0 },
  );
  return { daily, totals };
}

// ---------- Novo agente (resumo por dia) ----------

/** Upsert idempotente do resumo diário do agente. Retorna quantos dias gravou. */
export async function upsertAgenteDiario(rows: AgenteDia[]): Promise<number> {
  if (rows.length === 0) return 0;
  const values: any[] = [];
  const tuples = rows.map((r, i) => {
    const b = i * 3;
    values.push(r.dia, r.disparos, r.respostas);
    return `($${b + 1}::date,$${b + 2},$${b + 3})`;
  });
  await pool().query(
    `INSERT INTO agente_diario (dia, disparos, respostas)
     VALUES ${tuples.join(',')}
     ON CONFLICT (dia)
     DO UPDATE SET disparos = EXCLUDED.disparos, respostas = EXCLUDED.respostas`,
    values,
  );
  return rows.length;
}

/**
 * Disparos (entregues) por dia, já resumidos. O log do agente usa isso pra
 * paginar sem ter que recontar a entrega de cada número a cada clique.
 */
export async function agenteDisparosPorDia(
  startDate: string, endDate: string,
): Promise<Map<string, number>> {
  if (mode() !== 'store') return new Map();
  const res = await pool().query(
    `SELECT dia::text AS dia, disparos FROM agente_diario WHERE dia >= $1 AND dia <= $2`,
    [startDate, endDate],
  );
  return new Map(res.rows.map((r: any) => [r.dia, Number(r.disparos)]));
}

/** Resumo diário do agente no período (já no formato do funil). */
async function agenteDaily(startDate: string, endDate: string): Promise<DailyRow[]> {
  const res = await pool().query(
    `SELECT dia::text AS day, disparos, respostas
       FROM agente_diario WHERE dia >= $1 AND dia <= $2 ORDER BY dia`,
    [startDate, endDate],
  );
  return res.rows.map((r: any) => ({
    day: r.day, bot: AGENTE_BOT, disparos: Number(r.disparos), respostas: Number(r.respostas),
  }));
}

/** Eventos de um dia específico (BR), para o payload do webhook. */
export async function eventsOfDay(day: string): Promise<EventOut[]> {
  const out: EventOut[] = [];
  for await (const e of iterEvents(day, day)) out.push(e);
  return out;
}

// ---------- Leads por vendedor ----------

/** Upsert idempotente das contagens de leads (por vendedor/dia). Retorna quantas gravou. */
export async function upsertLeads(rows: LeadDaily[]): Promise<number> {
  if (rows.length === 0) return 0;
  const CHUNK = 500;
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const values: any[] = [];
      const tuples = chunk.map((r, j) => {
        const b = j * 5;
        values.push(r.vendedor_id, r.dia, r.bot, r.vendedor_nome, r.total);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`;
      });
      await client.query(
        `INSERT INTO leads (vendedor_id, dia, bot, vendedor_nome, total)
         VALUES ${tuples.join(',')}
         ON CONFLICT (vendedor_id, dia, bot)
         DO UPDATE SET vendedor_nome = EXCLUDED.vendedor_nome, total = EXCLUDED.total`,
        values,
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return rows.length;
}

/**
 * Leitura pro painel: total por vendedor (barras) + série diária por vendedor (linha).
 * `dia` já é o dia de Brasília, então o filtro é direto por data.
 */
export async function queryLeads(
  startDate: string, endDate: string, bots?: number[],
): Promise<{ byVendor: LeadVendorRow[]; daily: LeadDailyRow[] }> {
  const m = mode();
  if (m === 'demo') return demoLeads(startDate, endDate, bots);
  if (m === 'live') return liveLeads(startDate, endDate, bots);

  // store: recorta pelo bot de origem (coluna `bot`), somando sobre bots dentro de cada vendedor/dia.
  const cond = ['dia >= $1', 'dia <= $2'];
  const params: any[] = [startDate, endDate];
  if (bots && bots.length) { params.push(bots); cond.push(`bot = ANY($${params.length}::int[])`); }
  const where = cond.join(' AND ');

  const byVendorRes = await pool().query(
    `SELECT vendedor_id, max(vendedor_nome) AS vendedor_nome, sum(total)::int AS total
       FROM leads WHERE ${where}
      GROUP BY vendedor_id
      ORDER BY total DESC`,
    params,
  );
  const dailyRes = await pool().query(
    `SELECT dia::text AS day, vendedor_nome, sum(total)::int AS total
       FROM leads WHERE ${where}
      GROUP BY dia, vendedor_nome
      ORDER BY dia ASC, vendedor_nome ASC`,
    params,
  );
  return { byVendor: byVendorRes.rows as LeadVendorRow[], daily: dailyRes.rows as LeadDailyRow[] };
}
