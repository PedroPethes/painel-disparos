-- Log de disparos do worker de fluxos (D1/SQLite).
-- Schema de referência, reconstruído a partir das queries do worker.
CREATE TABLE IF NOT EXISTS fluxos_logs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_body         TEXT,          -- payload recebido, como chegou
  status           TEXT,          -- sent | forward_error | forward_exception | dry_run | no_route | unauthorized | error | method_not_allowed
  error_message    TEXT,
  name             TEXT,
  email            TEXT,
  phone            TEXT,          -- normalizado com DDI 55
  fluxo            TEXT,          -- valor bruto do campo de roteamento
  tipo_cliente     TEXT,          -- novo | recorrente | desconhecido
  contact_id       TEXT,          -- id do contato no CRM (quando classificado por lá)
  classificado_via TEXT,          -- hubspot | welcome-worker | nenhum
  webhook_url      TEXT,          -- rota escolhida
  created_at       TEXT           -- 'YYYY-MM-DD HH:MM:SS' em horário de Brasília
);

CREATE INDEX IF NOT EXISTS idx_fluxos_logs_dia    ON fluxos_logs (created_at);
CREATE INDEX IF NOT EXISTS idx_fluxos_logs_status ON fluxos_logs (status);
