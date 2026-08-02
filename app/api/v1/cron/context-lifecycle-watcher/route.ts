/**
 * GET/POST /api/v1/cron/context-lifecycle-watcher — Spec 16 §7 (C3-02).
 *
 * Marca o contexto de contatos cujo negócio ficou parado numa etapa com a
 * política de reinício ligada. O worker só faz soft reset: mensagens,
 * conversas, notas, pedidos e o lead continuam intactos.
 *
 * Auth: Bearer INTERNAL_CRON_SECRET|INTERNAL_SECRET, fail-closed.
 * Cadência sugerida: uma vez por hora. Teto: 500 contatos por invocação.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const CONTACT_LIMIT = 500;

interface StagePolicy {
  organization_id: string;
  name: string;
  resets_context: boolean;
  context_reset_after_days: number;
  is_archived: boolean;
}

interface WatcherCandidate {
  id: string;
  contact_id: string;
  organization_id: string;
  stage_changed_at: string;
  crm_stages: StagePolicy | StagePolicy[] | null;
  contacts:
    | { organization_id: string; context_reset_at: string | null }
    | { organization_id: string; context_reset_at: string | null }[]
    | null;
}

interface DueContact {
  leadId: string;
  contactId: string;
  organizationId: string;
  stageChangedAt: string;
  stageName: string;
  afterDays: number;
}

interface OpenCaseRow {
  organization_id: string;
  conversations: { organization_id: string; contact_id: string | null } | {
    organization_id: string;
    contact_id: string | null;
  }[] | null;
}

function one<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function isDue(candidate: WatcherCandidate, now: Date): DueContact | null {
  const stage = one(candidate.crm_stages);
  const contact = one(candidate.contacts);
  if (!stage || !contact || !candidate.stage_changed_at) return null;
  if (
    stage.organization_id !== candidate.organization_id ||
    contact.organization_id !== candidate.organization_id
  ) {
    return null;
  }
  if (!stage.resets_context || stage.is_archived) return null;
  if (!Number.isInteger(stage.context_reset_after_days) || stage.context_reset_after_days < 0) {
    return null;
  }

  const stageChangedAt = new Date(candidate.stage_changed_at);
  if (Number.isNaN(stageChangedAt.getTime())) return null;

  const dueAt = stageChangedAt.getTime() + stage.context_reset_after_days * 86_400_000;
  if (dueAt > now.getTime()) return null;

  // O corte é por contato. Um reset já feito depois da entrada nesta etapa
  // tira o contato da seleção; um reset anterior ainda deixa o novo ciclo
  // elegível quando o negócio voltou para a etapa.
  if (
    contact.context_reset_at &&
    new Date(contact.context_reset_at).getTime() >= stageChangedAt.getTime()
  ) {
    return null;
  }

  return {
    leadId: candidate.id,
    contactId: candidate.contact_id,
    organizationId: candidate.organization_id,
    stageChangedAt: candidate.stage_changed_at,
    stageName: stage.name,
    afterDays: stage.context_reset_after_days,
  };
}

function chooseOnePerContact(
  rows: WatcherCandidate[],
  blockedContacts: Set<string>,
  now: Date,
): DueContact[] {
  const chosen = new Map<string, DueContact>();

  for (const row of rows) {
    const due = isDue(row, now);
    if (!due) continue;
    if (blockedContacts.has(`${due.organizationId}:${due.contactId}`)) continue;

    const key = `${due.organizationId}:${due.contactId}`;
    const previous = chosen.get(key);
    if (
      !previous ||
      due.stageChangedAt < previous.stageChangedAt ||
      (due.stageChangedAt === previous.stageChangedAt && due.leadId < previous.leadId)
    ) {
      chosen.set(key, due);
    }
  }

  return [...chosen.values()]
    .sort((a, b) => {
      const org = a.organizationId.localeCompare(b.organizationId);
      if (org !== 0) return org;
      const contact = a.contactId.localeCompare(b.contactId);
      if (contact !== 0) return contact;
      const stage = a.stageChangedAt.localeCompare(b.stageChangedAt);
      return stage !== 0 ? stage : a.leadId.localeCompare(b.leadId);
    })
    .slice(0, CONTACT_LIMIT);
}

/**
 * O update do contato é o claim. Dois ticks podem selecionar a mesma linha,
 * mas só o primeiro que ainda enxerga o marcador anterior recebe uma linha em
 * `data`; só esse vencedor roda os efeitos colaterais. Isso mantém a
 * idempotência sem precisar de uma função SQL nova.
 */
async function claimContact(
  admin: ReturnType<typeof createAdminClient>,
  candidate: DueContact,
  nowIso: string,
): Promise<{ claimed: boolean; error: string | null }> {
  const { data, error } = await admin
    .from("contacts")
    .update({ context_reset_at: nowIso, context_reset_reason: "stage_policy" })
    .eq("id", candidate.contactId)
    .eq("organization_id", candidate.organizationId)
    .or(`context_reset_at.is.null,context_reset_at.lt.${candidate.stageChangedAt}`)
    .select("id")
    .maybeSingle();

  return { claimed: Boolean(data), error: error?.message ?? null };
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const now = new Date();
  const nowIso = now.toISOString();

  // PostgREST não expressa make_interval(days => s.context_reset_after_days)
  // por linha. Buscamos apenas políticas ativas e aplicamos a comparação de
  // relógio em `isDue`; a deduplicação e o teto continuam sendo por contato,
  // como na DISTINCT ON da Spec §7.
  const { data, error } = await admin
    .from("crm_leads")
    .select(
      "id, contact_id, organization_id, stage_changed_at, crm_stages!inner(organization_id, name, resets_context, context_reset_after_days, is_archived), contacts!inner(organization_id, context_reset_at)",
    )
    .not("contact_id", "is", null)
    .not("stage_changed_at", "is", null)
    .eq("crm_stages.resets_context", true)
    .eq("crm_stages.is_archived", false)
    .order("organization_id", { ascending: true })
    .order("contact_id", { ascending: true })
    .order("stage_changed_at", { ascending: true })
    .order("id", { ascending: true });

  if (error) {
    logger.error("[context-lifecycle-watcher] candidate query failed", {
      error: error.message,
      requestId,
    });
    return fail("internal_error", "Failed to query context lifecycle candidates.", 500, {
      requestId,
    });
  }

  // `agent_cases` não expõe contact_id. O join obrigatório é pelo conversation;
  // status novo continua bloqueando por usar negação (`not in`) — fail-safe.
  const { data: openCaseRows, error: openCaseError } = await admin
    .from("agent_cases")
    .select("organization_id, conversations!inner(organization_id, contact_id)")
    .not("status", "in", "(resolved,cancelled)");
  if (openCaseError) {
    logger.error("[context-lifecycle-watcher] open cases query failed", {
      error: openCaseError.message,
      requestId,
    });
    return fail("internal_error", "Failed to query open human cases.", 500, { requestId });
  }

  const blockedContacts = new Set<string>();
  for (const row of (openCaseRows ?? []) as unknown as OpenCaseRow[]) {
    const conversation = one(row.conversations);
    if (
      conversation?.contact_id &&
      conversation.organization_id === row.organization_id
    ) {
      blockedContacts.add(`${row.organization_id}:${conversation.contact_id}`);
    }
  }

  const due = chooseOnePerContact(
    (data ?? []) as unknown as WatcherCandidate[],
    blockedContacts,
    now,
  );
  let marked = 0;
  let skipped = 0;
  let jobsCanceled = 0;
  let failures = 0;

  for (const candidate of due) {
    const claim = await claimContact(admin, candidate, nowIso);
    if (claim.error) {
      failures++;
      logger.error("[context-lifecycle-watcher] contact claim failed", {
        error: claim.error,
        organizationId: candidate.organizationId,
        contactId: candidate.contactId,
        requestId,
      });
      continue;
    }
    if (!claim.claimed) {
      skipped++;
      continue;
    }

    const { data: canceled, error: cancelError } = await admin
      .from("job_queue")
      .update({
        status: "failed",
        last_error: "canceled_by_context_stage_policy",
        locked_by: null,
        locked_at: null,
      })
      .eq("organization_id", candidate.organizationId)
      .eq("contact_id", candidate.contactId)
      .eq("status", "pending")
      .select("id");

    if (cancelError) {
      failures++;
      logger.error("[context-lifecycle-watcher] pending jobs cancellation failed", {
        error: cancelError.message,
        organizationId: candidate.organizationId,
        contactId: candidate.contactId,
        requestId,
      });
    } else {
      jobsCanceled += canceled?.length ?? 0;
    }

    const activity = await emitLeadActivity(admin, {
      organizationId: candidate.organizationId,
      leadId: candidate.leadId,
      contactId: candidate.contactId,
      type: "context_reset_auto",
      sourceModule: "context_lifecycle",
      sourceId: candidate.leadId,
      actor: { type: "webhook_source", id: "context-lifecycle-watcher" },
      reason: "Contexto reiniciado automaticamente ao permanecer na etapa além da carência",
      payload: {
        stage_name: candidate.stageName,
        after_days: candidate.afterDays,
      },
    });
    if (!activity.ok) {
      failures++;
      logger.error("[context-lifecycle-watcher] activity insert failed", {
        error: activity.error,
        organizationId: candidate.organizationId,
        contactId: candidate.contactId,
        requestId,
      });
    }

    void audit({
      action: "context.reset_auto",
      organizationId: candidate.organizationId,
      resourceType: "contact",
      resourceId: candidate.contactId,
      bypassedRls: true,
      requestId,
      metadata: {
        lead_id: candidate.leadId,
        stage_name: candidate.stageName,
        after_days: candidate.afterDays,
        jobs_canceled: canceled?.length ?? 0,
      },
    });
    marked++;
  }

  return ok(
    {
      scanned: due.length,
      marked,
      skipped,
      jobs_canceled: jobsCanceled,
      failures,
    },
    { requestId },
  );
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
