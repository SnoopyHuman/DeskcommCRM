import { describe, expect, it } from 'vitest';

import { estadoVigente, getLeadState, type LeadStateRow } from './lead-state';
import type { Queryable } from '../queue/queue';

const BASE_ROW: LeadStateRow = {
  id: 'ls-1',
  organization_id: 'org-1',
  contact_id: 'contact-1',
  stage: 'negotiating',
  qualification: { budget: '10k' },
  next_action: 'ligar amanhã',
  next_action_seq: 2,
  updated_at: new Date('2026-08-01T10:00:00.000Z'),
};

describe('estadoVigente (Spec 16 §5.3 — neutraliza em leitura, nunca sobrescreve)', () => {
  it('row null devolve null (nada a neutralizar)', () => {
    expect(estadoVigente(null, '2026-08-01T00:00:00.000Z')).toBeNull();
  });

  it('cutoff null devolve o row intacto (comportamento anterior à feature)', () => {
    expect(estadoVigente(BASE_ROW, null)).toBe(BASE_ROW);
  });

  it('estado ANTERIOR ao cutoff vira null — turno opera como stage=new', () => {
    // updated_at (10:00) <= cutoff (11:00): neutralizado.
    expect(estadoVigente(BASE_ROW, '2026-08-01T11:00:00.000Z')).toBeNull();
  });

  it('estado POSTERIOR ao cutoff sobrevive intacto', () => {
    // updated_at (10:00) > cutoff (09:00): sobrevive.
    expect(estadoVigente(BASE_ROW, '2026-08-01T09:00:00.000Z')).toBe(BASE_ROW);
  });

  it('estado exatamente NO instante do cutoff é neutralizado (corte inclusivo do lado do cutoff)', () => {
    expect(estadoVigente(BASE_ROW, BASE_ROW.updated_at.toISOString())).toBeNull();
  });
});

/** Db fake: identifica a query pelo texto (join lead_state+contacts) e devolve rows fixas. */
function dbFake(row: (LeadStateRow & { _context_reset_at: string | null }) | null): Queryable {
  return {
    async query() {
      return { rows: row ? [row] : [] } as never;
    },
  };
}

describe('getLeadState — relê context_reset_at do contato a cada chamada', () => {
  it('sem cutoff, devolve o estado real', async () => {
    const db = dbFake({ ...BASE_ROW, _context_reset_at: null });
    const result = await getLeadState(db, 'org-1', 'contact-1');
    expect(result?.stage).toBe('negotiating');
    expect(result?.qualification).toEqual({ budget: '10k' });
  });

  it('com cutoff posterior ao updated_at, devolve null (neutralizado)', async () => {
    const db = dbFake({ ...BASE_ROW, _context_reset_at: '2026-08-01T11:00:00.000Z' });
    const result = await getLeadState(db, 'org-1', 'contact-1');
    expect(result).toBeNull();
  });

  it('com cutoff anterior ao updated_at, devolve o estado real (sobreviveu ao corte)', async () => {
    const db = dbFake({ ...BASE_ROW, _context_reset_at: '2026-08-01T09:00:00.000Z' });
    const result = await getLeadState(db, 'org-1', 'contact-1');
    expect(result?.stage).toBe('negotiating');
  });

  it('sem linha em lead_state, devolve null independente de cutoff', async () => {
    const db = dbFake(null);
    const result = await getLeadState(db, 'org-1', 'contact-1');
    expect(result).toBeNull();
  });

  it('o campo interno _context_reset_at nunca vaza no retorno', async () => {
    const db = dbFake({ ...BASE_ROW, _context_reset_at: '2026-08-01T09:00:00.000Z' });
    const result = await getLeadState(db, 'org-1', 'contact-1');
    expect(result).not.toHaveProperty('_context_reset_at');
  });

  it('com snapshot do turno, usa o corte passado e não depende da subquery', async () => {
    // dbFake ainda devolve _context_reset_at, mas com snapshot explícito o
    // helper ignora a coluna e aplica estadoVigente no valor passado.
    const db = dbFake({ ...BASE_ROW, _context_reset_at: '2026-08-01T09:00:00.000Z' });
    const neutralized = await getLeadState(
      db,
      'org-1',
      'contact-1',
      '2026-08-01T11:00:00.000Z',
    );
    expect(neutralized).toBeNull();
    const kept = await getLeadState(db, 'org-1', 'contact-1', null);
    expect(kept?.stage).toBe('negotiating');
  });
});
