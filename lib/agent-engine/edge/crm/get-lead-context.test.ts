import { describe, expect, it } from 'vitest';

import { getLeadContext, type LeadContextKnobs } from './get-lead-context';
import type { CrmEdgeConfig } from './mcp-client';
import type { Queryable } from '../../queue/queue';

const CONTACT_ROW = {
  name: 'Renan',
  display_name: null,
  email: null,
  phone_number: '5511999999999',
  tags: [],
  is_blocked: false,
  source: 'manual',
  consent: {},
  is_anonymized: false,
};

const CONVERSATION_ID = 'conv-1';

/** Mensagens ASC: 2 antes de um silêncio de 8h, 2 depois (retomada). */
const BASE = Date.parse('2026-08-01T08:00:00.000Z');
const iso = (horas: number) => new Date(BASE + horas * 3_600_000).toISOString();

function historyRow(horas: number, direction: 'inbound' | 'outbound', body: string) {
  return {
    direction,
    type: 'text',
    body,
    media_url: null,
    media_storage_path: null,
    media_mime: null,
    media_derived_text: null,
    sent_at: iso(horas),
  };
}

const ANTES = [historyRow(0, 'inbound', 'oi'), historyRow(0.2, 'outbound', 'oi, tudo bem?')];
const DEPOIS = [historyRow(9, 'inbound', 'fechado, pode mandar'), historyRow(9.1, 'outbound', 'combinado!')];

/** Db fake: identifica a query pelo texto e devolve rows fixas — sem SQL real. */
function dbFake(historyDesc: typeof ANTES): Queryable {
  return {
    async query(text: string) {
      if (text.includes('from contacts')) return { rows: [CONTACT_ROW] } as never;
      if (text.includes('from conversations')) return { rows: [{ id: CONVERSATION_ID }] } as never;
      if (text.includes('from crm_lead_activities')) return { rows: [] } as never;
      if (text.includes('from messages')) return { rows: [...historyDesc].reverse() } as never;
      throw new Error(`query inesperada no teste: ${text}`);
    },
  };
}

const KNOBS_BASE: Omit<LeadContextKnobs, 'sessionGapHours'> = { historyLimit: 20, maxTokens: 1000 };

describe('getLeadContext — fronteira de sessão (Spec 16 §4)', () => {
  it('com sessionGapHours configurado, corta o histórico antes da retomada', async () => {
    const db = dbFake([...ANTES, ...DEPOIS]);
    const result = await getLeadContext(
      db,
      {} as CrmEdgeConfig,
      { tenantId: 'org-1', leadId: 'contact-1', conversationId: CONVERSATION_ID },
      { ...KNOBS_BASE, sessionGapHours: 6 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.messages).toHaveLength(2);
    expect(result.context.messages.map((m) => m.body)).toEqual([
      'fechado, pode mandar',
      'combinado!',
    ]);
  });

  it('sessionGapHours null mantém o payload idêntico ao comportamento anterior (sem corte)', async () => {
    const db = dbFake([...ANTES, ...DEPOIS]);
    const result = await getLeadContext(
      db,
      {} as CrmEdgeConfig,
      { tenantId: 'org-1', leadId: 'contact-1', conversationId: CONVERSATION_ID },
      { ...KNOBS_BASE, sessionGapHours: null },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.messages).toHaveLength(4);
  });

  it('sessionGapHours ausente (chamador não migrado) equivale a null — sem corte', async () => {
    const db = dbFake([...ANTES, ...DEPOIS]);
    const result = await getLeadContext(
      db,
      {} as CrmEdgeConfig,
      { tenantId: 'org-1', leadId: 'contact-1', conversationId: CONVERSATION_ID },
      KNOBS_BASE,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.messages).toHaveLength(4);
  });

  it('conversa sem silêncio ≥ gap não é cortada mesmo com muitas mensagens', async () => {
    const contínuas = Array.from({ length: 6 }, (_, i) =>
      historyRow(i * 0.5, i % 2 === 0 ? 'inbound' : 'outbound', `msg ${i}`),
    );
    const db = dbFake(contínuas);
    const result = await getLeadContext(
      db,
      {} as CrmEdgeConfig,
      { tenantId: 'org-1', leadId: 'contact-1', conversationId: CONVERSATION_ID },
      { ...KNOBS_BASE, sessionGapHours: 6 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.messages).toHaveLength(6);
  });
});
