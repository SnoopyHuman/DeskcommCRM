/**
 * DELETE /api/v1/contacts/[id]/context/cutoff
 *
 * Spec 16 §6.2 / C2-05 — desfaz a expiração automática. Como o soft reset
 * só grava a marca (não apaga nada), limpar o campo restaura o contexto
 * integralmente. Idempotente: contato sem corte responde 200.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: contactId } = await ctx.params;

  const authz = await requireRole("manager", {
    requestId,
    resource: "contact",
  });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const organizationId = org.orgId;

  const supabase = await createClient();

  const { data: contact, error: contactErr } = await supabase
    .from("contacts")
    .select("id, context_reset_at, context_reset_reason")
    .eq("id", contactId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (contactErr) {
    return fail("internal_error", contactErr.message, 500, { requestId });
  }
  if (!contact) {
    return fail("not_found", "Contato não encontrado.", 404, { requestId });
  }

  const hadCutoff = contact.context_reset_at != null;

  if (hadCutoff) {
    const { error: clearErr } = await supabase
      .from("contacts")
      .update({ context_reset_at: null, context_reset_reason: null })
      .eq("id", contactId)
      .eq("organization_id", organizationId);
    if (clearErr) {
      return fail("internal_error", clearErr.message, 500, { requestId });
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
        type: "context_cutoff_cleared",
        sourceModule: "context_lifecycle",
        sourceId: contactId,
        actor: { type: "user", id: user.id },
        reason: "Corte de contexto desfeito",
        payload: {
          previous_reset_at: contact.context_reset_at,
          previous_reset_reason: contact.context_reset_reason,
        },
      });
      if (!activity.ok) {
        console.error("[context.cutoff] activity insert failed", activity.error);
      }
    }

    await audit({
      action: "context.cutoff_cleared",
      actorUserId: user.id,
      organizationId,
      resourceType: "contact",
      resourceId: contactId,
      requestId,
      metadata: {
        previous_reset_at: contact.context_reset_at,
        previous_reset_reason: contact.context_reset_reason,
      },
    });
  }

  return ok(
    {
      contact_id: contactId,
      cleared: hadCutoff,
    },
    { requestId },
  );
}
