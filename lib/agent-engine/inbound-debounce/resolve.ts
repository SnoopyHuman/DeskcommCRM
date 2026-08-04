/**
 * Resolve o debounce efetivo da org: `settings.inbound_debounce` sobre o
 * default de env. Pura — não toca banco.
 *
 * Chamador passa o fragmento `settings->'inbound_debounce'` (não o settings
 * inteiro). `null`/`undefined` = org ainda sem a chave → usa env.
 */
import {
  DEFAULT_INBOUND_DEBOUNCE,
  inboundDebounceSchema,
  type InboundDebounceConfig,
} from "@/lib/schemas/inbound-debounce";

export interface ResolvedInboundDebounce {
  /** ms a somar em run_after; 0 = sem debounce. */
  debounceMs: number;
  /** Teto absoluto desde a 1ª mensagem da rajada. */
  maxWindowMs: number;
  config: InboundDebounceConfig;
}

export function resolveInboundDebounce(
  inboundDebounceFragment: unknown,
  envDefaultMs: number,
): ResolvedInboundDebounce {
  const fallback =
    Number.isFinite(envDefaultMs) && envDefaultMs >= 0 ? Math.trunc(envDefaultMs) : 5_000;

  if (inboundDebounceFragment == null) {
    return {
      debounceMs: fallback,
      maxWindowMs: Math.min(60_000, Math.max(fallback * 3, fallback)),
      config: { ...DEFAULT_INBOUND_DEBOUNCE, window_ms: fallback },
    };
  }

  const parsed = inboundDebounceSchema
    .catch({ ...DEFAULT_INBOUND_DEBOUNCE, window_ms: fallback })
    .parse(inboundDebounceFragment);

  if (!parsed.enabled) {
    return { debounceMs: 0, maxWindowMs: 0, config: parsed };
  }

  const debounceMs = parsed.window_ms;
  const maxWindowMs =
    parsed.max_window_ms ?? Math.min(60_000, Math.max(debounceMs * 3, debounceMs));

  return { debounceMs, maxWindowMs, config: parsed };
}
