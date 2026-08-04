/**
 * organizations.settings.inbound_debounce — coalescência de rajada inbound
 * (Onda 5). Mensagens do mesmo contato dentro da janela viram UM turno.
 *
 * `enabled: false` → debounceMs = 0 (responde imediatamente).
 * `window_ms` é a janela deslizante; `max_window_ms` é o teto absoluto desde a
 * primeira mensagem da rajada (evita adiar pra sempre se o contato não para).
 */
import { z } from "zod";

export const inboundDebounceSchema = z.object({
  enabled: z.boolean().default(true),
  /** Janela deslizante em ms (0–30s). UI expõe em segundos. */
  window_ms: z.number().int().min(0).max(30_000).default(5_000),
  /** Teto absoluto da rajada desde o 1º enqueue (default = 3× window). */
  max_window_ms: z.number().int().min(0).max(60_000).optional(),
});

export type InboundDebounceConfig = z.infer<typeof inboundDebounceSchema>;

export const DEFAULT_INBOUND_DEBOUNCE: InboundDebounceConfig = inboundDebounceSchema.parse({});

/** Body de PATCH — campos opcionais (merge parcial). */
export const inboundDebouncePatchSchema = inboundDebounceSchema.partial();
export type InboundDebouncePatch = z.infer<typeof inboundDebouncePatchSchema>;
