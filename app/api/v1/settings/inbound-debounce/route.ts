/**
 * GET  /api/v1/settings/inbound-debounce — lê organizations.settings.inbound_debounce (manager+).
 * PATCH /api/v1/settings/inbound-debounce — grava (admin). Merge não-destrutivo do jsonb.
 *
 * Onda 5: toggle + segundos de coalescência de rajada inbound. Autz separada do
 * perfil da org (updateTenant é admin no hub; leitura manager pra quem opera).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  DEFAULT_INBOUND_DEBOUNCE,
  inboundDebouncePatchSchema,
  inboundDebounceSchema,
  validateRequest,
} from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function envDefaultMs(): number {
  const raw = process.env.INBOUND_DEBOUNCE_MS;
  const n = raw !== undefined ? Number(raw) : 5_000;
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 5_000;
}

function effectiveConfig(raw: unknown) {
  const fallback = { ...DEFAULT_INBOUND_DEBOUNCE, window_ms: envDefaultMs() };
  return raw == null
    ? inboundDebounceSchema.parse(fallback)
    : inboundDebounceSchema.catch(fallback).parse(raw);
}

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "settings_inbound_debounce" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data: orgRow, error } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const settings = (orgRow?.settings as Record<string, unknown> | null) ?? {};
  const config = effectiveConfig(settings.inbound_debounce);
  return ok(
    {
      ...config,
      env_default_ms: envDefaultMs(),
      bounds: { window_ms_min: 0, window_ms_max: 30_000, max_window_ms_max: 60_000 },
    },
    { requestId },
  );
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "settings_inbound_debounce" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let patch;
  try {
    patch = await validateRequest(inboundDebouncePatchSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const supabase = await createClient();
  const { data: orgRow, error: readErr } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  if (readErr) return fail("internal_error", readErr.message, 500, { requestId });

  const currentSettings = (orgRow?.settings as Record<string, unknown> | null) ?? {};
  const current = effectiveConfig(currentSettings.inbound_debounce);
  const next = inboundDebounceSchema.parse({ ...current, ...patch });
  const nextSettings = { ...currentSettings, inbound_debounce: next };

  const { error: updErr } = await supabase
    .from("organizations")
    .update({ settings: nextSettings })
    .eq("id", activeOrg.orgId);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  void audit({
    action: "inbound_debounce.config_changed",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "organization",
    resourceId: activeOrg.orgId,
    requestId,
    metadata: { inbound_debounce: next },
  });

  return ok(next, { requestId });
}
