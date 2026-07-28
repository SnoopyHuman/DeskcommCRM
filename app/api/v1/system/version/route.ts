/**
 * GET /api/v1/system/version — estado da atualização para a tela.
 *
 * Responde 200 para qualquer sessão, mas só entrega o estado operacional a
 * quem é dono do servidor (`is_platform_admin`). Quem não pode agir vê apenas
 * a versão instalada: aviso sem ação disponível é só ansiedade.
 */
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { loadAuthUser } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractChangelogSection } from "@/lib/system/changelog";
import { isRunStale, type RunStatus, type RunStep } from "@/lib/system/update-run";

export const dynamic = "force-dynamic";

/** Sem notícia do agente por 24h, a tela ensina o caminho manual. */
const AGENT_OFFLINE_AFTER_MS = 24 * 60 * 60 * 1000;

export async function GET(_req: NextRequest): Promise<Response> {
  const user = await loadAuthUser();
  if (!user) return fail("unauthorized", "Faça login para continuar.", 401);

  const db = createAdminClient();
  const { data: version } = await db
    .from("system_version")
    .select("current_version, latest_version, off_release, changelog_raw, agent_last_seen_at")
    .eq("id", 1)
    .maybeSingle();

  const current = version?.current_version ?? "";

  if (!user.is_platform_admin) {
    return ok({ current_version: current, is_owner: false });
  }

  const latest = version?.latest_version ?? "";
  const section = latest ? extractChangelogSection(version?.changelog_raw ?? "", latest) : null;

  const { data: run } = await db
    .from("system_update_runs")
    .select("id, status, last_step, dispatched_at")
    .order("dispatched_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const now = new Date();
  const lastSeen = version?.agent_last_seen_at ? Date.parse(version.agent_last_seen_at) : NaN;

  return ok({
    current_version: current,
    is_owner: true,
    latest_version: latest,
    update_available: Boolean(latest) && latest !== current,
    off_release: version?.off_release ?? false,
    agent_online: !Number.isNaN(lastSeen) && now.getTime() - lastSeen < AGENT_OFFLINE_AFTER_MS,
    notes: section ? { body: section.body, requires_attention: section.requiresAttention } : null,
    run: run
      ? {
          id: run.id,
          // `unknown` é derivado aqui, não gravado: um agente morto não
          // consegue anunciar a própria morte.
          status:
            run.status === "dispatched" && isRunStale(run.dispatched_at, now)
              ? ("unknown" as const)
              : (run.status as RunStatus),
          last_step: (run.last_step as RunStep | null) ?? null,
        }
      : null,
  });
}
