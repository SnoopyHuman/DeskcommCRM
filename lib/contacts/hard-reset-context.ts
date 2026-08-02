/**
 * Hard reset do contexto de um contato (Spec 16 §6.1 / C2-03).
 *
 * Única operação destrutiva do épico de ciclo de vida: apaga conversas,
 * checkpoints, lead_state, lead_notes e conversation_notes (via cascade).
 * Preserva contato, lead do CRM, timeline de atividades, pedidos.
 * `organization_id` SEMPRE vem do caller autenticado — nunca do body.
 *
 * Por que apaga lead_notes: o agente grava resumos duráveis ali ("interesse:
 * guipir…") e injeta no turno seguinte. Preservá-las fazia o hard reset
 * "falhar" para QA — a conversa sumia, a memória não.
 *
 * Sequencial best-effort (mesmo padrão de `lgpd/anonymize`): supabase-js não
 * oferece transação multi-statement no client; cada passo filtra por org+contato.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";

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
      code: "not_found" | "open_case_blocks_reset" | "internal_error";
      message: string;
      details?: Record<string, unknown>;
    };

export interface HardResetContextArgs {
  supabase: SupabaseClient;
  organizationId: string;
  contactId: string;
  actor: Actor;
  purgeKnowledgeBase: boolean;
  reason?: string;
}

export async function hardResetContactContext(
  args: HardResetContextArgs,
): Promise<HardResetResult> {
  const { supabase, organizationId, contactId, actor, purgeKnowledgeBase, reason } = args;

  const { data: contact, error: contactErr } = await supabase
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (contactErr) {
    return { ok: false, code: "internal_error", message: contactErr.message };
  }
  if (!contact) {
    return { ok: false, code: "not_found", message: "Contato não encontrado." };
  }

  const { data: conversations, error: convErr } = await supabase
    .from("conversations")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId);
  if (convErr) {
    return { ok: false, code: "internal_error", message: convErr.message };
  }
  const conversationIds = (conversations ?? []).map((c) => c.id as string);

  if (conversationIds.length > 0) {
    const { data: openCase, error: caseErr } = await supabase
      .from("agent_cases")
      .select("id")
      .eq("organization_id", organizationId)
      .in("conversation_id", conversationIds)
      .not("status", "in", "(resolved,cancelled)")
      .limit(1)
      .maybeSingle();
    if (caseErr) {
      return { ok: false, code: "internal_error", message: caseErr.message };
    }
    if (openCase) {
      return {
        ok: false,
        code: "open_case_blocks_reset",
        message:
          "Existe um caso aberto para este contato. Resolva o caso antes de apagar o contexto — senão quem estiver cuidando dele perde a referência.",
        details: { case_id: openCase.id },
      };
    }
  }

  // Cancela jobs pendentes/running — 'failed' (terminal de negócio), não
  // 'dead' (que abriria alerta crítico na inbox).
  const { data: canceledJobs, error: jobErr } = await supabase
    .from("job_queue")
    .update({
      status: "failed",
      last_error: "canceled_by_context_hard_reset",
      locked_by: null,
      locked_at: null,
    })
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .in("status", ["pending", "running"])
    .select("id");
  if (jobErr) {
    return { ok: false, code: "internal_error", message: `job_queue: ${jobErr.message}` };
  }
  const jobsCanceled = canceledJobs?.length ?? 0;

  const { data: deletedCheckpoints, error: cpErr } = await supabase
    .from("lead_checkpoints")
    .delete()
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .select("id");
  if (cpErr) {
    return { ok: false, code: "internal_error", message: `lead_checkpoints: ${cpErr.message}` };
  }

  const { data: deletedState, error: stateErr } = await supabase
    .from("lead_state")
    .delete()
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .select("id");
  if (stateErr) {
    return { ok: false, code: "internal_error", message: `lead_state: ${stateErr.message}` };
  }

  // Notas duráveis do lead — é daqui que vazava "guipir preto" após apagar a conversa.
  const { data: deletedNotes, error: notesErr } = await supabase
    .from("lead_notes")
    .delete()
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .select("id");
  if (notesErr) {
    return { ok: false, code: "internal_error", message: `lead_notes: ${notesErr.message}` };
  }

  // Purge RAG antes do delete das conversas (ids ainda vivos).
  let aiChunksDeleted = 0;
  if (purgeKnowledgeBase && conversationIds.length > 0) {
    for (const convId of conversationIds) {
      const { data: purged, error: chunkErr } = await supabase
        .from("ai_chunks")
        .delete()
        .eq("organization_id", organizationId)
        .filter("metadata->>conversation_id", "eq", convId)
        .select("id");
      if (chunkErr) {
        return { ok: false, code: "internal_error", message: `ai_chunks: ${chunkErr.message}` };
      }
      aiChunksDeleted += purged?.length ?? 0;
    }
  }

  // Cascade apaga messages + conversation_notes.
  const { data: deletedConvs, error: delConvErr } = await supabase
    .from("conversations")
    .delete()
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .select("id");
  if (delConvErr) {
    return { ok: false, code: "internal_error", message: `conversations: ${delConvErr.message}` };
  }

  const { error: clearErr } = await supabase
    .from("contacts")
    .update({ context_reset_at: null, context_reset_reason: null })
    .eq("id", contactId)
    .eq("organization_id", organizationId);
  if (clearErr) {
    return { ok: false, code: "internal_error", message: `contacts: ${clearErr.message}` };
  }

  const { data: leadRow } = await supabase
    .from("crm_leads")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .order("last_activity_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (leadRow?.id) {
    const activity = await emitLeadActivity(supabase, {
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
        deleted_lead_notes: deletedNotes?.length ?? 0,
        deleted_conversations: deletedConvs?.length ?? 0,
      },
    });
    if (!activity.ok) {
      console.error("[context.hard-reset] activity insert failed", activity.error);
    }
  }

  return {
    ok: true,
    contactId,
    deleted: {
      conversations: deletedConvs?.length ?? 0,
      lead_checkpoints: deletedCheckpoints?.length ?? 0,
      lead_state: deletedState?.length ?? 0,
      lead_notes: deletedNotes?.length ?? 0,
      jobs_canceled: jobsCanceled,
      ai_chunks: aiChunksDeleted,
    },
  };
}
