// Demo estático: roda o painel inteiro no navegador, sem servidor.
//
// Intercepta o `fetch` das rotas da API e responde com os MESMOS dados
// fictícios e as MESMAS funções de agregação do modo demo do servidor
// (`src/demo.ts` + `src/derive.ts`) — nada de respostas gravadas à mão, então
// o painel publicado não diverge do que roda localmente.
//
// Compilado para `docs/demo-api.js` (ver npm run build:pages).
import { demoFunnel, demoQueryEvents, demoIterEvents, demoLeads } from './demo';
import { SEGMENTS, BOT_TO_SEGMENT, segmentLabel } from './events';

// Mesmo mapa de segmentos do servidor (src/server.ts).
function segmentToBots(seg?: string | null): number[] | undefined {
  if (seg === 'novos') return [SEGMENTS.novos.bot];
  if (seg === 'recorrentes') return [SEGMENTS.recorrentes.bot];
  if (seg === 'welcome') return [SEGMENTS.fluxo_welcome.bot];
  if (seg === 'carrinho') return [SEGMENTS.fluxo_carrinho.bot];
  if (seg === 'ambos') return [SEGMENTS.novos.bot, SEGMENTS.recorrentes.bot];
  if (seg === 'carrinho_antigo') return [SEGMENTS.carrinho.bot];
  if (seg === 'agente') return [SEGMENTS.agente.bot];
  if (seg === 'welcometof') return [SEGMENTS.welcometof.bot];
  if (seg === 'upsell') return [SEGMENTS.upsell.bot];
  if (seg === 'pageview') return [SEGMENTS.pageview.bot];
  return undefined; // vazio -> todos os segmentos
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const DEFAULT_DAYS = 30;
const MAX_DAYS = 180;

function brToday(): string {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}
function shiftDay(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Mesmo contrato do parsePeriod do servidor: padrão 30 dias, teto 180. */
function period(q: URLSearchParams): { startDate: string; endDate: string } {
  const endDate = q.get('endDate') || brToday();
  const startDate = q.get('startDate') || shiftDay(endDate, -(DEFAULT_DAYS - 1));
  const limite = shiftDay(endDate, -(MAX_DAYS - 1));
  return { startDate: startDate < limite ? limite : startDate, endDate };
}

function handle(url: URL): Response | null {
  const q = url.searchParams;
  const path = url.pathname.replace(/\/+$/, '') || '/';

  // O painel usa /health pra saber que está em demo e pular o portão de token.
  if (path.endsWith('/health')) {
    return json({ ok: true, mode: 'demo', demo: true, static: true });
  }

  if (path.endsWith('/api/funil')) {
    const p = period(q);
    const bots = segmentToBots(q.get('segment'));
    const { daily, totals } = demoFunnel(p.startDate, p.endDate, bots);
    const rows = daily.map((d) => ({
      ...d,
      segmento: BOT_TO_SEGMENT[d.bot],
      label: segmentLabel(d.bot),
    }));
    const taxa = totals.disparos ? totals.respostas / totals.disparos : 0;
    return json({ period: p, segments: SEGMENTS, totals: { ...totals, taxa }, daily: rows });
  }

  if (path.endsWith('/api/eventos')) {
    const p = period(q);
    const bots = segmentToBots(q.get('segment'));
    const etapaRaw = q.get('etapa');
    const etapa = etapaRaw && etapaRaw !== 'todas' ? (etapaRaw as 'disparo' | 'resposta') : undefined;

    if (q.get('format') === 'csv') {
      const linhas = ['timestamp,segmento,etapa,telefone'];
      for (const e of demoIterEvents(p.startDate, p.endDate)) {
        if (bots && !bots.includes(e.bot)) continue;
        if (etapa && e.etapa !== etapa) continue;
        linhas.push(`${e.timestamp},${segmentLabel(e.bot)},${e.etapa},${e.telefone ?? ''}`);
      }
      return new Response(linhas.join('\n') + '\n', {
        status: 200,
        headers: { 'Content-Type': 'text/csv; charset=utf-8' },
      });
    }

    const limit = Math.min(parseInt(q.get('limit') || '', 10) || 1000, 5000);
    const offset = parseInt(q.get('offset') || '', 10) || 0;
    const { total, events } = demoQueryEvents({
      startDate: p.startDate, endDate: p.endDate, bots, etapa, limit, offset,
    });
    const out = events.map((e) => ({
      timestamp: e.timestamp,
      segmento: segmentLabel(e.bot),
      etapa: e.etapa,
      telefone: e.telefone,
    }));
    return json({ period: p, total, limit, offset, events: out });
  }

  if (path.endsWith('/api/leads')) {
    const p = period(q);
    const bots = segmentToBots(q.get('segment'));
    return json({ period: p, ...demoLeads(p.startDate, p.endDate, bots) });
  }

  return null;
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    const url = new URL(href, window.location.href);
    const res = handle(url);
    if (res) return res;
  } catch {
    /* URL estranha: cai no fetch de verdade */
  }
  return realFetch(input as RequestInfo, init);
};
