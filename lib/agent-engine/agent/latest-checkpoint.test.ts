import { describe, expect, it } from 'vitest';

import { latestCheckpoint, type LeadCheckpointRow } from './inbound-turn';
import type { Queryable } from '../queue/queue';

const BASE_ROW: LeadCheckpointRow = {
  id: 'chk-1',
  seq: '3',
  organization_id: 'org-1',
  contact_id: 'contact-1',
  job_id: null,
  commitments: ['enviar catálogo'],
  objections: [],
  next_action: 'ligar amanhã',
  rolling_summary: 'cliente pediu 5m de guipir preto',
  created_at: new Date('2026-08-01T10:00:00.000Z'),
};

/** Db fake: registra os params recebidos pra verificar que o cutoff é o 2º arg do contato. */
function dbFake(row: LeadCheckpointRow | null) {
  const calls: { text: string; values: unknown[] }[] = [];
  const db: Queryable = {
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return { rows: row ? [row] : [] } as never;
    },
  };
  return { db, calls };
}

describe('latestCheckpoint — respeita context_reset_at via subquery (Spec 16 §5.2)', () => {
  it('devolve o checkpoint mais recente quando não há corte', async () => {
    const { db, calls } = dbFake(BASE_ROW);
    const result = await latestCheckpoint(db, 'org-1', 'contact-1');
    expect(result).toEqual(BASE_ROW);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain('context_reset_at');
    expect(calls[0]!.text).toContain('coalesce');
    expect(calls[0]!.text).not.toMatch(/\bupdate\b|\bdelete\b/i);
  });

  it('a query nunca emite update/delete sobre lead_checkpoints — só leitura filtrada', async () => {
    const { db, calls } = dbFake(null);
    await latestCheckpoint(db, 'org-1', 'contact-1');
    expect(calls[0]!.text.trim().toLowerCase().startsWith('select')).toBe(true);
  });

  it('sem checkpoint algum, devolve null', async () => {
    const { db } = dbFake(null);
    const result = await latestCheckpoint(db, 'org-1', 'contact-1');
    expect(result).toBeNull();
  });

  it('passa tenantId e leadId como org+contato — os únicos parâmetros da chamada', async () => {
    const { db, calls } = dbFake(BASE_ROW);
    await latestCheckpoint(db, 'org-9', 'contact-9');
    expect(calls[0]!.values).toEqual(['org-9', 'contact-9']);
  });
});
