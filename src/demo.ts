// Modo demonstração — dados de exemplo pra rodar o painel SEM banco e SEM Metabase.
// Ativa quando não há DATABASE_URL nem credenciais do Metabase (ou com DEMO_MODE=1).
// Só gera as listas em memória; as contas ficam no módulo compartilhado `derive`.
import { funnelFrom, eventsPageFrom, eventsListFrom, leadsFrom, type MemEvent } from './derive';
import type { EventOut, DailyRow, EventFilter } from './db';
import type { LeadDaily, LeadVendorRow, LeadDailyRow } from './leads';

// PRNG determinístico (mulberry32) — números estáveis entre reinícios/requisições.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAYS_BACK = 60;
// Uma entrada por visão do painel. Os três últimos são os bots antigos do Mongo,
// que saíram do seletor mas seguem acessíveis pela API (segment=novos|recorrentes|
// ambos|carrinho_antigo) — por isso o demo também os gera, em volume menor.
const BOTS = [
  { bot: 9101, base: 310, spread: 90, resp: 0.28 }, // Welcome
  { bot: 9102, base: 165, spread: 60, resp: 0.19 }, // Welcome TOF
  { bot: 9103, base: 90, spread: 35, resp: 0.34 }, // Carrinho Abandonado
  { bot: 9104, base: 55, spread: 25, resp: 0.22 }, // Up-sell
  { bot: 9105, base: 210, spread: 70, resp: 0.12 }, // PageView
  { bot: 9001, base: 900, spread: 260, resp: 0.16 }, // Disparos
  { bot: 1201, base: 60, spread: 25, resp: 0.26 }, // histórico: Welcome Novos
  { bot: 1200, base: 24, spread: 12, resp: 0.31 }, // histórico: Welcome Recorrentes
  { bot: 185, base: 18, spread: 10, resp: 0.37 }, // histórico: Carrinho (antigo)
];
const VENDEDORES = [
  { id: 1, nome: 'Ana Souza' }, { id: 2, nome: 'Bruno Lima' }, { id: 3, nome: 'Carla Dias' },
  { id: 4, nome: 'Diego Melo' }, { id: 5, nome: 'Eduarda Rocha' }, { id: 6, nome: 'Felipe Nunes' },
  { id: 7, nome: 'Gabriela Alves' },
];
// Peso de origem dos leads por bot (Welcome concentra mais, igual ao volume de disparos).
const LEAD_BOT_WEIGHT: Record<number, number> = { 9101: 0.5, 9102: 0.2, 9103: 0.2, 9104: 0.1 };

function brDayNDaysAgo(n: number): string {
  const d = new Date(Date.now() - 3 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function buildEvents(): MemEvent[] {
  const rand = rng(20260715);
  const out: MemEvent[] = [];
  for (let d = DAYS_BACK; d >= 0; d--) {
    const day = brDayNDaysAgo(d);
    for (const b of BOTS) {
      const weekendFactor = [0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay()) ? 0.55 : 1;
      const count = Math.round((b.base - b.spread / 2 + rand() * b.spread) * weekendFactor);
      for (let i = 0; i < count; i++) {
        const hour = 8 + Math.floor(rand() * 12);
        const at = new Date(`${day}T03:00:00.000Z`);
        at.setUTCHours(at.getUTCHours() + hour, Math.floor(rand() * 60), Math.floor(rand() * 60), 0);
        const telefone = '55' + (11900000000 + Math.floor(rand() * 89999999)).toString();
        const cid = `demo-${b.bot}-${day}-${i}`;
        out.push({ conversation_id: cid, etapa: 'disparo', at, bot: b.bot, telefone });
        if (rand() < b.resp) {
          const late = rand() < 0.12; // ~12% respondem no dia seguinte
          const rat = new Date(at.getTime() + (late ? 20 : 0.2) * 3600 * 1000 + Math.floor(rand() * 40) * 60000);
          out.push({ conversation_id: cid, etapa: 'resposta', at: rat, bot: b.bot, telefone });
        }
      }
    }
  }
  return out;
}

function buildLeads(): LeadDaily[] {
  const rand = rng(75319);
  const out: LeadDaily[] = [];
  for (let d = DAYS_BACK; d >= 0; d--) {
    const dia = brDayNDaysAgo(d);
    const isWeekend = [0, 6].includes(new Date(`${dia}T12:00:00Z`).getUTCDay());
    for (const v of VENDEDORES) {
      const base = 6 + (v.id % 3) * 4;
      const dayTotal = Math.max(0, Math.round((base - 3 + rand() * 12) * (isWeekend ? 0.4 : 1)));
      if (dayTotal === 0) continue;
      for (const b of BOTS) {
        const peso = LEAD_BOT_WEIGHT[b.bot] ?? 0; // bot sem lead atribuído fica de fora
        if (peso === 0) continue;
        const total = Math.round(dayTotal * peso * (0.7 + rand() * 0.6));
        if (total > 0) out.push({ vendedor_id: v.id, vendedor_nome: v.nome, dia, bot: b.bot, total });
      }
    }
  }
  return out;
}

const EVENTS = buildEvents();
const LEADS = buildLeads();

export function demoFunnel(startDate: string, endDate: string, bots?: number[]): { daily: DailyRow[]; totals: { disparos: number; respostas: number } } {
  return funnelFrom(EVENTS, startDate, endDate, bots);
}
export function demoQueryEvents(f: EventFilter): { total: number; events: EventOut[] } {
  return eventsPageFrom(EVENTS, f);
}
export function demoIterEvents(startDate: string, endDate: string): EventOut[] {
  return eventsListFrom(EVENTS, startDate, endDate);
}
export function demoLeads(startDate: string, endDate: string, bots?: number[]): { byVendor: LeadVendorRow[]; daily: LeadDailyRow[] } {
  return leadsFrom(LEADS, startDate, endDate, bots);
}
