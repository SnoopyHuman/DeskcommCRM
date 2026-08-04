/**
 * GET/POST /api/v1/cron/event-log-stale-watcher
 *
 * Onda 6 — a cada ~1 min (app-cron-ticker): eventos pending críticos parados
 * demais abrem agent_inbox_items(kind=event_dead) + Sentry (sem PII).
 *
 * Auth: Bearer INTERNAL_CRON_SECRET|INTERNAL_SECRET (fail-closed).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import pg from "pg";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { createLogger } from "@/lib/agent-engine/obs/logger";
import { scanStaleEvents } from "@/lib/agent-engine/obs/stale-events";

export const dynamic = "force-dynamic";

async function run(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const startedAt = Date.now();

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted: string[] = [];
  if (env.INTERNAL_CRON_SECRET) accepted.push(env.INTERNAL_CRON_SECRET);
  if (env.INTERNAL_SECRET) accepted.push(env.INTERNAL_SECRET);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const dbUrl = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;
  if (!dbUrl) {
    return fail("internal_error", "Database URL missing.", 500, { requestId });
  }

  const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
  const log = createLogger();
  try {
    const result = await scanStaleEvents(pool, log);
    void audit({
      action: "event_log.stale_watcher_run",
      organizationId: null,
      requestId,
      metadata: {
        ...result,
        duration_ms: Date.now() - startedAt,
      },
    });
    return ok({ ...result, duration_ms: Date.now() - startedAt }, { requestId });
  } catch (err) {
    log.error("stale watcher falhou", {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      request_id: requestId,
    });
    return fail("internal_error", "Stale watcher failed.", 500, { requestId });
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  return run(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return run(req);
}
