import { describe, expect, it } from 'vitest';

import { cortarNaFronteiraDeSessao } from './fronteira-de-sessao';

const BASE = Date.parse('2026-08-01T08:00:00.000Z');
const h = (horas: number) => BASE + horas * 3_600_000;
const msg = (horas: number, id: string) => ({ id, sent_at: new Date(h(horas)).toISOString() });

describe('cortarNaFronteiraDeSessao', () => {
  it('conversa contínua de 10h com intervalos de 30min não é cortada (corte é por silêncio, não duração)', () => {
    const mensagens = Array.from({ length: 21 }, (_, i) => msg(i * 0.5, `m${i}`));
    expect(cortarNaFronteiraDeSessao(mensagens, 6)).toEqual(mensagens);
  });

  it('silêncio de 8h no meio corta a partir da retomada (inclusive)', () => {
    const antes = [msg(0, 'a1'), msg(1, 'a2')];
    const depois = [msg(9, 'b1'), msg(9.5, 'b2')]; // 8h de silêncio entre a2 (h1) e b1 (h9)
    expect(cortarNaFronteiraDeSessao([...antes, ...depois], 6)).toEqual(depois);
  });

  it('dois silêncios (10h e depois 7h) corta a partir do mais recente', () => {
    const bloco1 = [msg(0, 'a1')];
    const bloco2 = [msg(10, 'b1')]; // 10h de silêncio após a1
    const bloco3 = [msg(17, 'c1'), msg(17.2, 'c2')]; // 7h de silêncio após b1
    expect(cortarNaFronteiraDeSessao([...bloco1, ...bloco2, ...bloco3], 6)).toEqual(bloco3);
  });

  it('gapHoras null devolve o array intacto (fronteira desligada)', () => {
    const mensagens = [msg(0, 'a1'), msg(20, 'a2')];
    expect(cortarNaFronteiraDeSessao(mensagens, null)).toBe(mensagens);
  });

  it('gapHoras 0 e negativo devolvem o array intacto', () => {
    const mensagens = [msg(0, 'a1'), msg(20, 'a2')];
    expect(cortarNaFronteiraDeSessao(mensagens, 0)).toBe(mensagens);
    expect(cortarNaFronteiraDeSessao(mensagens, -3)).toBe(mensagens);
  });

  it('arrays de 0 e 1 elemento devolvem intactos', () => {
    expect(cortarNaFronteiraDeSessao([], 6)).toEqual([]);
    const um = [msg(0, 'a1')];
    expect(cortarNaFronteiraDeSessao(um, 6)).toBe(um);
  });

  it('sent_at inválido não lança e não quebra o corte ao redor dele', () => {
    const mensagens = [
      msg(0, 'a1'),
      { id: 'invalido', sent_at: 'not-a-date' },
      msg(9, 'b1'),
    ];
    expect(() => cortarNaFronteiraDeSessao(mensagens, 6)).not.toThrow();
  });

  it('é determinística: mesmo input produz mesmo output', () => {
    const mensagens = [msg(0, 'a1'), msg(9, 'b1'), msg(9.3, 'b2')];
    const r1 = cortarNaFronteiraDeSessao(mensagens, 6);
    const r2 = cortarNaFronteiraDeSessao(mensagens, 6);
    expect(r1).toEqual(r2);
  });
});
