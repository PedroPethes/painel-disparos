// Worker de fluxos — a ORIGEM dos disparos que o painel mostra nas visões de fluxo.
//
// Recebe os leads do CRM/automação do cliente (POST), classifica o cliente como
// novo ou recorrente (HubSpot; fallback via service binding), roteia o payload
// para o webhook do fluxo certo na plataforma de atendimento (WhatsApp) e
// registra cada tentativa no D1 (`fluxos_logs`). O painel lê os disparos daqui
// pelo GET /export (token só-leitura).
import { CAMPOS_ROTEAMENTO, isCarrinho, resolverRota } from './rotas.js';

// Injeta UTMs no link de checkout do carrinho abandonado (atribuição de venda).
function utmizarLinkCheckout(link, tipoCliente) {
  if (!link || typeof link !== 'string' || !/^https?:\/\//i.test(link.trim())) return link;
  const utms = {
    utm_campaign: 'abandoned_cart_ia',
    utm_source: 'whatsapp',
    utm_medium: 'whatsapp_fluxo',
    utm_term: tipoCliente === 'recorrente' ? 'cliente' : 'lead',
    utm_content: 'plataforma',
  };
  try {
    const url = new URL(link.trim());
    for (const [k, v] of Object.entries(utms)) url.searchParams.set(k, v);
    return url.toString();
  } catch {
    return link;
  }
}

function nowBRT() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' });
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function formatPhone(phone) {
  let f = String(phone || '').replace(/\D/g, '').replace(/^0+/, '');
  if (f && f.length <= 11 && !f.startsWith('55')) f = '55' + f;
  return f;
}

// Comparação em tempo constante — evita timing attack no token.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function presentedToken(request, url) {
  const header = request.headers.get('authorization') || '';
  const headerToken = header.replace(/^Bearer\s+/i, '').trim();
  const queryToken = (url.searchParams.get('token') || '').trim();
  return headerToken || queryToken;
}

// Aceita os formatos de payload dos vários CRMs/automações (corpo direto,
// array de itens, corpo aninhado) e normaliza para { name, email, phone, fluxo }.
function normalizePayload(rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const candidates = [];
  const pushObj = (o) => {
    if (o && typeof o === 'object' && !Array.isArray(o)) candidates.push(o);
  };
  if (Array.isArray(body)) {
    const b0 = body[0];
    pushObj(b0?.body);
    pushObj(b0?.items?.[0]?.json);
    pushObj(b0);
  } else if (body && typeof body === 'object') {
    pushObj(body.body);
    pushObj(body.items?.[0]?.json);
    pushObj(body);
  }
  for (const d of candidates) {
    const phone = d.phone || d.phone_checkout || d.telefone || d.whatsapp || d.celular || '';
    const name = d.first_name || d.name || d.nome || d.firstName || d.Nome_do_cliente || '';
    const email = d.email || d.e_mail || d.mail || '';
    if (phone || email) {
      let fluxo = '';
      for (const campo of CAMPOS_ROTEAMENTO) {
        if (d[campo] !== undefined && d[campo] !== null && String(d[campo]).trim()) {
          fluxo = String(d[campo]).trim();
          break;
        }
      }
      return {
        name: String(name || '').trim(),
        email: String(email || '').trim().toLowerCase(),
        phone: String(phone || '').trim(),
        fluxo,
        original: d,
      };
    }
  }
  return null;
}

async function hubspotSearchContact(token, { email, phone }) {
  const filterGroups = [];
  if (email) filterGroups.push({ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] });
  if (phone) {
    filterGroups.push({ filters: [{ propertyName: 'phone', operator: 'EQ', value: phone }] });
    filterGroups.push({ filters: [{ propertyName: 'mobilephone', operator: 'EQ', value: phone }] });
  }
  if (filterGroups.length === 0) return null;
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 1, filterGroups }),
  });
  if (!res.ok) throw new Error(`HubSpot contact search ${res.status}: ${await res.text()}`);
  return res.json();
}

// Cliente recorrente = tem pelo menos um negócio com entrega concluída.
async function hubspotHasShippedDeal(token, contactId) {
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filterGroups: [
        {
          filters: [
            { propertyName: 'dealstage', operator: 'EQ', value: 'shipped' },
            { propertyName: 'associations.contact', operator: 'EQ', value: contactId },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HubSpot deals search ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.total || 0) > 0;
}

// Fallback: outro worker (service binding) que sabe classificar novo/recorrente.
async function classifyViaWelcomeWorker(env, lead) {
  if (!env.WELCOME_WORKER) return null;
  const res = await env.WELCOME_WORKER.fetch('https://welcome-worker/?dry_run=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: lead.email, phone: lead.phone }),
  });
  if (!res.ok) throw new Error(`fallback classifier ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (!data.customer_type) return null;
  return {
    tipoCliente: data.customer_type,
    contactId: null,
    classified: !!data.classified,
    via: 'welcome-worker',
  };
}

async function classify(env, lead) {
  const token = (env.HUBSPOT_TOKEN || '').trim();
  if (!lead.email && !lead.phone) {
    return { tipoCliente: 'novo', contactId: null, classified: true, via: 'nenhum' };
  }
  if (!token) {
    const viaFallback = await classifyViaWelcomeWorker(env, lead);
    if (viaFallback) return viaFallback;
    return { tipoCliente: 'desconhecido', contactId: null, classified: false, via: 'nenhum' };
  }
  const contact = await hubspotSearchContact(token, {
    email: lead.email,
    phone: formatPhone(lead.phone),
  });
  const contactId = contact?.results?.[0]?.id || null;
  if (!contactId) return { tipoCliente: 'novo', contactId: null, classified: true, via: 'hubspot' };
  const recorrente = await hubspotHasShippedDeal(token, contactId);
  return { tipoCliente: recorrente ? 'recorrente' : 'novo', contactId, classified: true, via: 'hubspot' };
}

async function logD1(db, row) {
  if (!db) return;
  try {
    await db.prepare(
      `INSERT INTO fluxos_logs
         (raw_body, status, error_message, name, email, phone, fluxo, tipo_cliente, contact_id, classificado_via, webhook_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      row.rawBody ?? null,
      row.status ?? null,
      row.error ?? null,
      row.name ?? null,
      row.email ?? null,
      row.phone ?? null,
      row.fluxo ?? null,
      row.tipoCliente ?? null,
      row.contactId ?? null,
      row.via ?? null,
      row.webhookUrl ?? null,
      nowBRT()
    ).run();
  } catch (e) {
    console.error('logD1 failed:', String(e));
  }
}

// Nome canônico do fluxo (variações de escrita viram uma chave só).
const FLUXO_CANONICO_SQL = `CASE
  WHEN lower(fluxo) LIKE 'welcometof%' THEN 'welcometof'
  WHEN lower(fluxo) IN ('carrinhoabandonado','carrinho_abandonado') THEN 'carrinho'
  WHEN lower(fluxo) IN ('up-sell','upsell') THEN 'upsell'
  WHEN lower(fluxo) = 'pageview' THEN 'pageview'
  WHEN lower(fluxo) = 'welcome' THEN 'welcome'
  ELSE 'outro'
END`;
const TS_ISO_SQL = `replace(created_at, ' ', 'T') || '-03:00'`;

// GET /export — usado pelo painel (token só-leitura).
//   ?tipo=contagem&de=&ate=   -> disparos por dia/fluxo
//   ?tipo=disparos&dia=       -> linhas de um dia (paginado)
async function handleExport(request, url, env) {
  const expected = (env.METRICS_TOKEN || env.INGEST_TOKEN || '').trim();
  if (!expected || !safeEqual(presentedToken(request, url), expected)) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  const tipo = url.searchParams.get('tipo') || 'contagem';
  const DIA_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (tipo === 'contagem') {
    const de = url.searchParams.get('de') || '';
    const ate = url.searchParams.get('ate') || '';
    if (!DIA_RE.test(de) || !DIA_RE.test(ate)) {
      return jsonResponse({ error: 'de/ate devem ser YYYY-MM-DD' }, 400);
    }
    const { results } = await env.DB.prepare(
      `SELECT substr(created_at, 1, 10) AS dia, ${FLUXO_CANONICO_SQL} AS fluxo, COUNT(*) AS disparos
         FROM fluxos_logs
        WHERE status = 'sent' AND substr(created_at, 1, 10) >= ? AND substr(created_at, 1, 10) <= ?
        GROUP BY dia, fluxo ORDER BY dia, fluxo`
    ).bind(de, ate).all();
    return jsonResponse({ dias: results }, 200);
  }
  if (tipo === 'disparos') {
    const dia = url.searchParams.get('dia') || '';
    if (!DIA_RE.test(dia)) return jsonResponse({ error: 'dia deve ser YYYY-MM-DD' }, 400);
    const fluxo = (url.searchParams.get('fluxo') || '').trim().toLowerCase();
    const limit = Math.min(Number(url.searchParams.get('limit') || 5000), 10000);
    const offset = Number(url.searchParams.get('offset') || 0);
    const where = ["status = 'sent'", 'substr(created_at, 1, 10) = ?'];
    const binds = [dia];
    if (fluxo) {
      where.push(`${FLUXO_CANONICO_SQL} = ?`);
      binds.push(fluxo);
    }
    const cond = where.join(' AND ');
    const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM fluxos_logs WHERE ${cond}`).bind(...binds).first();
    const { results } = await env.DB.prepare(
      `SELECT id, ${TS_ISO_SQL} AS ts, phone AS telefone, ${FLUXO_CANONICO_SQL} AS fluxo, tipo_cliente
         FROM fluxos_logs WHERE ${cond} ORDER BY id ASC LIMIT ? OFFSET ?`
    ).bind(...binds, limit, offset).all();
    return jsonResponse({ total: totalRow?.n ?? 0, linhas: results }, 200);
  }
  return jsonResponse({ error: 'tipo deve ser contagem ou disparos' }, 400);
}

// GET /logs — consulta ad hoc (debug) por telefone/status.
async function handleLogs(url, env) {
  const expected = (env.METRICS_TOKEN || env.INGEST_TOKEN || '').trim();
  const presented = (url.searchParams.get('token') || '').trim();
  if (!expected || !safeEqual(presented, expected)) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  const limit = Math.min(Number(url.searchParams.get('limit') || 100), 1000);
  const telefone = (url.searchParams.get('telefone') || '').replace(/\D/g, '');
  const status = (url.searchParams.get('status') || '').trim();
  let sql = 'SELECT id, created_at, status, phone, name, email, fluxo, tipo_cliente, classificado_via, webhook_url, error_message FROM fluxos_logs';
  const where = [];
  const binds = [];
  if (telefone) {
    where.push('phone LIKE ?');
    binds.push(`%${telefone.replace(/^55/, '')}`);
  }
  if (status) {
    where.push('status = ?');
    binds.push(status);
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY id DESC LIMIT ?';
  binds.push(limit);
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return jsonResponse({ total: results.length, logs: results }, 200);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return jsonResponse({ ok: true, worker: 'fluxos-worker', ts: nowBRT() }, 200);
    }
    if (request.method === 'GET' && url.pathname === '/export') {
      try {
        return await handleExport(request, url, env);
      } catch (e) {
        return jsonResponse({ error: String(e) }, 500);
      }
    }
    if (request.method === 'GET' && url.pathname === '/logs') {
      try {
        return await handleLogs(url, env);
      } catch (e) {
        return jsonResponse({ error: String(e) }, 500);
      }
    }

    if (request.method !== 'POST') {
      ctx.waitUntil(
        logD1(env.DB, {
          rawBody: `${request.method} ${url.pathname}${url.search}`,
          status: 'method_not_allowed',
          error: 'Method not allowed',
        })
      );
      return new Response('Method not allowed', { status: 405 });
    }

    const rawBody = await request.text();
    const ingestToken = (env.INGEST_TOKEN || '').trim();
    if (ingestToken && !safeEqual(presentedToken(request, url), ingestToken)) {
      ctx.waitUntil(logD1(env.DB, { rawBody, status: 'unauthorized', error: 'token inválido ou ausente' }));
      return jsonResponse({ error: 'unauthorized' }, 401);
    }

    try {
      const lead = normalizePayload(rawBody);
      if (!lead || !lead.phone) {
        ctx.waitUntil(
          logD1(env.DB, {
            rawBody,
            status: 'error',
            error: 'Unknown payload format or missing phone',
          })
        );
        return jsonResponse({ error: 'Unknown payload format or missing phone' }, 400);
      }

      const phone = formatPhone(lead.phone);
      let cls;
      try {
        cls = await classify(env, lead);
      } catch (e) {
        cls = { tipoCliente: 'novo', contactId: null, classified: false, via: 'nenhum', clsError: String(e) };
      }

      const webhookUrl = resolverRota(lead.fluxo, env, cls.tipoCliente);
      const payloadPlataforma = {
        ...lead.original,
        name: lead.name,
        phone,
        fluxo: lead.fluxo,
        tipo_cliente: cls.tipoCliente,
      };
      if (isCarrinho(lead.fluxo) && payloadPlataforma.link_checkout) {
        payloadPlataforma.link_checkout = utmizarLinkCheckout(
          payloadPlataforma.link_checkout,
          cls.tipoCliente
        );
      }

      if (!webhookUrl) {
        ctx.waitUntil(
          logD1(env.DB, {
            rawBody,
            status: 'no_route',
            error: cls.clsError ?? null,
            name: lead.name,
            email: lead.email,
            phone,
            fluxo: lead.fluxo,
            tipoCliente: cls.tipoCliente,
            contactId: cls.contactId,
            via: cls.via,
          })
        );
        return jsonResponse(
          {
            status: 'received_no_route',
            forwarded: false,
            tipo_cliente: cls.tipoCliente,
            classified: cls.classified,
            phone,
            fluxo: lead.fluxo || null,
            payload_preview: payloadPlataforma,
          },
          200
        );
      }

      const dryRun = url.searchParams.get('dry_run') === '1';
      if (dryRun) {
        ctx.waitUntil(
          logD1(env.DB, {
            rawBody,
            status: 'dry_run',
            name: lead.name,
            email: lead.email,
            phone,
            fluxo: lead.fluxo,
            tipoCliente: cls.tipoCliente,
            contactId: cls.contactId,
            via: cls.via,
            webhookUrl,
          })
        );
        return jsonResponse(
          {
            status: 'dry_run',
            forwarded: false,
            tipo_cliente: cls.tipoCliente,
            classified: cls.classified,
            phone,
            fluxo: lead.fluxo || null,
            webhook_url: webhookUrl,
            payload_preview: payloadPlataforma,
          },
          200
        );
      }

      ctx.waitUntil(
        (async () => {
          try {
            const resp = await fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payloadPlataforma),
            });
            await logD1(env.DB, {
              rawBody,
              status: resp.ok ? 'sent' : 'forward_error',
              error: resp.ok ? cls.clsError ?? null : `plataforma ${resp.status}: ${await resp.text()}`,
              name: lead.name,
              email: lead.email,
              phone,
              fluxo: lead.fluxo,
              tipoCliente: cls.tipoCliente,
              contactId: cls.contactId,
              via: cls.via,
              webhookUrl,
            });
          } catch (err) {
            await logD1(env.DB, {
              rawBody,
              status: 'forward_exception',
              error: String(err),
              name: lead.name,
              email: lead.email,
              phone,
              fluxo: lead.fluxo,
              tipoCliente: cls.tipoCliente,
              contactId: cls.contactId,
              via: cls.via,
              webhookUrl,
            });
          }
        })()
      );

      return jsonResponse(
        {
          status: 'ok',
          tipo_cliente: cls.tipoCliente,
          classified: cls.classified,
          phone,
          fluxo: lead.fluxo || null,
          webhook_url: webhookUrl,
        },
        200
      );
    } catch (error) {
      ctx.waitUntil(logD1(env.DB, { rawBody, status: 'error', error: String(error) }));
      return jsonResponse({ error: 'Internal server error' }, 500);
    }
  },
};
