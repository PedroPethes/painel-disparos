// Cálculos em memória do funil / log / leads a partir de listas já carregadas.
// Compartilhado pelo modo "exemplo" (dados sintéticos) e pelo modo "ao vivo" (dados reais
// vindos do Metabase). O modo "store" (produção) faz as mesmas contas em SQL no Postgres.
import type { EventOut, DailyRow, EventFilter } from './db';
import type { LeadVendorRow, LeadDailyRow, LeadDaily } from './leads';

/** Um evento já reduzido ao que interessa (instante real + metadados). */
export interface MemEvent {
  conversation_id: string;
  etapa: 'disparo' | 'resposta';
  at: Date; // instante do evento (UTC)
  bot: number;
  telefone: string | null;
}

// Brasília = UTC-3 (constante, sem horário de verão).
export function brDay(at: Date): string {
  return new Date(at.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}
export function brIso(at: Date): string {
  return new Date(at.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 19) + '-03:00';
}
function inRange(day: string, start: string, end: string): boolean {
  return day >= start && day <= end;
}

/** Funil por coorte: a resposta é atribuída ao dia do DISPARO (igual ao SQL do store). */
export function funnelFrom(
  events: MemEvent[], startDate: string, endDate: string, bots?: number[],
): { daily: DailyRow[]; totals: { disparos: number; respostas: number } } {
  const responded = new Set(events.filter((e) => e.etapa === 'resposta').map((e) => e.conversation_id));
  const agg = new Map<string, DailyRow>();
  for (const e of events) {
    if (e.etapa !== 'disparo') continue;
    if (bots && !bots.includes(e.bot)) continue;
    const day = brDay(e.at);
    if (!inRange(day, startDate, endDate)) continue;
    const key = `${day}|${e.bot}`;
    let row = agg.get(key);
    if (!row) { row = { day, bot: e.bot, disparos: 0, respostas: 0 }; agg.set(key, row); }
    row.disparos++;
    if (responded.has(e.conversation_id)) row.respostas++;
  }
  const daily = [...agg.values()].sort((a, b) => (a.day === b.day ? a.bot - b.bot : a.day < b.day ? -1 : 1));
  const totals = daily.reduce((t, r) => ({ disparos: t.disparos + r.disparos, respostas: t.respostas + r.respostas }), { disparos: 0, respostas: 0 });
  return { daily, totals };
}

/** Log pelo instante do evento (resposta tardia aparece no dia em que chegou). */
function eventsFiltered(events: MemEvent[], f: { startDate: string; endDate: string; bots?: number[]; etapa?: string }): EventOut[] {
  return events
    .filter((e) => (!f.etapa || e.etapa === f.etapa) && (!f.bots || f.bots.includes(e.bot)) && inRange(brDay(e.at), f.startDate, f.endDate))
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((e) => ({ timestamp: brIso(e.at), bot: e.bot, etapa: e.etapa, telefone: e.telefone }));
}

export function eventsPageFrom(events: MemEvent[], f: EventFilter): { total: number; events: EventOut[] } {
  const all = eventsFiltered(events, f);
  return { total: all.length, events: all.slice(f.offset, f.offset + f.limit) };
}

export function eventsListFrom(events: MemEvent[], startDate: string, endDate: string): EventOut[] {
  return eventsFiltered(events, { startDate, endDate });
}

/** Leads por vendedor (barras) + série diária (linha). `bots` recorta pelo bot de origem. */
export function leadsFrom(
  leads: LeadDaily[], startDate: string, endDate: string, bots?: number[],
): { byVendor: LeadVendorRow[]; daily: LeadDailyRow[] } {
  const rows = leads.filter(
    (l) => inRange(l.dia, startDate, endDate) && (!bots || (l.bot != null && bots.includes(l.bot))),
  );
  const byV = new Map<number, LeadVendorRow>();
  for (const l of rows) {
    let r = byV.get(l.vendedor_id);
    if (!r) { r = { vendedor_id: l.vendedor_id, vendedor_nome: l.vendedor_nome, total: 0 }; byV.set(l.vendedor_id, r); }
    r.total += l.total;
  }
  const byVendor = [...byV.values()].sort((a, b) => b.total - a.total);
  const byDayVend = new Map<string, LeadDailyRow>();
  for (const l of rows) {
    const key = `${l.dia}|${l.vendedor_nome}`;
    let r = byDayVend.get(key);
    if (!r) { r = { day: l.dia, vendedor_nome: l.vendedor_nome, total: 0 }; byDayVend.set(key, r); }
    r.total += l.total;
  }
  const daily = [...byDayVend.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.vendedor_nome.localeCompare(b.vendedor_nome)));
  return { byVendor, daily };
}
