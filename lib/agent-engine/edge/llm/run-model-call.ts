/**
 * SEAM ÚNICO de chamada de modelo: TODA chamada de LLM do harness passa por
 * runModelCall — agente, classificadores auxiliares e compaction usam esta MESMA
 * função (nenhum call site instancia provider).
 *
 * Por chamada: resolve a config da org no DB (BYOK em ai_provider_credentials +
 * knobs em organizations.settings->'llm'; troca de modelo/provider = UPDATE na
 * config, vale no run seguinte, sem restart) → checa o budget mensal ANTES de
 * sair byte para o provider → generateText do AI SDK → grava usage/custo em
 * llm_calls. A chave da org nunca entra em prompt, tool result ou log — ela só
 * cruza a fronteira na instância do provider.
 *
 * Shape do usage: `LanguageModelUsage` (node_modules/ai/dist/index.d.ts):
 * inputTokens/outputTokens totais + inputTokenDetails.{cacheReadTokens,
 * cacheWriteTokens}. Validado no ai@7 via scripts/smoke-llm.sh (modelo real) —
 * upgrade de major re-valida esses paths pelo mesmo gate (regra dura 16).
 */
import { generateText, stepCountIs, type ModelMessage, type ToolSet } from 'ai';
import type pg from 'pg';
import { z } from 'zod';

import type { Logger } from '../../obs/logger';
import { resolveOrgLlmConfig, type LlmEdgeConfig } from './credentials';
import { costCents, type TokenUsage } from './pricing';
import { createDefaultRegistry, type ProviderRegistry } from './providers';
import { buildStablePrefix } from './stable-prefix';

// Call sites FORA da camada importam os tipos daqui — nunca de 'ai' direto
// (o seam é a única porta). `tool` idem: é como o agente define ToolSet sem
// tocar no SDK.
export { tool } from 'ai';
export type { ModelMessage, ToolSet } from 'ai';
export type { LlmEdgeConfig } from './credentials';
export { llmEdgeConfigFromEnv, LlmNotConfiguredError } from './credentials';

/** Teto mensal da org esgotado — runs recusados ANTES do provider (zero tokens). */
export class LlmBudgetExceededError extends Error {
  override readonly name = 'llm_budget_exceeded';
  constructor() {
    super('orçamento mensal de LLM da org esgotado — chamada recusada; ajuste o teto ou aguarde a virada do mês (agent_inbox_items kind=budget_exceeded)');
  }
}

/** Provider da config sem entrada no registry — erro de config, nunca fallback. */
export class LlmProviderUnknownError extends Error {
  override readonly name = 'llm_provider_unknown';
  constructor(provider: string) {
    super(`provider LLM desconhecido na config da org: ${provider}`);
  }
}

/** Modelo pedido fora de enabled_models da org. */
export class LlmModelNotEnabledError extends Error {
  override readonly name = 'llm_model_not_enabled';
  constructor(model: string) {
    super(`modelo não habilitado para a org (enabled_models): ${model}`);
  }
}

// Whitelist de params da org (jsonb livre no DB → só o que o seam entende passa).
const paramsSchema = z
  .object({
    temperature: z.number().optional(),
    topP: z.number().optional(),
    topK: z.number().int().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
  })
  .passthrough();

export interface RunModelCallInput {
  tenantId: string;
  leadId?: string | null;
  jobId?: string | null;
  variantId?: string | null;
  /** atribuição de custo: 'agent_turn' (default) | 'classifier' | 'compaction' | 'connection_test' */
  purpose?: string;
  system?: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  /**
   * Override do modelo default da org — é como classificador/compaction usam um
   * modelo pequeno pela MESMA camada. Sujeito a enabled_models quando a lista
   * não é vazia. NUNCA um id hardcoded: o valor vem de config de quem chama.
   */
  model?: string;
  /**
   * Teto do loop de tool-calls do generateText (vira stopWhen: stepCountIs). Sem
   * ele o SDK para no 1º step (default stepCountIs(1)) — tools executam mas o
   * modelo não vê o resultado. Quem chama passa o knob (ex.: AGENT_MAX_STEPS do
   * agente), nunca constante.
   */
  maxSteps?: number;
  /**
   * Override de provider/credencial vindo da versão PUBLICADA do agente (Fase
   * 2B) — resolvido no seam, nunca no call site. Sem ele, config da org.
   */
  llmOverride?: import('./credentials').LlmResolveOverride;
}

export interface RunModelCallDeps {
  registry?: ProviderRegistry;
  log?: Logger;
}

/**
 * Reserva EM PROCESSO (não cruza workers), por jobId, do custo ESTIMADO de chamadas do
 * MESMO turno ainda em voo — fecha a janela entre "checou orçamento" e "gravou custo em
 * llm_calls" quando 2+ chamadas do MESMO turno rodam em paralelo (stage-classifier +
 * jailbreak-classifier, Promise.allSettled em runAgentTurn F3-11/F4-04). Sem isso, as
 * duas leem o mesmo `spent` do DB antes de qualquer uma terminar e passam mesmo que,
 * juntas, estourem o teto. Escopo por jobId: não atropela turnos concorrentes de OUTROS
 * leads/jobs da mesma org — cada um segue gated só pelo `spent` real no DB, como antes
 * (o cross-processo/cross-job permanece best-effort, doutrina já aceita — ver
 * assertBudget). Liberada (o custo real já foi gravado em llm_calls) assim que a
 * chamada termina, sucesso ou erro.
 */
const inFlightCentsByJob = new Map<string, number>();

function releaseInFlight(jobId: string | null | undefined, cents: number): void {
  if (jobId == null || cents === 0) {
    return;
  }
  const next = (inFlightCentsByJob.get(jobId) ?? 0) - cents;
  if (next <= 0) {
    inFlightCentsByJob.delete(jobId);
  } else {
    inFlightCentsByJob.set(jobId, next);
  }
}

/**
 * Teto de saída pra estimativa de reserva — as chamadas que hoje rodam em paralelo no
 * mesmo job (stage/jailbreak) são classificadores advisórios com saída JSON curta;
 * 2000 tokens é folgado pra elas. Não precisa ser exato: superestimar só reduz
 * concorrência de reserva um pouco mais cedo, nunca deixa passar gasto não contado.
 */
const RESERVE_OUTPUT_TOKENS_CEILING = 2000;

/**
 * Estimativa CONSERVADORA (chars/3 — mais pessimista que a razão real ~4 chars/token)
 * do custo ANTES da resposta do provider, só pra reservar o slot em
 * inFlightCentsByJob durante a chamada. O custo REAL gravado em llm_calls sempre
 * substitui essa estimativa (ver releaseInFlight). Modelo sem preço → 0 (mesma
 * semântica de costCents: não conta pro teto).
 */
function estimateReserveCents(model: string, system: string | undefined, messages: ModelMessage[]): number {
  const messageChars = messages.reduce((sum, m) => {
    const content = m.content;
    return sum + (typeof content === 'string' ? content.length : JSON.stringify(content).length);
  }, 0);
  const usage: TokenUsage = {
    inputTokens: Math.ceil((messageChars + (system?.length ?? 0)) / 3),
    outputTokens: RESERVE_OUTPUT_TOKENS_CEILING,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  return costCents(model, usage) ?? 0;
}

/**
 * Budget é enforcement do harness: agregado mensal de llm_calls × teto da org
 * (organizations.settings.llm.monthly_budget_cents), checado antes de QUALQUER
 * byte ao provider. Estouro → agent_inbox_items (1 por episódio: enquanto houver
 * item 'budget_exceeded' aberto, recusas novas não duplicam o alerta) + erro
 * tipado. ponytail: o insert-if-not-exists é um único statement; duas recusas
 * exatamente simultâneas podem duplicar o alerta — inócuo.
 *
 * Retorna os cents efetivamente reservados em inFlightCentsByJob (0 se não reservou —
 * sem teto configurado, sem jobId, ou modelo sem preço) pra o caller liberar depois.
 */
async function assertBudget(
  db: pg.Pool,
  organizationId: string,
  budgetCents: number | null,
  reserve: { jobId: string | null | undefined; estimateCents: number },
): Promise<number> {
  if (budgetCents === null) {
    return 0;
  }
  const { rows } = await db.query<{ spent: number }>(
    `select coalesce(sum(cost_cents), 0)::float8 as spent
     from llm_calls
     where organization_id = $1 and created_at >= date_trunc('month', now())`,
    [organizationId],
  );
  const spent = rows[0]?.spent ?? 0;
  const inFlight = reserve.jobId != null ? inFlightCentsByJob.get(reserve.jobId) ?? 0 : 0;
  if (spent + inFlight < budgetCents) {
    if (reserve.jobId != null && reserve.estimateCents > 0) {
      inFlightCentsByJob.set(reserve.jobId, inFlight + reserve.estimateCents);
      return reserve.estimateCents;
    }
    return 0;
  }
  await db.query(
    `insert into agent_inbox_items (organization_id, kind, severity, title, body)
     select $1, 'budget_exceeded', 'critical',
            'Orçamento mensal de LLM esgotado — agente pausado para esta org',
            'gasto do mês atingiu o teto configurado em organizations.settings.llm.monthly_budget_cents; aumente o teto ou aguarde a virada do mês'
     where not exists (
       select 1 from agent_inbox_items
       where organization_id = $1 and kind = 'budget_exceeded' and status = 'open'
     )`,
    [organizationId],
  );
  throw new LlmBudgetExceededError();
}

export async function runModelCall(db: pg.Pool, cfg: LlmEdgeConfig, input: RunModelCallInput, deps: RunModelCallDeps = {}) {
  const registry = deps.registry ?? createDefaultRegistry();
  const config = await resolveOrgLlmConfig(db, cfg, input.tenantId, input.llmOverride);

  const model = input.model ?? config.defaultModel;
  const estimateCents = model == null ? 0 : estimateReserveCents(model, input.system, input.messages);
  const reservedCents = await assertBudget(db, input.tenantId, config.monthlyBudgetCents, {
    jobId: input.jobId,
    estimateCents,
  });

  try {
    if (model === null || model === undefined) {
      throw new Error(
        'modelo LLM não definido — configure organizations.settings.llm.default_model ou passe input.model',
      );
    }
    if (config.enabledModels.length > 0 && !config.enabledModels.includes(model)) {
      throw new LlmModelNotEnabledError(model);
    }
    const factory = registry[config.provider];
    if (factory === undefined) {
      throw new LlmProviderUnknownError(config.provider);
    }
    const parsedParams = paramsSchema.safeParse(config.params);
    if (!parsedParams.success) {
      throw new Error('params inválidos em organizations.settings.llm.params — corrija a config da org');
    }
    const { temperature, topP, topK, maxOutputTokens } = parsedParams.data;

    // Disciplina de cache: o prefixo estável org-wide (system do playbook + tools
    // em ordem determinística) ganha os breakpoints AQUI, no seam — call sites
    // passam system/tools crus. Tudo por-lead vive em input.messages, DEPOIS do
    // breakpoint. TTL: knob LLM_CACHE_TTL; '1h' é a doutrina.
    const prefix = buildStablePrefix({
      system: input.system,
      tools: input.tools,
      cacheTtl: cfg.cacheTtl ?? '1h',
    });

    const startedAt = Date.now();
    // `system` aceita SystemModelMessage (com providerOptions de cache) — igual
    // em v6 e v7 (smoke prova que o cacheControl continua virando cache_control).
    const result = await generateText({
      model: factory(config.apiKey, model),
      system: prefix.system,
      messages: input.messages,
      tools: prefix.tools,
      stopWhen: input.maxSteps === undefined ? undefined : stepCountIs(input.maxSteps),
      temperature,
      topP,
      topK,
      maxOutputTokens,
    });
    const latencyMs = Date.now() - startedAt;

    const usage = {
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      cacheReadTokens: result.usage.inputTokenDetails.cacheReadTokens ?? 0,
      cacheWriteTokens: result.usage.inputTokenDetails.cacheWriteTokens ?? 0,
    };
    const cost = costCents(model, usage);

    const { rows } = await db.query<{ id: string }>(
      `insert into llm_calls
         (organization_id, contact_id, job_id, variant_id, purpose, provider, model,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_cents, latency_ms)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       returning id`,
      [
        input.tenantId,
        input.leadId ?? null,
        input.jobId ?? null,
        input.variantId ?? null,
        input.purpose ?? 'agent_turn',
        config.provider,
        model,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheReadTokens,
        usage.cacheWriteTokens,
        cost,
        latencyMs,
      ],
    );

    // Só métricas — nunca conteúdo de mensagem (PII) nem chave.
    deps.log?.info('llm: chamada concluída', {
      organization_id: input.tenantId,
      provider: config.provider,
      model,
      purpose: input.purpose ?? 'agent_turn',
      ...usage,
      cost_cents: cost,
      latency_ms: latencyMs,
    });

    return {
      result,
      callId: rows[0]?.id ?? null,
      provider: config.provider,
      model,
      usage,
      costCents: cost,
      latencyMs,
    };
  } finally {
    releaseInFlight(input.jobId, reservedCents);
  }
}
