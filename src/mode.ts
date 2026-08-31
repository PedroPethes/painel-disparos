// Em qual modo a API lê os dados. Um lugar só pra decidir.
//
//   store → há DATABASE_URL: lê do Postgres protegido (produção; a superfície pública
//           NÃO toca o Metabase). É o modo do deploy seguro.
//   live  → sem DATABASE_URL, mas com credenciais do Metabase: lê os números REAIS direto
//           do Metabase. Serve pra rodar/testar localmente sem instalar banco.
//   demo  → sem banco e sem Metabase (ou DEMO_MODE=1): dados de exemplo.

export type Mode = 'store' | 'live' | 'demo';

export function hasStore(): boolean {
  return !!process.env.DATABASE_URL;
}

export function hasMetabase(): boolean {
  return !!(process.env.METABASE_URL && process.env.METABASE_USER && process.env.METABASE_PASS);
}

export function mode(): Mode {
  if (hasStore()) return 'store';
  if (process.env.DEMO_MODE === '1') return 'demo';
  if (hasMetabase()) return 'live';
  return 'demo';
}
