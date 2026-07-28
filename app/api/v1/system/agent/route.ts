/**
 * POST /api/v1/system/agent — endpoint ÚNICO do agente do host.
 *
 * O app não alcança o host: quem puxa é o `agent.sh`, por cron. Ele anuncia a
 * versão instalada e lê, na resposta, se alguém clicou em "Atualizar agora".
 * O que atravessa a fronteira é um booleano, nunca um comando — mesmo com o app
 * comprometido, o atacante não escolhe O QUE roda no host.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET|INTERNAL_SECRET>`, mesmo
 * esquema das demais rotas de cron. Nunca em query string.
 */
import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { CHANGELOG_MAX_BYTES } from "@/lib/system/changelog";
import { canTransition, type RunStatus } from "@/lib/system/update-run";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const heartbeat = z.object({
  kind: z.literal("heartbeat"),
  current_version: z.string().max(64),
  current_sha: z.string().max(64),
  off_release: z.boolean(),
  latest_version: z.string().max(64),
  changelog: z.string().max(CHANGELOG_MAX_BYTES),
});

const runProgress = z.object({
  kind: z.literal("run_progress"),
  run_id: z.string().uuid(),
  step: z.enum(["backup", "codigo", "banco"]),
});

const runResult = z.object({
  kind: z.literal("run_result"),
  run_id: z.string().uuid(),
  status: z.enum(["success", "failed", "failed_rolled_back"]),
  log_tail: z.string().max(16_000),
});

const body = z.discriminatedUnion("kind", [heartbeat, runProgress, runResult]);

function secretMatches(provided: string): boolean {
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  return accepted.some((expected) => {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    // timingSafeEqual LANÇA se os tamanhos diferirem — o curto-circuito aqui
    // evita que um segredo de tamanho errado vire 500 em vez de 401.
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const provided = bearer || (req.headers.get("x-cron-secret")?.trim() ?? "");
  if (!provided || !secretMatches(provided)) {
    return fail("unauthorized", "Credencial inválida.", 401);
  }

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Corpo inválido.", 422, { details: parsed.error.flatten() });
  }

  const db = createAdminClient();
  const payload = parsed.data;

  if (payload.kind === "heartbeat") {
    const { error } = await db
      .from("system_version")
      .update({
        current_version: payload.current_version,
        current_sha: payload.current_sha,
        off_release: payload.off_release,
        latest_version: payload.latest_version,
        changelog_raw: payload.changelog,
        agent_last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);
    if (error) {
      logger.error("[system/agent] heartbeat falhou", { error: error.message });
      return fail("internal_error", "Não consegui gravar o estado.", 500);
    }

    const { data: version } = await db
      .from("system_version")
      .select("update_requested_at")
      .eq("id", 1)
      .maybeSingle();

    if (!version?.update_requested_at) return ok({ update_requested: false, run_id: null });

    // O índice único parcial `uniq_system_update_runs_dispatched` (migration
    // 0090) garante no máximo 1 linha "dispatched" — mas o `postgrest-js` NÃO
    // lança se, apesar disso, o SELECT achar mais de uma linha: devolve
    // `{ data: null, error: PGRST116 }`. Ler isso como "ninguém pediu" faria o
    // pedido sumir em silêncio — por isso o erro é checado e vira 500, nunca
    // um `update_requested: false` otimista.
    const { data: run, error: runLookupError } = await db
      .from("system_update_runs")
      .select("id, status")
      .eq("status", "dispatched")
      .order("dispatched_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (runLookupError) {
      logger.error("[system/agent] heartbeat não conseguiu achar o run pendente", {
        error: runLookupError.message,
      });
      return fail("internal_error", "Não consegui checar o pedido de atualização.", 500);
    }

    return ok({ update_requested: Boolean(run), run_id: run?.id ?? null });
  }

  const { data: run } = await db
    .from("system_update_runs")
    .select("id, status")
    .eq("id", payload.run_id)
    .maybeSingle();

  if (!run) return fail("not_found", "Atualização não encontrada.", 404);

  if (payload.kind === "run_progress") {
    if (run.status !== "dispatched") {
      return fail("state_conflict", "Esta atualização já terminou.", 409);
    }
    const { error } = await db
      .from("system_update_runs")
      .update({ last_step: payload.step })
      .eq("id", payload.run_id);
    if (error) {
      logger.error("[system/agent] run_progress falhou", { error: error.message, runId: payload.run_id });
      return fail("internal_error", "Não consegui gravar o passo.", 500);
    }
    return ok({ update_requested: false, run_id: payload.run_id });
  }

  if (!canTransition(run.status as RunStatus, payload.status)) {
    return fail("invalid_state_transition", "Esta atualização já terminou.", 409);
  }

  // Finaliza o run PRIMEIRO. Se essa escrita falhar, nada mais acontece: sobra
  // um run "dispatched" (estado real, o índice único da migration 0090 impede
  // ambiguidade) em vez de um pedido limpo com um run que nunca fechou — essa
  // ordem falha para o lado detectável e auto-curável (o próximo heartbeat
  // ainda vê o pedido e o run em aberto), nunca para o órfão invisível.
  const { error: runUpdateError } = await db
    .from("system_update_runs")
    .update({ status: payload.status, log_tail: payload.log_tail, finished_at: new Date().toISOString() })
    .eq("id", payload.run_id);

  if (runUpdateError) {
    logger.error("[system/agent] run_result falhou ao finalizar o run", {
      error: runUpdateError.message,
      runId: payload.run_id,
    });
    return fail("internal_error", "Não consegui finalizar a atualização.", 500);
  }

  // O run já é a fonte da verdade sobre o desfecho. Se ESTA escrita falhar,
  // o pedido some no próximo heartbeat mesmo assim (não há run "dispatched"
  // para achar) — só logamos, não derrubamos uma resposta que já é verdadeira.
  const { error: clearRequestError } = await db
    .from("system_version")
    .update({ update_requested_at: null, update_requested_by: null })
    .eq("id", 1);
  if (clearRequestError) {
    logger.error("[system/agent] run_result não conseguiu limpar update_requested_at", {
      error: clearRequestError.message,
    });
  }

  await audit({
    action: "system.update_finished",
    resourceType: "system_update_run",
    resourceId: payload.run_id,
    metadata: { status: payload.status },
    actingAsPlatformAdmin: true,
  });

  return ok({ update_requested: false, run_id: payload.run_id });
}
