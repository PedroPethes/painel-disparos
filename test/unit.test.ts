import { test } from 'node:test';
import assert from 'node:assert';
import { toEventRows, nextDay, segmentLabel, type ConversationDerived } from '../src/events';
import { sign } from '../src/webhook';

test('toEventRows: disparo sempre; resposta só quando há resposta_ts', () => {
  const conv: ConversationDerived[] = [
    { conversation_id: 'x', bot: 1201, telefone: '55', disparo_ts: '2026-01-01T00:00:00Z', resposta_ts: '2026-01-01T00:05:00Z' },
    { conversation_id: 'y', bot: 1200, telefone: '56', disparo_ts: '2026-01-01T00:00:00Z', resposta_ts: null },
  ];
  const rows = toEventRows(conv);
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((r) => r.etapa === 'disparo').length, 2);
  assert.equal(rows.filter((r) => r.etapa === 'resposta').length, 1);
  assert.equal(rows.find((r) => r.conversation_id === 'y' && r.etapa === 'resposta'), undefined);
});

test('nextDay soma um dia (aritmética UTC, cruza mês/ano)', () => {
  assert.equal(nextDay('2026-01-31'), '2026-02-01');
  assert.equal(nextDay('2026-12-31'), '2027-01-01');
});

test('segmentLabel mapeia os bots de Welcome', () => {
  assert.equal(segmentLabel(1201), 'Welcome Novos');
  assert.equal(segmentLabel(1200), 'Welcome Recorrentes');
});

test('sign: HMAC determinístico, formato sha256=<hex>, muda com o corpo', () => {
  const a = sign('segredo', '{"x":1}');
  assert.equal(a, sign('segredo', '{"x":1}'));
  assert.match(a, /^sha256=[0-9a-f]{64}$/);
  assert.notEqual(sign('segredo', '{"x":1}'), sign('segredo', '{"x":2}'));
  assert.notEqual(sign('segredo', '{"x":1}'), sign('outro', '{"x":1}'));
});
