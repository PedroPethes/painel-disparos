// Visões de FLUXO — os disparos que os clientes do cliente mandam pro worker
// "fluxos-worker" (Cloudflare), que classifica novo/recorrente e roteia
// pro webhook da plataforma de cada fluxo (welcome, welcometof, carrinho, upsell,
// pageview).
//
// Fontes (nenhuma é o Mongo da plataforma — os bots desses fluxos vivem na
// plataforma nova e as conversas deles não aparecem no Metabase):
//   - DISPAROS: GET /export do worker de fluxos (linhas status='sent').
//   - RESPOSTAS: tabela `respostas` do worker payload-sink (o inbound do número
//     de WhatsApp desses bots cai lá — verificado em 2026-08-28: ~30% dos números
//     disparados pelos fluxos têm resposta no sink). Cruzamento por TELEFONE com
//     a mesma regra da visão Disparos (janela de 72h, 1ª resposta por disparo).
//
// Os eventos derivados entram na tabela `events` do Postgres com um bot
// sintético por fluxo (910x) — o volume é pequeno (centenas/dia, não os ~15 mil
// do agente), então aqui cabe o evento linha a linha, e o funil/log do painel
// funcionam sem caminho especial.
import type { EventRow } from './events';
import { cruzarAgente, fetchDia as fetchSinkDia, type Linha } from './agente';

export const FLUXOS = {
  welcome:    { bot: 9101, label: 'Welcome' },
  welcometof: { bot: 9102, label: 'Welcome TOF' },
  carrinho:   { bot: 9103, label: 'Carrinho Abandonado' },
  upsell:     { bot: 9104, label: 'Up-sell' },
  pageview:   { bot: 9105, label: 'PageView' },
} as const;

export type FluxoKey = keyof typeof FLUXOS;
export const FLUXO_BOTS: number[] = Object.values(FLUXOS).map((f) => f.bot);

// O worker de fluxos começou a receber disparos reais aqui.
export const FLUXOS_INICIO = '2026-08-26';

/** As visões de fluxo só entram quando o painel sabe falar com os DOIS workers. */
export function hasFluxos(): boolean {
  return !!(process.env.FLUXOS_URL && process.env.FLUXOS_TOKEN
    && process.env.SINK_URL && process.env.SINK_TOKEN);
}

const PAGE = 5000;
const DIAS_EXTRA_RESPOSTA = 3; // cauda da janela de 72h

function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  let cur = startDate;
  while (cur <= endDate) { out.push(cur); cur = addDays(cur, 1); }
  return out;
}

async function fetchRetry(url: string, attempts = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.FLUXOS_TOKEN}` } });
      if (res.status >= 500) throw new Error(`fluxos-worker HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

interface LinhaFluxo extends Linha { fluxo: string; }

/** Todos os disparos (status 'sent') de um dia, com o fluxo canônico de cada um. */
async function disparosDoDia(dia: string): Promise<LinhaFluxo[]> {
  const base = (process.env.FLUXOS_URL || '').replace(/\/+$/, '');
  const out: LinhaFluxo[] = [];
  let offset = 0;
  for (;;) {
    const res = await fetchRetry(`${base}/export?tipo=disparos&dia=${dia}&limit=${PAGE}&offset=${offset}`);
    if (!res.ok) throw new Error(`fluxos /export disparos ${dia}: HTTP ${res.status} ${await res.text()}`);
    const json: any = await res.json();
    const linhas: LinhaFluxo[] = json.linhas || [];
    out.push(...linhas);
    if (linhas.length < PAGE || out.length >= (json.total ?? 0)) break;
    offset += PAGE;
  }
  return out;
}

/**
 * Deriva os eventos (disparo + resposta) de TODOS os fluxos no período, já no
 * formato do store. O cruzamento com as respostas é feito com os fluxos JUNTOS:
 * se dois fluxos dispararam pro mesmo número, a resposta marca só o disparo
 * mais recente (em vez de contar em dobro, um por fluxo).
 */
export async function deriveFluxosEvents(startDate: string, endDate: string): Promise<EventRow[]> {
  const disparos: Linha[] = [];
  const botPorDisparo = new Map<string, number>();
  for (const dia of daysBetween(startDate, endDate)) {
    for (const l of await disparosDoDia(dia)) {
      const meta = (FLUXOS as Record<string, { bot: number }>)[l.fluxo];
      if (!meta) continue; // fluxo 'outro' (não mapeado) fica fora do painel
      const id = `fx${l.id}`;
      disparos.push({ id, ts: l.ts, telefone: l.telefone });
      botPorDisparo.set(id, meta.bot);
    }
  }
  if (disparos.length === 0) return [];

  // Respostas do período + a cauda da janela (quem respondeu depois do fim).
  const respostas: Linha[] = [];
  for (const dia of daysBetween(startDate, addDays(endDate, DIAS_EXTRA_RESPOSTA))) {
    respostas.push(...await fetchSinkDia('respostas', dia));
  }

  // cruzarAgente marca tudo com o bot do agente — reatribuímos pelo disparo.
  const rows = cruzarAgente(disparos, respostas);
  for (const r of rows) {
    const bot = botPorDisparo.get(r.conversation_id);
    if (bot !== undefined) r.bot = bot;
  }
  return rows;
}
