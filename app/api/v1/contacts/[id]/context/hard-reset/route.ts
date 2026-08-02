/**
 * POST /api/v1/contacts/[id]/context/hard-reset
 *
 * Spec 16 §6.1 / C2-03 — única operação destrutiva do ciclo de vida do
 * contexto. Um contato por vez, manager+, confirmação digitada "APAGAR".
 * `organization_id` vem da sessão (requireRole), nunca do body.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { hardResetContactContext } from "@/lib/contacts/hard-reset-context";
import { hardResetContextSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
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

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("body_malformed", "Body must be valid JSON", 400, { requestId });
  }

  const parsed = hardResetContextSchema.safeParse(rawBody);
  if (!parsed.success) {
    const confirmationIssue = parsed.error.issues.find((i) => i.path[0] === "confirmation");
    if (confirmationIssue) {
      return fail("invalid_confirmation", 'Digite exatamente "APAGAR" para confirmar.', 422, {
        requestId,
        details: { fieldErrors: { confirmation: [confirmationIssue.message] } },
      });
    }
    return fail("validation_error", "Validation failed", 422, {
      requestId,
      details: { fieldErrors: parsed.error.flatten().fieldErrors },
    });
  }

  const { purge_knowledge_base, reason } = parsed.data;

  const result = await hardResetContactContext({
    organizationId,
    contactId,
    actor: { type: "user", id: user.id },
    purgeKnowledgeBase: purge_knowledge_base,
    reason,
  });

  if (!result.ok) {
    if (result.code === "not_found") {
      return fail("not_found", result.message, 404, { requestId });
    }
    if (
      result.code === "open_case_blocks_reset" ||
      result.code === "job_in_flight_blocks_reset"
    ) {
      return fail(result.code, result.message, 409, {
        requestId,
        details: result.details,
      });
    }
    return fail("internal_error", result.message, 500, { requestId });
  }

  await audit({
    action: "context.reset_manual",
    actorUserId: user.id,
    organizationId,
    resourceType: "contact",
    resourceId: contactId,
    requestId,
    metadata: {
      purge_knowledge_base,
      reason: reason ?? null,
      deleted: result.deleted,
    },
  });

  return ok(
    {
      contact_id: contactId,
      deleted: result.deleted,
    },
    { requestId },
  );
}
