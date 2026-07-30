import { NextResponse } from "next/server";
import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { getWahaClient } from "@/lib/waha/client";
import { createClient } from "@/lib/supabase/server";

/**
 * Onboarding WhatsApp session orchestration.
 *
 * GET  → returns current session status (status enum from WAHA: STARTING|SCAN_QR_CODE|WORKING|FAILED|STOPPED)
 * POST → starts session if not already running. Idempotent.
 *
 * The actual QR image is served via /api/v1/onboarding/whatsapp/qr (proxy
 * to WAHA so client can <img src="..." /> without exposing the API key).
 */

interface WahaSessionResponse {
  name?: string;
  status?: string;
  config?: Record<string, unknown>;
  me?: { id?: string; pushName?: string };
}

function defaultSessionName(orgId: string): string {
  return `org_${orgId.slice(0, 8)}`;
}

async function ensureChannelSession(orgId: string, sessionName: string): Promise<string> {
  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", orgId)
    .eq("waha_session_name", sessionName)
    .maybeSingle();
  if (existing?.id) return existing.id as string;
  const { data: created, error } = await supabase
    .from("channel_sessions")
    .insert({
      organization_id: orgId,
      waha_session_name: sessionName,
      engine: "NOWEB",
      webhook_path_token: crypto.randomUUID().replace(/-/g, ""),
      webhook_secret_encrypted: Buffer.from([0]),
      status: "STARTING",
      last_status_change_at: new Date().toISOString(),
      consecutive_health_fails: 0,
      daily_message_limit: 250,
      metadata: {},
    })
    .select("id")
    .single();
  if (error) throw new Error(`channel_session_insert_failed: ${error.message}`);
  return created.id as string;
}

export async function GET() {
  const user = await loadAuthUser();
  if (!user) return fail("unauthenticated", "Sessão expirada", 401);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) return fail("tenant_not_found", "Sem organização ativa", 404);
  const waha = getWahaClient();
  if (!waha) return ok({ status: "WAHA_NOT_CONFIGURED", session: null });
  const sessionName = defaultSessionName(activeOrg.orgId);
  try {
    const remote = (await waha.getSessionQr(sessionName)) as WahaSessionResponse;
    return ok({ status: remote.status ?? "UNKNOWN", session: sessionName });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    if (msg.includes("404")) return ok({ status: "NOT_STARTED", session: sessionName });
    return ok({ status: "ERROR", session: sessionName, error: msg });
  }
}

export async function POST(req: Request) {
  const user = await loadAuthUser();
  if (!user) return fail("unauthenticated", "Sessão expirada", 401);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) return fail("tenant_not_found", "Sem organização ativa", 404);
  const waha = getWahaClient();
  if (!waha) return fail("waha_not_configured", "Suba o Docker (docker compose up -d waha) e tente novamente.", 503);
  const sessionName = defaultSessionName(activeOrg.orgId);

  // 1) Make sure we have a row in channel_sessions.
  const channelSessionId = await ensureChannelSession(activeOrg.orgId, sessionName);

  // 1b) `?restart=1` = pedido explícito de QR novo. O start sozinho não resolve
  // uma sessão FAILED: o WAHA responde 422 ("already exists") e o usuário fica
  // preso olhando um QR morto. O QR do WhatsApp expira em poucos minutos, então
  // "falhou, gere outro" é fluxo normal do onboarding, não caso de exceção.
  if (new URL(req.url).searchParams.get("restart") === "1") {
    try {
      await waha.stopSession(sessionName);
    } catch {
      // Sessão já parada/inexistente: seguir para o start é o comportamento certo.
    }
  }

  // 2) Start the session in WAHA. Idempotent — WAHA returns 422 if already started; treat as ok.
  try {
    const remote = (await waha.startSession(sessionName)) as WahaSessionResponse;
    return ok({ status: remote.status ?? "STARTING", session: sessionName, channel_session_id: channelSessionId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    if (msg.includes("422") || msg.includes("409")) {
      // Session already exists — just fetch status.
      const remote = (await waha.getSessionQr(sessionName)) as WahaSessionResponse;
      return ok({ status: remote.status ?? "RUNNING", session: sessionName, channel_session_id: channelSessionId });
    }
    return NextResponse.json(
      { error: { code: "waha_start_failed", message: msg } },
      { status: 502 },
    );
  }
}
