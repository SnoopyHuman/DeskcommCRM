/**
 * organizations.settings.context_lifecycle (Spec 16 §2/§4 — ciclo de vida do
 * contexto do agente). Só o intervalo de sessão por enquanto; a política de
 * expiração por etapa vive em `crm_stages`, não aqui (Spec 16 §3).
 *
 * `.catch(6)` normaliza ausência/tipo inválido pro default seguro — mesmo
 * padrão de `aiDispatchModeSchema` (settings.ts). `null` explícito PASSA
 * (nullable, não optional): é a forma de o tenant desligar a fronteira de
 * sessão, distinta de "não configurou ainda".
 */
import { z } from "zod";

/** Horas de silêncio que abrem uma sessão nova; `null` desliga a fronteira. */
export const sessionGapHoursSchema = z.number().positive().nullable().catch(6);

/**
 * Lê `organizations.settings.context_lifecycle.session_gap_hours` de um valor
 * de settings arbitrário (já desserializado do jsonb). Pura — não toca banco.
 */
export function resolveSessionGapHours(settings: unknown): number | null {
  const contextLifecycle = (settings as Record<string, unknown> | null | undefined)
    ?.context_lifecycle as Record<string, unknown> | undefined;
  return sessionGapHoursSchema.parse(contextLifecycle?.session_gap_hours);
}

/**
 * Body de `POST /api/v1/contacts/{id}/context/hard-reset` (Spec 16 §6.1).
 * `confirmation` é literal — a rota mapeia falha desse campo para
 * `422 invalid_confirmation` (não o `validation_error` genérico).
 */
export const hardResetContextSchema = z.object({
  confirmation: z.literal("APAGAR"),
  purge_knowledge_base: z.boolean().optional().default(false),
  reason: z.string().trim().max(500).optional(),
});
export type HardResetContextInput = z.infer<typeof hardResetContextSchema>;
