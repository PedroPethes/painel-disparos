// Modo "ao vivo" — lê os números REAIS direto do Metabase (Mongo dos disparos + PostgreSQL
// dos leads). Serve pra rodar/testar localmente sem instalar banco. Em produção o modo é
// "store" (Postgres protegido) e nada disto roda na superfície pública.
import { MetabaseClient } from './metabase-client';
import { deriveConversationsPipeline, MONGO_DB, type ConversationDerived } from './events';
import { deriveLeads, type LeadDaily } from './leads';
import { funnelFrom, eventsPageFrom, eventsListFrom, leadsFrom, type MemEvent } from './derive';
import type { EventOut, DailyRow, EventFilter } from './db';

let _client: MetabaseClient | null = null;
function client(): MetabaseClient {
  if (!_client) {
    _client = new MetabaseClient({
      url: process.env.METABASE_URL!, user: process.env.METABASE_USER!, pass: process.env.METABASE_PASS!,
    });
  }
  return _client;
}

// Cache curto por intervalo de datas (o mesmo período alimenta funil, log e CSV).
const TTL = 5 * 60 * 1000;
interface Cache<T> { t: number; data: T; }
const evCache = new Map<string, Cache<MemEvent[]>>();
const ldCache = new Map<string, Cache<LeadDaily[]>>();

function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Deriva os eventos (disparo/resposta) reais do período, em blocos e paginado. */
async function fetchEvents(startDate: string, endDate: string): Promise<MemEvent[]> {
  const key = `${startDate}|${endDate}`;
  const hit = evCache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.data;

  const PAGE = 1500; // < teto de 2000 do Metabase
  const out: MemEvent[] = [];
  let cur = startDate;
  while (cur <= endDate) {
    const chunkEnd = addDays(cur, 6) < endDate ? addDays(cur, 6) : endDate; // blocos de 7 dias
    let skip = 0;
    for (;;) {
      const conv = await client().queryMongoAsObjects<ConversationDerived>(
        'conversations', deriveConversationsPipeline(cur, chunkEnd, skip, PAGE), MONGO_DB,
      );
      if (conv.length === 0) break;
      for (const c of conv) {
        out.push({ conversation_id: c.conversation_id, etapa: 'disparo', at: new Date(c.disparo_ts), bot: c.bot, telefone: c.telefone });
        if (c.resposta_ts) out.push({ conversation_id: c.conversation_id, etapa: 'resposta', at: new Date(c.resposta_ts), bot: c.bot, telefone: c.telefone });
      }
      if (conv.length < PAGE) break;
      skip += PAGE;
    }
    cur = addDays(chunkEnd, 1);
  }
  evCache.set(key, { t: Date.now(), data: out });
  return out;
}

/** Deriva os leads reais (por vendedor/dia/bot) do período. */
async function fetchLeads(startDate: string, endDate: string): Promise<LeadDaily[]> {
  const key = `${startDate}|${endDate}`;
  const hit = ldCache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.data;
  const data = await deriveLeads(client(), startDate, endDate);
  ldCache.set(key, { t: Date.now(), data });
  return data;
}

export async function liveFunnel(startDate: string, endDate: string, bots?: number[]): Promise<{ daily: DailyRow[]; totals: { disparos: number; respostas: number } }> {
  return funnelFrom(await fetchEvents(startDate, endDate), startDate, endDate, bots);
}

export async function liveQueryEvents(f: EventFilter): Promise<{ total: number; events: EventOut[] }> {
  return eventsPageFrom(await fetchEvents(f.startDate, f.endDate), f);
}

export async function liveIterEvents(startDate: string, endDate: string): Promise<EventOut[]> {
  return eventsListFrom(await fetchEvents(startDate, endDate), startDate, endDate);
}

export async function liveLeads(startDate: string, endDate: string, bots?: number[]): Promise<{ byVendor: import('./leads').LeadVendorRow[]; daily: import('./leads').LeadDailyRow[] }> {
  return leadsFrom(await fetchLeads(startDate, endDate), startDate, endDate, bots);
}
