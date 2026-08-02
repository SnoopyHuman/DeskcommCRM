/**
 * Hard reset do contexto de um contato (Spec 16 §6.1 / C2-03).
 *
 * Delega a `fn_hard_reset_contact_context` (SECURITY DEFINER, TX única) —
 * mesmo padrão de `fn_lgpd_cascade_redact_contact`. O client supabase-js não
 * oferece transação multi-statement; a RPC evita reset parcial (checkpoint
 * apagado + 500 sem audit).
 *
 * Apaga conversas, checkpoints, lead_state, lead_notes e conversation_notes
 * (via cascade). Preserva contato, lead do CRM, timeline de atividades, pedidos.
 * `organization_id` SEMPRE vem do caller autenticado — nunca do body.
 *
 * Jobs `running` bloqueiam (409): marcar failed não para o handler em memória,
 * que poderia recriar estado depois do delete. Só `pending` é cancelado.
 */
import type { Actor } from "@/lib/api/handlers/types";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { createAdminClient } from "@/lib/supabase/admin";

export type HardResetResult =
  | {
      ok: true;
      contactId: string;
      deleted: {
        conversations: number;
        lead_checkpoints: number;
        lead_state: number;
        lead_notes: number;
        jobs_canceled: number;
        ai_chunks: number;
      };
    }
  | {
      ok: false;
      code:
        | "not_found"
        | "open_case_blocks_reset"
        | "job_in_flight_blocks_reset"
        | "internal_error";
      message: string;
      details?: Record<string, unknown>;
    };

export interface HardResetContextArgs {
  organizationId: string;
  contactId: string;
  actor: Actor;
  purgeKnowledgeBase: boolean;
  reason?: string;
}

interface RpcResult {
  ok: boolean;
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
  contact_id?: string;
  deleted?: {
    conversations?: number;
    lead_checkpoints?: number;
    lead_state?: number;
    lead_notes?: number;
    jobs_canceled?: number;
    ai_chunks?: number;
  };
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function hardResetContactContext(
  args: HardResetContextArgs,
): Promise<HardResetResult> {
  const { organizationId, contactId, actor, purgeKnowledgeBase, reason } = args;
  const admin = createAdminClient();

  const { data, error } = await admin.rpc("fn_hard_reset_contact_context" as never, {
    p_organization_id: organizationId,
    p_contact_id: contactId,
    p_purge_knowledge_base: purgeKnowledgeBase,
  } as never);

  if (error) {
    return {
      ok: false,
      code: "internal_error",
      message: `fn_hard_reset_contact_context: ${error.message}`,
    };
  }

  const result = (data ?? {}) as RpcResult;
  if (!result.ok) {
    const code = result.code;
    if (
      code === "not_found" ||
      code === "open_case_blocks_reset" ||
      code === "job_in_flight_blocks_reset"
    ) {
      return {
        ok: false,
        code,
        message: result.message ?? "Hard reset bloqueado.",
        details: result.details,
      };
    }
    return {
      ok: false,
      code: "internal_error",
      message: result.message ?? "Hard reset falhou sem código conhecido.",
      details: result.details,
    };
  }

  const deleted = {
    conversations: asCount(result.deleted?.conversations),
    lead_checkpoints: asCount(result.deleted?.lead_checkpoints),
    lead_state: asCount(result.deleted?.lead_state),
    lead_notes: asCount(result.deleted?.lead_notes),
    jobs_canceled: asCount(result.deleted?.jobs_canceled),
    ai_chunks: asCount(result.deleted?.ai_chunks),
  };

  // Atividade na timeline fora da RPC: emitLeadActivity concentra vocabulário
  // e payload; se falhar, o reset já commitou (audit da rota ainda registra).
  const { data: leadRow } = await admin
    .from("crm_leads")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .order("last_activity_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (leadRow?.id) {
    const activity = await emitLeadActivity(admin, {
      organizationId,
      leadId: leadRow.id,
      contactId,
      type: "context_reset_manual",
      sourceModule: "context_lifecycle",
      sourceId: contactId,
      actor,
      reason: reason?.trim()
        ? `Contexto apagado manualmente: ${reason.trim()}`
        : "Contexto apagado manualmente",
      payload: {
        purge_knowledge_base: purgeKnowledgeBase,
        deleted_lead_notes: deleted.lead_notes,
        deleted_conversations: deleted.conversations,
      },
    });
    if (!activity.ok) {
      console.error("[context.hard-reset] activity insert failed", activity.error);
    }
  }

  return { ok: true, contactId, deleted };
}
