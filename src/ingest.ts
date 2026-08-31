// Ingestor — o ÚNICO componente que fala com o Metabase.
// Deriva os eventos da fonte e faz upsert idempotente no Postgres.
//
//   node dist/ingest.js                      -> rodada diária (janela de LOOKBACK_DAYS)
//   node dist/ingest.js --backfill 2024-01-01 [2026-07-07]  -> backfill do histórico
//   node dist/ingest.js --agente 2026-07-07 [2026-07-27]    -> backfill só do novo agente
//
// O novo agente NÃO vem do Metabase: vem do worker payload-sink (ver src/agente.ts).
//
// Roda como serviço interno (Railway Cron), sem domínio público.
import 'dotenv/config';
import { MetabaseClient } from './metabase-client';
import {
  deriveConversationsPipeline, toEventRows, MONGO_DB, type ConversationDerived,
} from './events';
import { deriveLeads } from './leads';
import { deriveAgenteEvents, agregarPorDia, hasAgente, type AgenteDia } from './agente';
import { deriveFluxosEvents, hasFluxos, FLUXOS_INICIO } from './fluxos';
import { migrate, upsertEvents, upsertLeads, upsertAgenteDiario, endPool, pool, eventsOfDay, queryFunnel } from './db';
import { postWebhook, type WebhookPayload } from './webhook';

function mbClient(): MetabaseClient {
  return new MetabaseClient({
    url: process.env.METABASE_URL!, user: process.env.METABASE_USER!, pass: process.env.METABASE_PASS!,
  });
}

/** Data de "hoje" no fuso de Brasília (UTC-3), como 'YYYY-MM-DD'. */
function brToday(): string {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Soma n dias (pode ser negativo) a uma data 'YYYY-MM-DD'. */
function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Deriva e faz upsert do intervalo [startDate, endDate] em blocos (para não
 * sobrecarregar o Metabase). Idempotente — reprocessar a mesma janela é seguro.
 */
const PAGE = 1500; // < teto de 2000 do Metabase

async function ingestRange(
  client: MetabaseClient, startDate: string, endDate: string, kind: string, chunkDays = 7,
): Promise<{ conversas: number; eventos: number }> {
  let cur = startDate;
  let totalConv = 0;
  let totalEv = 0;
  while (cur <= endDate) {
    const tentativeEnd = addDays(cur, chunkDays - 1);
    const chunkEnd = tentativeEnd < endDate ? tentativeEnd : endDate;

    // Pagina o bloco pra nunca bater no teto de 2000 do Metabase (perderia conversas).
    let skip = 0;
    let chunkConv = 0;
    let chunkEv = 0;
    for (;;) {
      const conv = await client.queryMongoAsObjects<ConversationDerived>(
        'conversations', deriveConversationsPipeline(cur, chunkEnd, skip, PAGE), MONGO_DB,
      );
      if (conv.length === 0) break;
      const rows = toEventRows(conv);
      await upsertEvents(rows);
      chunkConv += conv.length;
      chunkEv += rows.length;
      if (conv.length < PAGE) break;
      skip += PAGE;
    }

    await pool().query(
      `INSERT INTO ingest_runs (kind, window_start, window_end, conversas, eventos, finished_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [kind, cur, chunkEnd, chunkConv, chunkEv],
    );

    totalConv += chunkConv;
    totalEv += chunkEv;
    console.log(`  ${cur}..${chunkEnd}: conversas=${chunkConv} eventos=${chunkEv}`);
    cur = addDays(chunkEnd, 1);
  }
  return { conversas: totalConv, eventos: totalEv };
}

/**
 * Ingere os leads por vendedor (PostgreSQL + bot via Mongo) e faz upsert no store.
 * `deriveLeads` já pagina a consulta crua; chunkamos por blocos só pra manter o mapa de bots enxuto.
 */
async function ingestLeads(
  client: MetabaseClient, startDate: string, endDate: string, chunkDays = 90,
): Promise<number> {
  let cur = startDate;
  let total = 0;
  while (cur <= endDate) {
    const tentativeEnd = addDays(cur, chunkDays - 1);
    const chunkEnd = tentativeEnd < endDate ? tentativeEnd : endDate;
    const leads = await deriveLeads(client, cur, chunkEnd);
    await upsertLeads(leads);
    total += leads.length;
    console.log(`  leads ${cur}..${chunkEnd}: linhas=${leads.length}`);
    cur = addDays(chunkEnd, 1);
  }
  return total;
}

// O worker payload-sink só tem dados a partir daqui (primeiro disparo gravado).
const AGENTE_INICIO = '2026-07-07';

/**
 * Ingere o NOVO AGENTE (fonte: worker payload-sink, não o Metabase).
 *
 * Vai em blocos curtos: são ~15 mil disparos por dia e o cruzamento
 * disparo<->resposta é feito em memória dentro de cada bloco. No banco fica só o
 * RESUMO DO DIA (o detalhe linha a linha não caberia no disco do Postgres).
 */
async function ingestAgente(
  startDate: string, endDate: string, kind: string, chunkDays = 3,
): Promise<number> {
  if (!hasAgente()) { console.log('[agente] SINK_URL/SINK_TOKEN não configurados — pulando'); return 0; }
  let cur = startDate < AGENTE_INICIO ? AGENTE_INICIO : startDate;
  let totalDisparos = 0;
  while (cur <= endDate) {
    const tentativeEnd = addDays(cur, chunkDays - 1);
    const chunkEnd = tentativeEnd < endDate ? tentativeEnd : endDate;
    const calculados = new Map(agregarPorDia(await deriveAgenteEvents(cur, chunkEnd)).map((d) => [d.dia, d]));
    // Grava TODOS os dias do bloco, inclusive os zerados: se um dia já gravado
    // deixar de ter disparos (mudança de regra, por exemplo), ele precisa zerar
    // em vez de ficar com o número velho.
    const dias: AgenteDia[] = [];
    for (let d = cur; d <= chunkEnd; d = addDays(d, 1)) {
      dias.push(calculados.get(d) || { dia: d, disparos: 0, respostas: 0 });
    }
    await upsertAgenteDiario(dias);
    const disparos = dias.reduce((s, d) => s + d.disparos, 0);
    const respostas = dias.reduce((s, d) => s + d.respostas, 0);
    await pool().query(
      `INSERT INTO ingest_runs (kind, window_start, window_end, conversas, eventos, finished_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [`${kind}-agente`, cur, chunkEnd, disparos, respostas],
    );
    totalDisparos += disparos;
    console.log(`  agente ${cur}..${chunkEnd}: disparos=${disparos} respostas=${respostas}`);
    cur = addDays(chunkEnd, 1);
  }
  return totalDisparos;
}

/**
 * Ingere os FLUXOS novos (fonte: worker de fluxos + respostas do sink).
 * O volume é pequeno (centenas/dia), então os eventos vão linha a linha pra
 * tabela `events`, com um bot sintético por fluxo — o funil e o log do painel
 * funcionam pelo mesmo caminho dos bots do Mongo.
 */
async function ingestFluxos(startDate: string, endDate: string, kind: string): Promise<number> {
  if (!hasFluxos()) { console.log('[fluxos] FLUXOS_URL/FLUXOS_TOKEN não configurados — pulando'); return 0; }
  const start = startDate < FLUXOS_INICIO ? FLUXOS_INICIO : startDate;
  if (start > endDate) return 0;
  const rows = await deriveFluxosEvents(start, endDate);
  await upsertEvents(rows);
  const disparos = rows.filter((r) => r.etapa === 'disparo').length;
  const respostas = rows.length - disparos;
  await pool().query(
    `INSERT INTO ingest_runs (kind, window_start, window_end, conversas, eventos, finished_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [`${kind}-fluxos`, start, endDate, disparos, rows.length],
  );
  console.log(`  fluxos ${start}..${endDate}: disparos=${disparos} respostas=${respostas}`);
  return disparos;
}

/** Envia o push do dia anterior, se o webhook estiver configurado. */
async function maybeWebhook(): Promise<void> {
  const url = process.env.CLIENT_WEBHOOK_URL;
  const secret = process.env.CLIENT_WEBHOOK_SECRET || '';
  if (!url) { console.log('[webhook] CLIENT_WEBHOOK_URL vazio — pulando'); return; }

  const day = addDays(brToday(), -1);
  const events = await eventsOfDay(day);
  const { totals } = await queryFunnel(day, day);
  const taxa = totals.disparos ? Math.round((totals.respostas / totals.disparos) * 10000) / 10000 : 0;
  const payload: WebhookPayload = { date: day, funil: { ...totals, taxa }, events };

  const ok = await postWebhook(url, secret, payload);
  console.log(`[webhook] ${day}: ${ok ? 'enviado' : 'FALHOU (logado; não derruba a ingestão)'} — ${events.length} eventos`);
}

/** Rodada diária: janela de LOOKBACK_DAYS + push do webhook. Reutilizável (CLI e in-process). */
export async function runDailyIngest(): Promise<{ conversas: number; eventos: number }> {
  await migrate();
  const end = brToday();
  const lookback = parseInt(process.env.LOOKBACK_DAYS || '30', 10);
  const start = addDays(end, -(lookback - 1));
  console.log(`[daily] janela ${start}..${end}`);
  const client = mbClient();
  const r = await ingestRange(client, start, end, 'daily');
  console.log(`[daily] conversas=${r.conversas} eventos=${r.eventos}`);
  const leads = await ingestLeads(client, start, end);
  console.log(`[daily] leads (vendedor/dia)=${leads}`);

  // Novo agente: janela própria (bem menor), porque o volume diário é alto e a
  // resposta quase sempre chega em até 72h — não adianta reprocessar 30 dias.
  // Falha aqui NÃO derruba a rodada: os bots de Welcome vêm de outra fonte.
  const agLookback = parseInt(process.env.AGENTE_LOOKBACK_DAYS || '5', 10);
  try {
    const agDisparos = await ingestAgente(addDays(end, -(agLookback - 1)), end, 'daily');
    console.log(`[daily] agente disparos=${agDisparos}`);
  } catch (e: any) {
    console.error('[daily] agente FALHOU (segue sem ele):', e.message);
  }

  // Fluxos novos: janela curta como a do agente (resposta chega em até 72h).
  const fxLookback = parseInt(process.env.FLUXOS_LOOKBACK_DAYS || '5', 10);
  try {
    const fxDisparos = await ingestFluxos(addDays(end, -(fxLookback - 1)), end, 'daily');
    console.log(`[daily] fluxos disparos=${fxDisparos}`);
  } catch (e: any) {
    console.error('[daily] fluxos FALHOU (segue sem eles):', e.message);
  }

  await maybeWebhook();
  return r;
}

/** Backfill de [start, end] em blocos. */
export async function runBackfillIngest(start: string, end: string): Promise<{ conversas: number; eventos: number }> {
  await migrate();
  console.log(`[backfill] ${start}..${end}`);
  const client = mbClient();
  const r = await ingestRange(client, start, end, 'backfill');
  console.log(`[backfill] TOTAL conversas=${r.conversas} eventos=${r.eventos}`);
  const leads = await ingestLeads(client, start, end);
  console.log(`[backfill] TOTAL leads (vendedor/dia)=${leads}`);
  const agDisparos = await ingestAgente(start, end, 'backfill');
  console.log(`[backfill] TOTAL agente disparos=${agDisparos}`);
  const fxDisparos = await ingestFluxos(start, end, 'backfill');
  console.log(`[backfill] TOTAL fluxos disparos=${fxDisparos}`);
  return r;
}

/**
 * Atualização curta e frequente de TODAS as visões (últimos `dias`). Serve pra
 * manter o dia de HOJE fresco no painel: disparo, resposta, entrega e atribuição
 * a vendedor pingam o dia inteiro, e a rodada diária sozinha deixaria os números
 * parados por horas (o Carrinho já apareceu com 4h de atraso por causa disso).
 *
 * A janela é curta de propósito — reler os 30 dias da rodada diária a cada 5 min
 * seria caro e inútil, porque dia fechado não muda mais.
 *
 * As duas fontes falham por conta própria: o Metabase fora do ar não pode
 * impedir a visão de Disparos (que vem do worker) de atualizar, e vice-versa.
 */
export async function runRefresh(dias = 1): Promise<void> {
  const end = brToday();
  const start = addDays(end, -(dias - 1));

  try {
    const client = mbClient();
    const r = await ingestRange(client, start, end, 'refresh');
    const leads = await ingestLeads(client, start, end);
    console.log(`[refresh] welcome/carrinho ${start}..${end}: conversas=${r.conversas} eventos=${r.eventos} leads=${leads}`);
  } catch (e: any) {
    console.error('[refresh] welcome/carrinho FALHOU (segue pro agente):', e.message);
  }

  try {
    const disparos = await ingestAgente(start, end, 'refresh');
    console.log(`[refresh] agente ${start}..${end}: disparos=${disparos}`);
  } catch (e: any) {
    console.error('[refresh] agente FALHOU:', e.message);
  }

  try {
    const disparos = await ingestFluxos(start, end, 'refresh');
    console.log(`[refresh] fluxos ${start}..${end}: disparos=${disparos}`);
  } catch (e: any) {
    console.error('[refresh] fluxos FALHOU:', e.message);
  }
}

/** Backfill só do novo agente (não toca no Metabase). */
export async function runBackfillAgente(start: string, end: string): Promise<number> {
  await migrate();
  console.log(`[agente] backfill ${start}..${end}`);
  const n = await ingestAgente(start, end, 'backfill');
  console.log(`[agente] TOTAL disparos=${n}`);
  return n;
}

async function mainCli(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--agente') {
    const start = args[1];
    if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
      throw new Error('uso: --agente YYYY-MM-DD [YYYY-MM-DD]');
    }
    await runBackfillAgente(start, args[2] || brToday());
  } else if (args[0] === '--fluxos') {
    const start = args[1];
    if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
      throw new Error('uso: --fluxos YYYY-MM-DD [YYYY-MM-DD]');
    }
    await migrate();
    await ingestFluxos(start, args[2] || brToday(), 'backfill');
  } else if (args[0] === '--backfill') {
    const start = args[1];
    if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
      throw new Error('uso: --backfill YYYY-MM-DD [YYYY-MM-DD]');
    }
    await runBackfillIngest(start, args[2] || brToday());
  } else {
    await runDailyIngest();
  }
}

// Só executa o CLI quando rodado direto (não quando importado pelo server).
if (require.main === module) {
  mainCli()
    .then(() => endPool())
    .catch((e) => {
      console.error('ERRO ingest:', e);
      endPool().finally(() => process.exit(1));
    });
}
