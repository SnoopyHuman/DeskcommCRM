/**
 * Tool consolidada `get_lead_context` pós-fusão: o payload CURADO (contato +
 * últimas N mensagens) agora vem de LEITURA DIRETA das tabelas canônicas do CRM
 * (contacts/conversations/messages — mesmo banco), não mais de tools MCP.
 *
 * Garantias preservadas do design original:
 *   - org-scoped: TODA query filtra organization_id + contact_id de fonte
 *     confiável (closure do job — regra dura nº 1), nunca de payload;
 *   - erro vira MENSAGEM DE ENSINO pt-br pro modelo, nunca stack cru;
 *   - determinístico: mesmo input ⇒ mesmo payload byte-a-byte (truncamento é
 *     função pura do conteúdo);
 *   - is_blocked lido DIRETO da fonte (contacts) — não existe mais cache.
 */
import type { Queryable } from '../../queue/queue';
import type { CrmEdgeConfig } from './mcp-client';
import { deriveLgpdFromContact, type LgpdInput } from '../../guardrails/lgpd/legal-basis';
import { cortarNaFronteiraDeSessao } from '../../agent/fronteira-de-sessao';

/**
 * Heurística conservadora de contagem: ~3,5 chars/token para pt-br (BPE real fica
 * entre 3,5 e 4; dividir por menos SUPERESTIMA tokens — erra pro lado seguro).
 */
const CHARS_PER_TOKEN = 3.5;

export function countPayloadTokens(serialized: string): number {
  return Math.ceil(serialized.length / CHARS_PER_TOKEN);
}

/** Knobs do payload (env LEAD_CONTEXT_*; defaults documentados no .env.example). */
export interface LeadContextKnobs {
  /** Últimas N mensagens do histórico incluídas (default 20). */
  historyLimit: number;
  /** Teto do payload serializado, contado por countPayloadTokens (default 1000). */
  maxTokens: number;
  /**
   * Horas de silêncio que abrem sessão nova (Spec 16 §4); `null` desliga a
   * fronteira. Opcional: chamador que não passa mantém o comportamento atual
   * (histórico completo, sem corte de sessão). Resolvido de
   * `organizations.settings.context_lifecycle.session_gap_hours` via
   * `resolveSessionGapHours` (lib/schemas/context-lifecycle.ts) — nunca
   * hardcoded no call site.
   */
  sessionGapHours?: number | null;
}

/** Uma mensagem do histórico, já curada. */
export interface LeadContextMessage {
  direction: 'inbound' | 'outbound';
  /** Corpo textual; mídia usa o derivado (transcrição/visão/pdf) ou marcador [tipo]. */
  body: string;
  sent_at: string;
  /** Metadados de mídia (Onda 3): presentes só em mensagens com mídia. */
  type?: string;
  media_storage_path?: string | null;
  media_mime?: string | null;
}

/**
 * A última decisão HUMANA sobre a próxima ação que o agente propôs.
 *
 * Sem isto, gravar a recusa não servia para nada: a Wave 4 mostrava a decisão ao
 * humano e a escondia de quem precisava dela — evento sem consumer, e o agente
 * reproporia o que já foi negado. A promessa do épico é que o que o humano
 * decide vira contexto que a IA usa para retomar.
 *
 * `action` viaja junto porque "aprovado" sem dizer O QUÊ não serve ao próximo
 * turno.
 */
export interface UltimaDecisaoHumana {
  action: string;
  decision: 'approved' | 'dismissed';
  at: string;
}

/** Payload curado que o modelo recebe. */
export interface LeadContext {
  lead_id: string;
  contact: {
    name: string | null;
    phone: string | null;
    email: string | null;
    tags: string[];
    /** contacts.is_blocked lido NESTE turno (fonte da verdade do gate 1). */
    is_blocked: boolean;
  };
  conversation_id: string | null;
  /**
   * Identidade + relação comercial (Spec 16 §8.1), montada SÓ de dado
   * estruturado (`contacts` + `orders`) — nunca do `rolling_summary` nem de
   * `messages.body`. Sobrevive à fronteira de sessão e à expiração por etapa
   * (é o que impede o agente de tratar cliente recorrente como estranho).
   * `null` só para contato anonimizado (LGPD).
   */
  customer_file: string | null;
  /**
   * Aviso fixo (Spec 16 §8.2) para quando o corte tirou histórico da leitura —
   * por hard reset/expiração (`context_reset_at`) OU pela fronteira de sessão
   * (silêncio ≥ gap). Sem isto o modelo afirma "primeira conversa" para quem
   * já comprou — troca uma alucinação por outra. `null` quando nada foi
   * cortado neste turno.
   */
  previous_service_notice: string | null;
  /**
   * `null` quando nenhum humano decidiu nada sobre propostas deste contato.
   *
   * OBRIGATÓRIO, e a interrogação já foi tentada e revertida: com `?:` o
   * compilador fica calado sobre um `LeadContext` que nasce cego, e o próximo
   * a montar um esquece a decisão sem ninguém perceber — a cegueira silenciosa
   * que esta wave existe para matar. `get-lead-context-decisao.test.ts` cobre o
   * PRODUTOR; o tipo cobre todo mundo que constrói um contexto. São camadas
   * diferentes, não alternativas.
   */
  last_human_decision: UltimaDecisaoHumana | null;
  /** Últimas N mensagens, da mais antiga para a mais nova. */
  messages: LeadContextMessage[];
}

export type LeadContextErrorCode = 'lead_not_found' | 'crm_error' | 'crm_unavailable';

/**
 * Resultado da tool. `ok:false` é a mensagem de ensino pro modelo — pt-br,
 * instrutiva, sem stack e sem credencial.
 */
export type LeadContextResult =
  | { ok: true; context: LeadContext; tokenCount: number; lgpd: LgpdInput }
  | { ok: false; error: { code: LeadContextErrorCode; message: string } };

function teach(code: LeadContextErrorCode, message: string): LeadContextResult {
  return { ok: false, error: { code, message } };
}

interface ContactRow {
  name: string | null;
  display_name: string | null;
  email: string | null;
  phone_number: string | null;
  tags: string[] | null;
  is_blocked: boolean;
  source: string | null;
  consent: Record<string, unknown> | null;
  is_anonymized: boolean;
  /** Spec 16 §5: corte do contexto — relido do contato a cada turno, nunca de payload. */
  context_reset_at: string | null;
}

interface DecisionRow {
  type: string;
  payload: Record<string, unknown> | null;
  reason: string | null;
  performed_at: string;
}

/**
 * O texto vem do `payload.next_action`, não do `reason`.
 *
 * `reason` é a frase legível do humano ("Aprovou: ligar para o Carlos") e serve
 * à TELA; o payload guarda a ação crua, que é o que o próximo turno precisa
 * comparar com a proposta atual. Usar o reason obrigaria o modelo a desfazer o
 * prefixo em português — parsing de frase para recuperar dado que já existe
 * estruturado ao lado.
 */
function paraDecisao(row: DecisionRow): UltimaDecisaoHumana | null {
  const acao =
    typeof row.payload?.next_action === 'string' ? row.payload.next_action.trim() : '';
  if (acao === '') return null; // sem O QUÊ, dizer "aprovado" não ajuda ninguém.
  return {
    action: acao,
    decision: row.type === 'next_action_approved' ? 'approved' : 'dismissed',
    at: row.performed_at,
  };
}

interface OrderSummaryRow {
  total: number;
  ultimo_em: string | null;
  ultimo_valor_cents: string | number | null;
  moeda: string | null;
  ultimo_status: string | null;
}

/** pt-BR — só os 4 valores do check constraint de `orders.fulfillment_status`. */
const FULFILLMENT_STATUS_PT: Record<string, string> = {
  unpacked: 'aguardando separação',
  packed: 'embalado',
  shipped: 'enviado',
  delivered: 'entregue',
};

function formatDateBR(iso: string): string {
  const [data] = iso.split('T');
  const [ano, mes, dia] = (data ?? '').split('-');
  return dia && mes && ano ? `${dia}/${mes}/${ano}` : iso;
}

function formatMoneyBR(cents: number, currency: string): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: currency.trim() }).format(
    cents / 100,
  );
}

/**
 * Spec 16 §8.1 — identidade sempre; relação comercial só com pedido. Contato
 * anonimizado não gera ficha alguma (o veto LGPD vale antes de qualquer
 * outra regra). Consulta agregada sobre `orders` já filtra `is_anonymized`.
 */
function buildCustomerFile(
  contact: Pick<ContactRow, 'name' | 'display_name' | 'tags' | 'is_anonymized'>,
  orders: OrderSummaryRow,
): string | null {
  if (contact.is_anonymized) return null;
  const nome = contact.display_name ?? contact.name ?? 'sem nome';
  const tags = contact.tags && contact.tags.length > 0 ? ` (tags: ${contact.tags.join(', ')})` : '';
  const linhas = [`Cliente: ${nome}${tags}`];
  if (orders.total > 0 && orders.ultimo_em !== null && orders.ultimo_status !== null) {
    const valor = formatMoneyBR(Number(orders.ultimo_valor_cents ?? 0), orders.moeda ?? 'BRL');
    const status = FULFILLMENT_STATUS_PT[orders.ultimo_status] ?? orders.ultimo_status;
    const pedidos = orders.total === 1 ? 'pedido' : 'pedidos';
    linhas.push(`Relação: ${orders.total} ${pedidos} · último em ${formatDateBR(orders.ultimo_em)} · ${valor} · ${status}`);
  }
  return linhas.join('\n');
}

/** Spec 16 §8.2 — texto fixo, sem espaço pra especulação sobre o conteúdo perdido. */
const PREVIOUS_SERVICE_NOTICE =
  '[Houve atendimento anterior com este cliente. O conteúdo daquelas conversas não está ' +
  'disponível neste turno — não afirme que é o primeiro contato, e não tente adivinhar o que ' +
  'foi conversado. Se precisar de algo de lá, pergunte ao cliente.]';

interface HistoryRow {
  direction: 'inbound' | 'outbound';
  type: string;
  body: string | null;
  media_url: string | null;
  media_storage_path: string | null;
  media_mime: string | null;
  media_derived_text: string | null;
  sent_at: string;
}

export async function getLeadContext(
  db: Queryable,
  _cfg: CrmEdgeConfig,
  input: {
    tenantId: string;
    leadId: string;
    conversationId?: string | null;
    /** Snapshot do turno (Spec 16 §5). Se omitido, usa o valor lido do contato. */
    contextResetAt?: string | null;
  },
  knobs: LeadContextKnobs,
): Promise<LeadContextResult> {
  const { rows: contactRows } = await db.query<ContactRow>(
    `select name, display_name, email, phone_number, tags, is_blocked, source, consent, is_anonymized,
            context_reset_at::text as context_reset_at
     from contacts where organization_id = $1 and id = $2`,
    [input.tenantId, input.leadId],
  );
  const contact = contactRows[0];
  if (!contact) {
    return teach(
      'lead_not_found',
      'não encontrei esse lead nesta organização — confira o lead antes de continuar; se o problema persistir, peça handoff humano.',
    );
  }

  // Snapshot do turno tem precedência sobre a coluna recém-lida — evita o
  // prompt misturar corte A no checkpoint com mensagens sob corte B.
  const cutoff =
    input.contextResetAt !== undefined ? input.contextResetAt : contact.context_reset_at;

  // Conversa: a do job quando informada (fonte confiável); senão a 1:1 mais
  // recente do contato. Grupos NUNCA (regra dura nº 12).
  let conversationId = input.conversationId ?? null;
  if (conversationId === null) {
    const { rows } = await db.query<{ id: string }>(
      `select id from conversations
       where organization_id = $1 and contact_id = $2 and is_group = false
       order by last_message_at desc nulls last limit 1`,
      [input.tenantId, input.leadId],
    );
    conversationId = rows[0]?.id ?? null;
  }

  // A decisão vem do BARRAMENTO (crm_lead_activities), não de coluna nova: a
  // timeline já é a memória compartilhada entre humano e agente, e foi para isso
  // que a Wave 3 a construiu. Outra fonte seria o segundo funil que este épico
  // existe para acabar.
  //
  // Filtra por `contact_id` porque deste lado da casa `leadId` é o CONTATO —
  // e é assim que a decisão chega mesmo que o negócio tenha mudado de mãos.
  const { rows: decisaoRows } = await db.query<DecisionRow>(
    `select type, payload, reason, performed_at::text as performed_at
     from crm_lead_activities
     where organization_id = $1
       and contact_id = $2
       and type in ('next_action_approved', 'next_action_dismissed')
     order by performed_at desc, id desc
     limit 1`,
    [input.tenantId, input.leadId],
  );
  const lastHumanDecision = decisaoRows[0] ? paraDecisao(decisaoRows[0]) : null;

  // Spec 16 §5.1: mensagens anteriores ao corte (hard reset ou expiração por
  // etapa) somem da leitura — NADA é apagado, é filtro. `context_reset_at`
  // nulo cai no `coalesce(..., '-infinity')`: idêntico ao comportamento
  // anterior a esta feature (distinto da fronteira de sessão de §4, que corta
  // por SILÊNCIO; aqui o corte é por um instante fixo gravado no contato).
  const history: HistoryRow[] = conversationId
    ? (
        await db.query<HistoryRow>(
          `select direction, type, body, media_url, media_storage_path, media_mime,
                  media_derived_text, sent_at::text as sent_at
           from messages
           where organization_id = $1 and conversation_id = $2
             and direction in ('inbound', 'outbound')
             and sent_at > coalesce($4::timestamptz, '-infinity'::timestamptz)
           order by sent_at desc, id desc
           limit $3`,
          [input.tenantId, conversationId, knobs.historyLimit, cutoff],
        )
      ).rows.reverse()
    : [];

  // Fronteira de sessão (Spec 16 §4): corta pelo SILÊNCIO, antes do orçamento
  // de tokens — para o corte de sessão nunca ser confundido com corte por
  // budget. NÃO afeta o checkpoint (lido à parte, em inbound-turn.ts): a
  // fronteira apaga o papo antigo da leitura, não a cotação já combinada.
  // `sessionGapHours` ausente (chamador não migrado) = sem corte, idêntico ao
  // comportamento anterior a esta feature.
  const historyNaFronteira = cortarNaFronteiraDeSessao(history, knobs.sessionGapHours ?? null);

  // Spec 16 §8.1: ficha SEMPRE (exceto anonimizado) — consulta separada da de
  // mensagens porque sobrevive a QUALQUER corte (não depende de `cutoff`).
  // Contato anonimizado nem dispara a query: o veto LGPD é anterior a tudo.
  let orderSummary: OrderSummaryRow = {
    total: 0,
    ultimo_em: null,
    ultimo_valor_cents: null,
    moeda: null,
    ultimo_status: null,
  };
  if (!contact.is_anonymized) {
    const { rows: orderRows } = await db.query<OrderSummaryRow>(
      `select count(*)::int as total,
              max(ordered_at)::text as ultimo_em,
              (array_agg(total_cents order by ordered_at desc))[1] as ultimo_valor_cents,
              (array_agg(currency   order by ordered_at desc))[1] as moeda,
              (array_agg(fulfillment_status order by ordered_at desc))[1] as ultimo_status
         from orders
        where organization_id = $1 and contact_id = $2 and is_anonymized = false`,
      [input.tenantId, input.leadId],
    );
    if (orderRows[0]) orderSummary = orderRows[0];
  }
  const customerFile = buildCustomerFile(contact, orderSummary);

  // Spec 16 §8.2: aviso quando o corte tirou histórico da leitura — por marca
  // (`cutoff`, hard reset/expiração) OU pela fronteira de sessão ter cortado
  // mensagens que a query já trouxe. Comparar tamanhos ANTES/DEPOIS da
  // fronteira é o que distingue "cortou" de "não tinha silêncio pra cortar".
  const cortouPelaFronteira = historyNaFronteira.length < history.length;
  const previousServiceNotice = cutoff !== null || cortouPelaFronteira ? PREVIOUS_SERVICE_NOTICE : null;

  // LGPD: base legal derivada DIRETO do contato (fonte da verdade, mesmo banco).
  // isProspecting=false: o MVP é inbound + follow-up — ambos respondem a lead que
  // já engajou, nunca 1º toque frio (o veto de is_anonymized vale SEMPRE).
  const lgpd = deriveLgpdFromContact(
    {
      source: contact.source,
      consent: contact.consent,
      is_anonymized: contact.is_anonymized,
    },
    false,
  );

  const context = fitToBudget(
    {
      lead_id: input.leadId,
      contact: {
        name: contact.display_name ?? contact.name,
        phone: contact.phone_number,
        email: contact.email,
        tags: contact.tags ?? [],
        is_blocked: contact.is_blocked,
      },
      conversation_id: conversationId,
      customer_file: customerFile,
      previous_service_notice: previousServiceNotice,
      last_human_decision: lastHumanDecision,
    },
    historyNaFronteira,
    knobs.maxTokens,
  );
  return { ok: true, context, tokenCount: countPayloadTokens(JSON.stringify(context)), lgpd };
}

/**
 * Encaixa o payload no orçamento (determinístico):
 *   1. mensagens mais ANTIGAS caem primeiro;
 *   2. restando uma única mensagem que ainda estoura, o corpo é cortado ao meio
 *      repetidamente até caber. Nunca erro fatal.
 */
function fitToBudget(
  base: Omit<LeadContext, 'messages'>,
  history: HistoryRow[],
  maxTokens: number,
): LeadContext {
  let messages: LeadContextMessage[] = history.map((m) => {
    const hasMedia = Boolean(m.media_storage_path || m.media_url);
    const derived = m.media_derived_text;
    // Onda 3: legenda e derivado (transcrição/visão/pdf) COEXISTEM, e o derivado
    // vem ENQUADRADO (frameMediaBody) — sem isso o agente caía no reflexo
    // "não consigo ver mídia" mesmo tendo o conteúdo. Sem derivado, marcador [tipo].
    const body = derived
      ? frameMediaBody(m.type, m.body, derived)
      : (m.body ?? (hasMedia ? `[${m.type}]` : ''));
    return {
      direction: m.direction,
      body,
      sent_at: m.sent_at,
      ...(hasMedia ? { type: m.type, media_storage_path: m.media_storage_path, media_mime: m.media_mime } : {}),
    };
  });
  const build = (msgs: LeadContextMessage[]): LeadContext => ({ ...base, messages: msgs });
  const over = (msgs: LeadContextMessage[]): boolean =>
    countPayloadTokens(JSON.stringify(build(msgs))) > maxTokens;

  while (messages.length > 1 && over(messages)) {
    messages = messages.slice(1);
  }
  while (messages.length === 1 && messages[0]!.body.length > 0 && over(messages)) {
    messages = [{ ...messages[0]!, body: messages[0]!.body.slice(0, Math.floor(messages[0]!.body.length / 2)) }];
  }
  return build(messages);
}

/** Substantivo pt-br por tipo de mídia (p/ o enquadramento do derivado). */
const MEDIA_NOUN: Record<string, string> = {
  image: 'uma imagem',
  video: 'um vídeo',
  audio: 'um áudio',
  document: 'um documento (PDF)',
  sticker: 'uma figurinha',
};

/**
 * Enquadra o derivado de mídia como PERCEPÇÃO do agente (Onda 3, ajuste pós-prova).
 * Sem isto, o modelo via a transcrição/descrição mas respondia "não consigo ver
 * mídia" por reflexo. O enquadramento diz explicitamente: o conteúdo já foi
 * processado; trate como se tivesse visto/ouvido; nunca negue a mídia. Legenda do
 * cliente (se houver) e conteúdo derivado coexistem. @internal exposto p/ teste.
 */
export function frameMediaBody(type: string, caption: string | null, derived: string): string {
  const noun = MEDIA_NOUN[type] ?? 'uma mídia';
  const parts = [
    `[Mídia do cliente: ele enviou ${noun} e o sistema já processou o conteúdo pra você. ` +
      `Trate o texto abaixo como se você mesma tivesse visto/ouvido — NUNCA responda que não ` +
      `consegue ver/ouvir mídia. Comente ou use o conteúdo naturalmente.]`,
  ];
  if (caption && caption.trim() !== '') parts.push(`Legenda do cliente: ${caption.trim()}`);
  parts.push(`Conteúdo: ${derived}`);
  return parts.join('\n');
}

/** @internal exposto p/ teste — não usar fora de testes. */
export const __test_fitToBudget = fitToBudget;
