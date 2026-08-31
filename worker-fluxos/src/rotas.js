// Rotas: fluxo de disparo -> webhook da plataforma de atendimento.
//
// Cada fluxo (welcome, carrinho abandonado, upsell...) tem um webhook próprio
// na plataforma; o carrinho abandonado roteia por tipo de cliente
// (novo/recorrente). As URLs reais foram substituídas por placeholders —
// cada UUID identifica um fluxo na plataforma.

// Campos aceitos no payload para identificar o fluxo (CRMs variam o nome).
export const CAMPOS_ROTEAMENTO = [
  'fluxo',
  'Fluxo',
  'flow',
  'campanha',
  'variavel',
  'Variavel',
];

const WEBHOOK_WELCOME = 'https://SUA-PLATAFORMA/api/v1/webhook/UUID-WELCOME';
const WEBHOOK_WELCOME_TOF = 'https://SUA-PLATAFORMA/api/v1/webhook/UUID-WELCOME-TOF';
const WEBHOOK_CARRINHO_NOVO = 'https://SUA-PLATAFORMA/api/v1/webhook/UUID-CARRINHO-NOVO';
const WEBHOOK_CARRINHO_RECORRENTE = 'https://SUA-PLATAFORMA/api/v1/webhook/UUID-CARRINHO-RECORRENTE';

const ROTA_CARRINHO = {
  novo: WEBHOOK_CARRINHO_NOVO,
  recorrente: WEBHOOK_CARRINHO_RECORRENTE,
};

const WEBHOOK_UPSELL = 'https://SUA-PLATAFORMA/api/v1/webhook/UUID-UPSELL';
const WEBHOOK_PAGEVIEW = 'https://SUA-PLATAFORMA/api/v1/webhook/UUID-PAGEVIEW';

const ROTAS = {
  'welcome': WEBHOOK_WELCOME,
  // Variantes de campanha do welcome topo-de-funil (nomes reais das campanhas
  // removidos na versão pública; o fallback por prefixo cobre variantes novas).
  'welcometof - campanha a': WEBHOOK_WELCOME_TOF,
  'welcometof - campanha b': WEBHOOK_WELCOME_TOF,
  'welcometof - campanha c': WEBHOOK_WELCOME_TOF,
  'welcometof - campanha d': WEBHOOK_WELCOME_TOF,
  'carrinhoabandonado': ROTA_CARRINHO,
  'carrinho_abandonado': ROTA_CARRINHO,
  'up-sell': WEBHOOK_UPSELL,
  'upsell': WEBHOOK_UPSELL,
  'pageview': WEBHOOK_PAGEVIEW,
};

function normalizarChave(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function isCarrinho(valorFluxo) {
  const chave = normalizarChave(valorFluxo);
  return chave === 'carrinhoabandonado' || chave === 'carrinho_abandonado';
}

export function resolverRota(valorFluxo, env, tipoCliente) {
  const chave = normalizarChave(valorFluxo);
  if (chave) {
    for (const [k, rota] of Object.entries(ROTAS)) {
      if (normalizarChave(k) !== chave || !rota) continue;
      if (typeof rota === 'string') return rota;
      return rota[tipoCliente] || rota.novo;
    }
    if (chave.startsWith('welcometof')) return WEBHOOK_WELCOME_TOF;
  }
  return (env.WEBHOOK_DEFAULT || '').trim();
}
