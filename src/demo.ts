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
const BOTS = [
  { bot: 1201, base: 320, spread: 90, resp: 0.26 }, // Welcome Novos
  { bot: 1200, base: 46, spread: 22, resp: 0.31 }, // Welcome Recorrentes
  { bot: 185, base: 28, spread: 16, resp: 0.37 }, // Carrinho Abandonado
];
const VENDEDORES = [
  { id: 1, nome: 'Ana Souza' }, { id: 2, nome: 'Bruno Lima' }, { id: 3, nome: 'Carla Dias' },
  { id: 4, nome: 'Diego Melo' }, { id: 5, nome: 'Eduarda Rocha' }, { id: 6, nome: 'Felipe Nunes' },
  { id: 7, nome: 'Gabriela Alves' },
];
// Peso de origem dos leads por bot (Novos concentra mais, igual ao volume de disparos).
const LEAD_BOT_WEIGHT: Record<number, number> = { 1201: 0.55, 1200: 0.25, 185: 0.2 };

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
        const total = Math.round(dayTotal * LEAD_BOT_WEIGHT[b.bot] * (0.7 + rand() * 0.6));
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
