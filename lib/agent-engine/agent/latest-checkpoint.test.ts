import { describe, expect, it } from 'vitest';

import { latestCheckpoint, loadContextResetAt, type LeadCheckpointRow } from './inbound-turn';
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

/** Db fake: registra os params recebidos pra verificar o snapshot do corte. */
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

describe('latestCheckpoint — respeita snapshot de context_reset_at (Spec 16 §5.2)', () => {
  it('devolve o checkpoint mais recente quando não há corte', async () => {
    const { db, calls } = dbFake(BASE_ROW);
    const result = await latestCheckpoint(db, 'org-1', 'contact-1', null);
    expect(result).toEqual(BASE_ROW);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain('coalesce');
    expect(calls[0]!.values).toEqual(['org-1', 'contact-1', null]);
    expect(calls[0]!.text).not.toMatch(/\bupdate\b|\bdelete\b/i);
  });

  it('a query nunca emite update/delete sobre lead_checkpoints — só leitura filtrada', async () => {
    const { db, calls } = dbFake(null);
    await latestCheckpoint(db, 'org-1', 'contact-1', null);
    expect(calls[0]!.text.trim().toLowerCase().startsWith('select')).toBe(true);
  });

  it('sem checkpoint algum, devolve null', async () => {
    const { db } = dbFake(null);
    const result = await latestCheckpoint(db, 'org-1', 'contact-1', null);
    expect(result).toBeNull();
  });

  it('passa o snapshot do corte como 3º parâmetro — não relê contacts na query', async () => {
    const { db, calls } = dbFake(BASE_ROW);
    await latestCheckpoint(db, 'org-9', 'contact-9', '2026-08-01T09:00:00.000Z');
    expect(calls[0]!.values).toEqual(['org-9', 'contact-9', '2026-08-01T09:00:00.000Z']);
    expect(calls[0]!.text).not.toContain('from contacts');
  });
});

describe('loadContextResetAt — leitura única do contato', () => {
  it('devolve o corte do contato', async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const db: Queryable = {
      async query(text: string, values: unknown[] = []) {
        calls.push({ text, values });
        return { rows: [{ context_reset_at: '2026-08-01T12:00:00.000Z' }] } as never;
      },
    };
    const result = await loadContextResetAt(db, 'org-1', 'contact-1');
    expect(result).toBe('2026-08-01T12:00:00.000Z');
    expect(calls[0]!.values).toEqual(['org-1', 'contact-1']);
  });

  it('contato sem corte devolve null', async () => {
    const db: Queryable = {
      async query() {
        return { rows: [{ context_reset_at: null }] } as never;
      },
    };
    expect(await loadContextResetAt(db, 'org-1', 'contact-1')).toBeNull();
  });
});
