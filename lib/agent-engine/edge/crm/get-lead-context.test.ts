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
  context_reset_at: null as string | null,
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

/**
 * Db fake: identifica a query pelo texto e devolve rows fixas — sem SQL real.
 * O filtro de corte (`sent_at > coalesce($4, '-infinity')`) é aplicado AQUI
 * mesmo, imitando o Postgres, porque é o 4º parâmetro (`contact.context_reset_at`)
 * que prova que o valor lido de `contacts` chegou até a query de `messages`.
 */
function dbFake(historyDesc: typeof ANTES, contactOverrides: Partial<typeof CONTACT_ROW> = {}): Queryable {
  const contact = { ...CONTACT_ROW, ...contactOverrides };
  return {
    async query(text: string, values: unknown[] = []) {
      if (text.includes('from contacts')) return { rows: [contact] } as never;
      if (text.includes('from conversations')) return { rows: [{ id: CONVERSATION_ID }] } as never;
      if (text.includes('from crm_lead_activities')) return { rows: [] } as never;
      if (text.includes('from messages')) {
        const cutoff = values[3] as string | null;
        const filtrado = cutoff === null || cutoff === undefined
          ? historyDesc
          : historyDesc.filter((m) => Date.parse(m.sent_at) > Date.parse(cutoff));
        return { rows: [...filtrado].reverse() } as never;
      }
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

describe('getLeadContext — marca de corte contacts.context_reset_at (Spec 16 §5.1)', () => {
  it('com contact_reset_at setado, mensagens anteriores ao corte somem da leitura', async () => {
    const cutoff = iso(5); // entre ANTES (h0/h0.2) e DEPOIS (h9/h9.1)
    const db = dbFake([...ANTES, ...DEPOIS], { context_reset_at: cutoff });
    const result = await getLeadContext(
      db,
      {} as CrmEdgeConfig,
      { tenantId: 'org-1', leadId: 'contact-1', conversationId: CONVERSATION_ID },
      KNOBS_BASE,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.messages.map((m) => m.body)).toEqual(['fechado, pode mandar', 'combinado!']);
  });

  it('context_reset_at nulo mantém o payload idêntico ao comportamento anterior (sem corte)', async () => {
    const db = dbFake([...ANTES, ...DEPOIS], { context_reset_at: null });
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

  it('corte + fronteira de sessão combinam: o mais restritivo prevalece', async () => {
    // corte deixa passar ANTES+DEPOIS (h-1), mas a fronteira de sessão (6h)
    // ainda corta ANTES por causa do silêncio de 9h até DEPOIS.
    const db = dbFake([...ANTES, ...DEPOIS], { context_reset_at: iso(-1) });
    const result = await getLeadContext(
      db,
      {} as CrmEdgeConfig,
      { tenantId: 'org-1', leadId: 'contact-1', conversationId: CONVERSATION_ID },
      { ...KNOBS_BASE, sessionGapHours: 6 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.messages.map((m) => m.body)).toEqual(['fechado, pode mandar', 'combinado!']);
  });
});
