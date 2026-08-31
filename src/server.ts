// API pública — lê SÓ do Postgres (sem credencial de produção).
// Serve o painel e expõe /api/funil (contagens) e /api/eventos (log json|csv).
import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import {
  queryEvents, queryFunnel, iterEvents, queryLeads, migrate, agenteDisparosPorDia,
} from './db';
import { SEGMENTS, BOT_TO_SEGMENT, segmentLabel, type Etapa } from './events';
import { AGENTE_BOT, logAgente, iterLogAgente } from './agente';
import { runDailyIngest, runRefresh } from './ingest';
import { mode } from './mode';

const app = express();
app.use(express.json());

const API_TOKEN = process.env.API_TOKEN || '';
const DEFAULT_DAYS = 30;
const MAX_DAYS = 180;

// ---------- auth (token) ----------
function getToken(req: Request): string | null {
  const h = req.headers['authorization'];
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7).trim();
  if (typeof req.query.token === 'string') return req.query.token; // p/ links de download do CSV
  return null;
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (mode() !== 'store') { next(); return; } // local (demo/ao vivo): acesso livre pra visualizar
  if (!API_TOKEN) { res.status(500).json({ error: 'API_TOKEN não configurado no servidor' }); return; }
  if (getToken(req) !== API_TOKEN) { res.status(401).json({ error: 'não autorizado' }); return; }
  next();
}

// ---------- rate limit (em memória, por token/IP) ----------
interface Win { count: number; reset: number; }
const perMin = new Map<string, Win>();
const perDay = new Map<string, Win>();

function hit(map: Map<string, Win>, key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  let w = map.get(key);
  if (!w || now >= w.reset) { w = { count: 0, reset: now + windowMs }; map.set(key, w); }
  w.count++;
  return w.count <= limit;
}

function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const key = getToken(req) || req.ip || 'anon';
  const ok = hit(perMin, key, 60, 60_000) && hit(perDay, key, 500, 24 * 3600_000);
  if (!ok) { res.status(429).json({ error: 'rate limit excedido' }); return; }
  next();
}

// ---------- validação de período ----------
type Period = { startDate: string; endDate: string };

function parsePeriod(req: Request): Period | { error: string } {
  const today = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const endDate = (req.query.endDate as string) || today;
  let startDate = req.query.startDate as string;
  if (!startDate) {
    const d = new Date(`${endDate}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() - (DEFAULT_DAYS - 1));
    startDate = d.toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return { error: 'datas devem ser YYYY-MM-DD' };
  }
  if (startDate > endDate) return { error: 'startDate maior que endDate' };
  const days = Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000) + 1;
  if (days > MAX_DAYS) return { error: `período máximo é ${MAX_DAYS} dias` };
  return { startDate, endDate };
}

function segmentToBots(seg?: string): number[] | undefined {
  if (seg === 'novos') return [SEGMENTS.novos.bot];
  if (seg === 'recorrentes') return [SEGMENTS.recorrentes.bot];
  // 'welcome' e 'carrinho' agora são SÓ o fluxo novo (2026-08-28: tudo
  // centralizado). O histórico dos bots antigos continua no banco — puxa
  // retroativamente com segment=ambos|novos|recorrentes|carrinho_antigo.
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

// ---------- endpoints ----------
// Funil + série diária (alimenta os gráficos e o resumo do painel).
app.get('/api/funil', requireAuth, rateLimit, async (req: Request, res: Response) => {
  const p = parsePeriod(req);
  if ('error' in p) { res.status(400).json(p); return; }
  const bots = segmentToBots(req.query.segment as string);
  try {
    const { daily, totals } = await queryFunnel(p.startDate, p.endDate, bots);
    const rows = daily.map((d) => ({ ...d, segmento: BOT_TO_SEGMENT[d.bot], label: segmentLabel(d.bot) }));
    const taxa = totals.disparos ? totals.respostas / totals.disparos : 0;
    res.json({ period: p, segments: SEGMENTS, totals: { ...totals, taxa }, daily: rows });
  } catch (e: any) { res.status(503).json({ error: e.message }); }
});

// Log de eventos (json paginado ou csv completo).
app.get('/api/eventos', requireAuth, rateLimit, async (req: Request, res: Response) => {
  const p = parsePeriod(req);
  if ('error' in p) { res.status(400).json(p); return; }
  const bots = segmentToBots(req.query.segment as string);
  const etapaRaw = req.query.etapa as string;
  const etapa: Etapa | undefined = etapaRaw && etapaRaw !== 'todas' ? (etapaRaw as Etapa) : undefined;
  // O log do agente NÃO está no banco (volume grande demais) — é montado na hora
  // lendo o worker payload-sink. Só vale quando a visão é só dele.
  const soAgente = !!bots && bots.length === 1 && bots[0] === AGENTE_BOT;
  const etapaAgente = etapa === 'disparo' || etapa === 'resposta' ? etapa : undefined;

  try {
    if ((req.query.format as string) === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="eventos_${p.startDate}_${p.endDate}.csv"`);
      res.write('timestamp,segmento,etapa,telefone\n');
      const fonte = soAgente
        ? iterLogAgente(p.startDate, p.endDate, etapaAgente)
        : iterEvents(p.startDate, p.endDate, bots);
      for await (const e of fonte) {
        if (bots && !bots.includes(e.bot)) continue;
        if (etapa && e.etapa !== etapa) continue;
        res.write(`${e.timestamp},${segmentLabel(e.bot)},${e.etapa},${e.telefone ?? ''}\n`);
      }
      res.end();
      return;
    }
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 1000, 5000);
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const { total, events } = soAgente
      ? await logAgente(
          { startDate: p.startDate, endDate: p.endDate, etapa: etapaAgente, limit, offset },
          await agenteDisparosPorDia(p.startDate, p.endDate),
        )
      : await queryEvents({ startDate: p.startDate, endDate: p.endDate, bots, etapa, limit, offset });
    const out = events.map((e) => ({ timestamp: e.timestamp, segmento: segmentLabel(e.bot), etapa: e.etapa, telefone: e.telefone }));
    res.json({ period: p, total, limit, offset, events: out });
  } catch (e: any) { res.status(503).json({ error: e.message }); }
});

// Leads por vendedor: total por vendedor (barras) + série diária (linha). Lê só do store.
app.get('/api/leads', requireAuth, rateLimit, async (req: Request, res: Response) => {
  const p = parsePeriod(req);
  if ('error' in p) { res.status(400).json(p); return; }
  const bots = segmentToBots(req.query.segment as string); // recorta pela Visão selecionada
  try {
    const { byVendor, daily } = await queryLeads(p.startDate, p.endDate, bots);
    res.json({ period: p, byVendor, daily });
  } catch (e: any) { res.status(503).json({ error: e.message }); }
});

// O painel usa `demo` pra pular o portão de token fora do modo protegido (demo/ao vivo).
app.get('/health', (_req: Request, res: Response) => {
  const m = mode();
  res.json({ ok: true, mode: m, demo: m !== 'store' });
});

app.use(express.static(path.join(__dirname, '..', 'dashboard')));

const PORT = process.env.PORT || 3000;
const INGEST_IN_PROCESS = process.env.INGEST_IN_PROCESS === '1';

// Agendador in-process: usado quando a ingestão roda no MESMO serviço da API
// (deploy de serviço único). No modo dois-serviços, deixe INGEST_IN_PROCESS
// desligado aqui e rode o ingestor num serviço/cron separado.
function scheduleIngest(): void {
  const DAY_MS = 24 * 3600 * 1000;
  const run = () => {
    runDailyIngest().catch((e) => console.error('[scheduler] ingestão falhou:', e.message));
  };
  setTimeout(run, 5000);    // logo após subir, sem bloquear o boot
  setInterval(run, DAY_MS); // e a cada 24h
}

// Atualização curta e frequente de TODAS as visões (Welcome, Carrinho e
// Disparos). Disparo, resposta, entrega e atribuição a vendedor pingam o dia
// inteiro, então o dia de hoje precisa ser refeito de tempos em tempos — a
// rodada diária sozinha deixa os números parados por horas.
function scheduleRefresh(): void {
  // REFRESH_MIN é o nome novo; AGENTE_REFRESH_MIN continua valendo porque já
  // está configurado no Railway (quando existia só o refresh do agente).
  const min = parseInt(process.env.REFRESH_MIN || process.env.AGENTE_REFRESH_MIN || '5', 10);
  const CADA_N_INCLUI_ONTEM = 6; // 6 × 5 min = ontem entra a cada ~30 min
  let n = 0;
  let rodando = false;
  const run = () => {
    // Uma rodada lenta não pode empilhar em cima da próxima: se ainda está
    // rodando, esta volta passa reto (a seguinte pega o mesmo dia mesmo assim).
    if (rodando) { console.warn('[refresh] rodada anterior ainda em curso — pulando esta volta'); return; }
    // Na maioria das voltas refaz só HOJE — é o dia que muda o tempo todo e o
    // mais barato de reler. De tempos em tempos inclui ONTEM, que ainda recebe
    // entrega e resposta atrasadas (madrugada adentro).
    const dias = n++ % CADA_N_INCLUI_ONTEM === 0 ? 2 : 1;
    rodando = true;
    runRefresh(dias)
      .catch((e) => console.error('[refresh] falhou:', e.message))
      .finally(() => { rodando = false; });
  };
  setTimeout(run, 2 * 60_000);    // logo depois do boot
  setInterval(run, min * 60_000);
  console.log(`[refresh] todas as visões a cada ${min} min (hoje; ontem a cada ${min * CADA_N_INCLUI_ONTEM} min)`);
}

(async () => {
  // idempotente; garante o schema na subida.
  await migrate().catch((e) => console.error('migrate falhou (segue mesmo assim):', e.message));
  app.listen(PORT, () => {
    const m = mode();
    console.log(`API on http://localhost:${PORT}  [modo: ${m}]`);
    if (m === 'demo') { console.log('[demo] dados de EXEMPLO (sem banco e sem Metabase) — acesso livre'); return; }
    if (m === 'live') { console.log('[live] lendo dados REAIS direto do Metabase (sem banco) — acesso livre'); return; }
    if (INGEST_IN_PROCESS) {
      console.log('[scheduler] ingestão in-process LIGADA (diária)');
      scheduleIngest();
      scheduleRefresh();
    }
  });
})();
