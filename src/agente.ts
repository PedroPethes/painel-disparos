// Novo agente do cliente — fonte DIFERENTE dos bots de Welcome.
//
// Os disparos desse agente não passam pelo Mongo da plataforma: eles nascem no
// HubSpot, caem no worker Cloudflare "payload-sink" e ficam no D1
// `payloads`. As respostas dos clientes chegam no mesmo worker (callback
// da plataforma) e ficam na tabela `respostas`.
//
// Aqui a gente lê os dois pelo endpoint /export do worker e cruza por TELEFONE
// (não existe conversation_id em comum entre as duas pontas). Regra do cruzamento:
//   - uma resposta é atribuída ao disparo MAIS RECENTE feito para aquele número
//     antes dela, dentro da janela de JANELA_HORAS;
//   - cada disparo fica com a PRIMEIRA resposta que casar.
// Assim um mesmo cliente respondendo uma vez nunca marca dois disparos.
//
// "Resposta" aqui é qualquer mensagem recebida — inclusive o clique no botão
// "Acessar" do template (decidido com o cliente em 2026-07-27).
import type { EventRow } from './events'; // só tipo: evita import circular com events.ts
import type { EventOut } from './db';     // idem (db.ts importa daqui em runtime)
import { brDay, brIso } from './derive';

export const AGENTE_BOT = 9001; // id sintético (não existe na plataforma)
export const AGENTE_LABEL = 'Disparos';

const JANELA_HORAS = 72;     // até quando uma resposta ainda conta pro disparo
const PAGE = 5000;           // teto do /export do worker é 10000
const DIAS_EXTRA_RESPOSTA = Math.ceil(JANELA_HORAS / 24);

/** Uma linha crua vinda do /export do worker (disparo ou resposta). */
export interface Linha { id: string; ts: string; telefone: string | null; }

/** O agente só entra em cena quando o painel sabe falar com o worker. */
export function hasAgente(): boolean {
  return !!(process.env.SINK_URL && process.env.SINK_TOKEN);
}

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

/**
 * Chave de comparação do telefone: a Meta devolve números BR antigos SEM o nono
 * dígito, então 5531988887777 e 553188887777 são a MESMA pessoa. Normalizamos
 * os dois pro formato curto (sem o 9) antes de comparar.
 */
export function chaveTelefone(tel: string | null | undefined): string | null {
  if (!tel) return null;
  const d = String(tel).replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('55') && d.length === 13 && d[4] === '9') return d.slice(0, 4) + d.slice(5);
  return d;
}

/** fetch com algumas tentativas, pra tolerar blip de rede/cold start do worker. */
async function fetchRetry(url: string, attempts = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.SINK_TOKEN}` } });
      if (res.status >= 500) throw new Error(`worker HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

/** Lê TODAS as linhas de um dia do worker payload-sink (paginando até acabar).
 *  Exportada porque as visões de FLUXO (src/fluxos.ts) também leem as respostas daqui. */
export async function fetchDia(tipo: 'disparos' | 'respostas' | 'entregas', dia: string): Promise<Linha[]> {
  const base = (process.env.SINK_URL || '').replace(/\/+$/, '');
  const out: Linha[] = [];
  let offset = 0;
  for (;;) {
    const res = await fetchRetry(`${base}/export?tipo=${tipo}&dia=${dia}&limit=${PAGE}&offset=${offset}`);
    if (!res.ok) throw new Error(`/export ${tipo} ${dia}: HTTP ${res.status} ${await res.text()}`);
    const json: any = await res.json();
    const linhas: Linha[] = json.linhas || [];
    out.push(...linhas);
    if (linhas.length < PAGE || out.length >= (json.total ?? 0)) break;
    offset += PAGE;
  }
  return out;
}

// ---------- Disparo = mensagem ENTREGUE ----------
//
// Um disparo só conta quando a Meta confirmou a entrega (`delivered`). Não dá
// pra ligar a payload ao evento de entrega por id (o worker não guarda o id da
// mensagem no provedor), então o elo é o TELEFONE: o número disparado no dia
// precisa ter pelo menos uma entrega confirmada a partir do instante do disparo.
// A janela de busca é o dia + o dia seguinte, porque a Meta às vezes confirma
// horas depois. Contamos NÚMEROS distintos (um número disparado 2x no mesmo dia
// é 1 disparo), que é como o cliente lê o número.

const DIAS_JANELA_ENTREGA = 2;

/** telefone (chave canônica) -> instante da ÚLTIMA entrega confirmada. */
async function entregasDoDia(dia: string): Promise<Map<string, number>> {
  const mapa = new Map<string, number>();
  for (let i = 0; i < DIAS_JANELA_ENTREGA; i++) {
    for (const l of await fetchDia('entregas', addDays(dia, i))) {
      const k = chaveTelefone(l.telefone);
      if (!k) continue;
      // o /export devolve {telefone, ts, ts_fim}; interessa o mais recente
      const at = Date.parse((l as any).ts_fim || l.ts);
      const atual = mapa.get(k);
      if (atual === undefined || at > atual) mapa.set(k, at);
    }
  }
  return mapa;
}

/**
 * Disparos de um dia que foram ENTREGUES, um por número (o mais antigo do dia).
 * É a base de tudo nessa visão: cards, funil, gráficos e log.
 */
async function disparosEntregues(dia: string): Promise<Linha[]> {
  const [payloads, entregas] = await Promise.all([fetchDia('disparos', dia), entregasDoDia(dia)]);
  const porNumero = new Map<string, Linha>();
  for (const l of payloads) {
    const k = chaveTelefone(l.telefone);
    if (!k) continue;
    const anterior = porNumero.get(k);
    if (!anterior || Date.parse(l.ts) < Date.parse(anterior.ts)) porNumero.set(k, l);
  }
  const out: Linha[] = [];
  for (const [k, l] of porNumero) {
    const entrega = entregas.get(k);
    if (entrega !== undefined && entrega >= Date.parse(l.ts)) out.push(l);
  }
  return out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

interface DisparoIdx { id: string; at: number; telefone: string | null; resposta: number | null; }

/**
 * Cruza disparos e respostas por telefone (função pura — é o coração da conta).
 * Cada resposta marca o disparo mais recente feito àquele número antes dela,
 * desde que dentro da janela; cada disparo guarda a primeira resposta que casar.
 */
export function cruzarAgente(disparos: Linha[], respostas: Linha[]): EventRow[] {
  const idx: DisparoIdx[] = disparos.map((l) => ({
    id: l.id, at: Date.parse(l.ts), telefone: l.telefone, resposta: null,
  }));
  if (idx.length === 0) return [];

  // Índice: telefone -> disparos daquele número, ordenados no tempo.
  const porTelefone = new Map<string, DisparoIdx[]>();
  for (const d of idx) {
    const k = chaveTelefone(d.telefone);
    if (!k) continue;
    const arr = porTelefone.get(k);
    if (arr) arr.push(d); else porTelefone.set(k, [d]);
  }
  for (const arr of porTelefone.values()) arr.sort((a, b) => a.at - b.at);

  const janelaMs = JANELA_HORAS * 3600 * 1000;
  for (const r of respostas) {
    const k = chaveTelefone(r.telefone);
    if (!k) continue;
    const arr = porTelefone.get(k);
    if (!arr) continue;
    const at = Date.parse(r.ts);
    // Busca binária: último disparo com at <= resposta.
    let lo = 0, hi = arr.length - 1, achado = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].at <= at) { achado = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (achado < 0) continue;
    const d = arr[achado];
    if (at - d.at > janelaMs) continue;           // respondeu tarde demais
    if (d.resposta === null || at < d.resposta) d.resposta = at;
  }

  const rows: EventRow[] = [];
  for (const d of idx) {
    rows.push({
      conversation_id: d.id,
      etapa: 'disparo',
      ts: new Date(d.at).toISOString(),
      bot: AGENTE_BOT,
      telefone: d.telefone,
    });
    if (d.resposta !== null) {
      rows.push({
        conversation_id: d.id,
        etapa: 'resposta',
        ts: new Date(d.resposta).toISOString(),
        bot: AGENTE_BOT,
        telefone: d.telefone,
      });
    }
  }
  return rows;
}

// ---------- Log de eventos AO VIVO ----------
//
// O detalhe linha a linha NÃO fica guardado no Postgres (não caberia: ~15 mil
// disparos/dia num disco de 500 MB). Então o log é montado na hora, lendo o
// worker. Pra não baixar o período inteiro a cada página, primeiro pedimos a
// CONTAGEM por dia (1 request) e depois carregamos só o(s) dia(s) da página.

const TTL_MS = 5 * 60 * 1000;
interface Cache<T> { t: number; data: T; }
const cacheContagem = new Map<string, Cache<ContagemDia[]>>();
const cacheDia = new Map<string, Cache<EventoAgente[]>>();
const MAX_DIAS_EM_CACHE = 3;

interface ContagemDia { dia: string; disparos: number; respostas: number; }
interface EventoAgente { at: number; etapa: 'disparo' | 'resposta'; telefone: string | null; }

async function fetchContagem(startDate: string, endDate: string): Promise<ContagemDia[]> {
  const key = `${startDate}|${endDate}`;
  const hit = cacheContagem.get(key);
  if (hit && Date.now() - hit.t < TTL_MS) return hit.data;
  const base = (process.env.SINK_URL || '').replace(/\/+$/, '');
  const res = await fetchRetry(`${base}/export?tipo=contagem&de=${startDate}&ate=${endDate}`);
  if (!res.ok) throw new Error(`/export contagem: HTTP ${res.status}`);
  const json: any = await res.json();
  const data: ContagemDia[] = json.dias || [];
  cacheContagem.set(key, { t: Date.now(), data });
  return data;
}

/** Todos os eventos de UM dia (disparos entregues + respostas), ordenados no tempo. */
async function eventosDoDia(dia: string): Promise<EventoAgente[]> {
  const hit = cacheDia.get(dia);
  if (hit && Date.now() - hit.t < TTL_MS) return hit.data;
  const [disparos, respostas] = await Promise.all([disparosEntregues(dia), fetchDia('respostas', dia)]);
  const data: EventoAgente[] = [
    ...disparos.map((l) => ({ at: Date.parse(l.ts), etapa: 'disparo' as const, telefone: l.telefone })),
    ...respostas.map((l) => ({ at: Date.parse(l.ts), etapa: 'resposta' as const, telefone: l.telefone })),
  ].sort((a, b) => a.at - b.at);
  if (cacheDia.size >= MAX_DIAS_EM_CACHE) cacheDia.delete(cacheDia.keys().next().value as string);
  cacheDia.set(dia, { t: Date.now(), data });
  return data;
}

function paraSaida(e: EventoAgente): EventOut {
  return { timestamp: brIso(new Date(e.at)), bot: AGENTE_BOT, etapa: e.etapa, telefone: e.telefone };
}

function filtraEtapa(lista: EventoAgente[], etapa?: 'disparo' | 'resposta'): EventoAgente[] {
  return etapa ? lista.filter((e) => e.etapa === etapa) : lista;
}

function quantosNoDia(c: ContagemDia, etapa?: 'disparo' | 'resposta'): number {
  if (etapa === 'disparo') return c.disparos;
  if (etapa === 'resposta') return c.respostas;
  return c.disparos + c.respostas;
}

export interface LogFiltro {
  startDate: string; endDate: string;
  etapa?: 'disparo' | 'resposta';
  limit: number; offset: number;
}

/** Data de hoje no fuso de Brasília. */
function hojeBr(): string {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Uma página do log (total + linhas), montada na hora a partir do worker.
 *
 * `disparosPorDia` vem do resumo já gravado (tabela `agente_diario`), porque
 * contar disparos ENTREGUES exige cruzar duas tabelas — caro demais pra fazer a
 * cada clique. Dia recente que ainda não foi resumido é contado ao vivo.
 */
export async function logAgente(
  f: LogFiltro, disparosPorDia: Map<string, number>,
): Promise<{ total: number; events: EventOut[] }> {
  const respostasPorDia = new Map<string, number>();
  for (const c of await fetchContagem(f.startDate, f.endDate)) respostasPorDia.set(c.dia, c.respostas);

  const ontem = addDays(hojeBr(), -1);
  const dias: ContagemDia[] = [];
  for (const dia of daysBetween(f.startDate, f.endDate)) {
    let disparos = disparosPorDia.get(dia);
    if (disparos === undefined) {
      // sem resumo gravado: se for recente, conta na hora; se for antigo, é zero mesmo.
      disparos = dia >= ontem
        ? (await eventosDoDia(dia)).filter((e) => e.etapa === 'disparo').length
        : 0;
    }
    const respostas = respostasPorDia.get(dia) ?? 0;
    if (disparos || respostas) dias.push({ dia, disparos, respostas });
  }
  const total = dias.reduce((s, c) => s + quantosNoDia(c, f.etapa), 0);

  const events: EventOut[] = [];
  let restante = f.offset;
  for (const c of dias) {
    if (events.length >= f.limit) break;
    const n = quantosNoDia(c, f.etapa);
    if (restante >= n) { restante -= n; continue; } // a página ainda não começou neste dia
    const doDia = filtraEtapa(await eventosDoDia(c.dia), f.etapa);
    for (const e of doDia.slice(restante, restante + (f.limit - events.length))) events.push(paraSaida(e));
    restante = 0;
  }
  return { total, events };
}

/** Itera TODOS os eventos do agente no período, um dia por vez (pro CSV). */
export async function* iterLogAgente(
  startDate: string, endDate: string, etapa?: 'disparo' | 'resposta',
): AsyncGenerator<EventOut> {
  for (const dia of daysBetween(startDate, endDate)) {
    for (const e of filtraEtapa(await eventosDoDia(dia), etapa)) yield paraSaida(e);
  }
}

/** Resumo de um dia do agente (é o que fica guardado no Postgres). */
export interface AgenteDia { dia: string; disparos: number; respostas: number; }

/**
 * Agrega os eventos por dia de Brasília, em COORTE: a resposta é contada no dia
 * do DISPARO (mesma regra do resto do painel), não no dia em que ela chegou.
 */
export function agregarPorDia(rows: EventRow[]): AgenteDia[] {
  const diaDoDisparo = new Map<string, string>();
  const agg = new Map<string, AgenteDia>();
  const get = (dia: string): AgenteDia => {
    let a = agg.get(dia);
    if (!a) { a = { dia, disparos: 0, respostas: 0 }; agg.set(dia, a); }
    return a;
  };
  for (const r of rows) {
    if (r.etapa !== 'disparo') continue;
    const dia = brDay(new Date(r.ts));
    diaDoDisparo.set(r.conversation_id, dia);
    get(dia).disparos++;
  }
  for (const r of rows) {
    if (r.etapa !== 'resposta') continue;
    const dia = diaDoDisparo.get(r.conversation_id);
    if (dia) get(dia).respostas++;
  }
  return [...agg.values()].sort((a, b) => (a.dia < b.dia ? -1 : a.dia > b.dia ? 1 : 0));
}

/**
 * Deriva os eventos (disparo + resposta) do agente para [startDate, endDate]
 * (dias de Brasília, inclusivo). Já sai no formato do store de eventos.
 */
export async function deriveAgenteEvents(startDate: string, endDate: string): Promise<EventRow[]> {
  const disparos: Linha[] = [];
  for (const dia of daysBetween(startDate, endDate)) {
    disparos.push(...await disparosEntregues(dia));
  }
  if (disparos.length === 0) return [];

  // Respostas do período + a "cauda" da janela (quem respondeu depois do fim).
  const respostas: Linha[] = [];
  for (const dia of daysBetween(startDate, addDays(endDate, DIAS_EXTRA_RESPOSTA))) {
    respostas.push(...await fetchDia('respostas', dia));
  }
  return cruzarAgente(disparos, respostas);
}
