// Integração contra Postgres LOCAL (dados sintéticos, sem Metabase).
// Trava as duas semânticas: funil por coorte do disparo × log pelo instante do evento.
import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { migrate, upsertEvents, queryFunnel, queryEvents, iterEvents, endPool, pool } from '../src/db';
import type { EventRow } from '../src/events';

// Guarda de segurança: TRUNCATE só pode rodar em banco local.
if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '')) {
  throw new Error('testes de store só rodam em DATABASE_URL local (proteção contra TRUNCATE em produção)');
}

// Conversa B tem resposta TARDIA (no dia seguinte ao disparo).
const EV: EventRow[] = [
  { conversation_id: 'A', etapa: 'disparo',  ts: '2026-01-10T12:00:00Z', bot: 1201, telefone: '5511111111111' },
  { conversation_id: 'A', etapa: 'resposta', ts: '2026-01-10T12:10:00Z', bot: 1201, telefone: '5511111111111' },
  { conversation_id: 'B', etapa: 'disparo',  ts: '2026-01-10T23:00:00Z', bot: 1201, telefone: '5522222222222' },
  { conversation_id: 'B', etapa: 'resposta', ts: '2026-01-11T14:00:00Z', bot: 1201, telefone: '5522222222222' },
  { conversation_id: 'C', etapa: 'disparo',  ts: '2026-01-10T15:00:00Z', bot: 1200, telefone: '5533333333333' },
];

before(async () => {
  await migrate();
  await pool().query('TRUNCATE events');
  await upsertEvents(EV);
});
after(async () => { await pool().query('TRUNCATE events'); await endPool(); });

test('upsert é idempotente (rodar de novo não duplica)', async () => {
  await upsertEvents(EV);
  const c = (await pool().query('SELECT count(*)::int c FROM events')).rows[0].c;
  assert.equal(c, 5);
});

test('funil = coorte: resposta tardia conta no dia do DISPARO', async () => {
  const { daily, totals } = await queryFunnel('2026-01-10', '2026-01-10');
  assert.equal(totals.disparos, 3);
  assert.equal(totals.respostas, 2); // A e B, ambas atribuídas ao dia 10 (dia do disparo)
  const b1201 = daily.find((d) => d.bot === 1201);
  assert.deepEqual([b1201?.disparos, b1201?.respostas], [2, 2]);
  const b1200 = daily.find((d) => d.bot === 1200);
  assert.deepEqual([b1200?.disparos, b1200?.respostas], [1, 0]);
});

test('log = instante do evento: resposta tardia aparece no dia seguinte', async () => {
  const d10 = await queryEvents({ startDate: '2026-01-10', endDate: '2026-01-10', limit: 100, offset: 0 });
  assert.equal(d10.total, 4); // A disparo, A resposta, B disparo, C disparo
  const d11 = await queryEvents({ startDate: '2026-01-11', endDate: '2026-01-11', limit: 100, offset: 0 });
  assert.equal(d11.total, 1); // B resposta (chegou no dia 11)
});

test('filtro por bot e por etapa', async () => {
  const soResp = await queryEvents({ startDate: '2026-01-09', endDate: '2026-01-12', etapa: 'resposta', limit: 100, offset: 0 });
  assert.equal(soResp.total, 2);
  const so1200 = await queryEvents({ startDate: '2026-01-09', endDate: '2026-01-12', bots: [1200], limit: 100, offset: 0 });
  assert.equal(so1200.total, 1);
});

test('iterEvents percorre todos os eventos do período', async () => {
  const all: unknown[] = [];
  for await (const e of iterEvents('2026-01-09', '2026-01-12')) all.push(e);
  assert.equal(all.length, 5);
});

test('timestamp sai no fuso de Brasília (-03:00)', async () => {
  const { events } = await queryEvents({ startDate: '2026-01-10', endDate: '2026-01-10', limit: 1, offset: 0 });
  assert.match(events[0].timestamp, /^2026-01-10T\d{2}:\d{2}:\d{2}-03:00$/);
});
