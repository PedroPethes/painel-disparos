import { test } from 'node:test';
import assert from 'node:assert';
import { cruzarAgente, agregarPorDia, chaveTelefone, AGENTE_BOT, type Linha } from '../src/agente';

const d = (id: string, ts: string, telefone: string): Linha => ({ id, ts, telefone });
const r = (ts: string, telefone: string): Linha => ({ id: `r-${ts}`, ts, telefone });

test('chaveTelefone: com e sem o nono dígito viram a mesma chave', () => {
  assert.equal(chaveTelefone('5531988887777'), chaveTelefone('553188887777'));
  assert.equal(chaveTelefone('+55 (31) 98888-7777'), '553188887777');
  assert.equal(chaveTelefone('5511987654321'), '551187654321');
  assert.equal(chaveTelefone(null), null);
  assert.equal(chaveTelefone(''), null);
  // fixo (12 dígitos, sem 9 na frente) fica como está
  assert.equal(chaveTelefone('553133334444'), '553133334444');
});

test('resposta dentro da janela marca o disparo; sem resposta não gera linha', () => {
  const rows = cruzarAgente(
    [d('a', '2026-07-20T12:00:00.000Z', '5531988887777'), d('b', '2026-07-20T12:00:00.000Z', '5511987654321')],
    [r('2026-07-20T13:30:00.000Z', '553188887777')], // mesma pessoa, sem o 9
  );
  assert.equal(rows.filter((x) => x.etapa === 'disparo').length, 2);
  const resp = rows.filter((x) => x.etapa === 'resposta');
  assert.equal(resp.length, 1);
  assert.equal(resp[0].conversation_id, 'a');
  assert.equal(resp[0].bot, AGENTE_BOT);
});

test('resposta depois de 72h não conta', () => {
  const rows = cruzarAgente(
    [d('a', '2026-07-20T12:00:00.000Z', '5531988887777')],
    [r('2026-07-23T13:00:00.000Z', '5531988887777')], // 73h depois
  );
  assert.equal(rows.filter((x) => x.etapa === 'resposta').length, 0);
});

test('resposta anterior ao disparo não conta', () => {
  const rows = cruzarAgente(
    [d('a', '2026-07-20T12:00:00.000Z', '5531988887777')],
    [r('2026-07-20T11:00:00.000Z', '5531988887777')],
  );
  assert.equal(rows.filter((x) => x.etapa === 'resposta').length, 0);
});

test('duas mensagens do mesmo cliente marcam UM disparo só, com o horário da primeira', () => {
  const rows = cruzarAgente(
    [d('a', '2026-07-20T12:00:00.000Z', '5531988887777')],
    [r('2026-07-20T15:00:00.000Z', '5531988887777'), r('2026-07-20T13:00:00.000Z', '5531988887777')],
  );
  const resp = rows.filter((x) => x.etapa === 'resposta');
  assert.equal(resp.length, 1);
  assert.equal(resp[0].ts, '2026-07-20T13:00:00.000Z');
});

test('cliente que recebeu 2 disparos: a resposta vai só pro mais recente antes dela', () => {
  const rows = cruzarAgente(
    [d('a', '2026-07-20T12:00:00.000Z', '5531988887777'), d('b', '2026-07-21T12:00:00.000Z', '5531988887777')],
    [r('2026-07-21T14:00:00.000Z', '5531988887777')],
  );
  const resp = rows.filter((x) => x.etapa === 'resposta');
  assert.equal(resp.length, 1);
  assert.equal(resp[0].conversation_id, 'b');
});

test('resumo por dia: coorte (resposta conta no dia do disparo) e fuso de Brasília', () => {
  // disparo 20/07 às 23h de Brasília (= 21/07 02:00 UTC), resposta 4h depois (21/07 BR)
  const rows = cruzarAgente(
    [d('a', '2026-07-21T02:00:00.000Z', '5531988887777'), d('b', '2026-07-21T02:30:00.000Z', '5511987654321')],
    [r('2026-07-21T06:00:00.000Z', '5531988887777')],
  );
  const dias = agregarPorDia(rows);
  assert.deepEqual(dias, [{ dia: '2026-07-20', disparos: 2, respostas: 1 }]);
});

test('resposta de número que nunca recebeu disparo é ignorada', () => {
  const rows = cruzarAgente(
    [d('a', '2026-07-20T12:00:00.000Z', '5531988887777')],
    [r('2026-07-20T13:00:00.000Z', '5599999999999')],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].etapa, 'disparo');
});
