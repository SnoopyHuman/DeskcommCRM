/**
 * Onda 6 — alarme de evento parado no event_log.
 *
 * Quando um evento crítico (dispatch / mídia) fica `pending` além do limiar,
 * abre um item deduplicado em agent_inbox_items (kind=event_dead) e avisa o
 * Sentry sem PII. Padrão: lgpd-sla-watcher + escalateJailbreakPromise.
 */
import type pg from "pg";
import * as Sentry from "@sentry/nextjs";

import type { Logger } from "@/lib/agent-engine/obs/logger";

const WATCH_TYPES = [
  "ai_agent.dispatch_requested",
  "media.persist_requested",
  "media.derive_requested",
] as const;

export interface StaleEventRow {
  id: string;
  organization_id: string;
  event_type: string;
  created_at: string;
  attempts: number;
}

export interface StaleEventsResult {
  scanned: number;
  alarmed: number;
  skipped_dedup: number;
}

function staleThresholdMs(): number {
  const raw = process.env.STALE_EVENT_ALARM_MS;
  const n = raw !== undefined ? Number(raw) : 120_000;
  return Number.isFinite(n) && n >= 10_000 ? Math.trunc(n) : 120_000;
}

export async function scanStaleEvents(
  pool: pg.Pool,
  log: Logger,
  opts?: { limit?: number; staleMs?: number },
): Promise<StaleEventsResult> {
  const staleMs = opts?.staleMs ?? staleThresholdMs();
  const limit = opts?.limit ?? 100;

  const { rows } = await pool.query<StaleEventRow>(
    `select id, organization_id, event_type, created_at::text, attempts
     from event_log
     where status = 'pending'
       and event_type = any($1::text[])
       and created_at < now() - ($2::bigint * interval '1 millisecond')
       and (next_attempt_at is null or next_attempt_at <= now())
     order by created_at asc
     limit $3`,
    [WATCH_TYPES as unknown as string[], staleMs, limit],
  );

  let alarmed = 0;
  let skipped = 0;

  for (const row of rows) {
    const ageS = Math.round((Date.now() - new Date(row.created_at).getTime()) / 1000);
    const title = `Evento parado: ${row.event_type}`;
    const body = `Pendente há ~${ageS}s (${row.attempts} tentativas). Verifique o drain/worker.`;

    const { rowCount } = await pool.query(
      `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
       select $1, 'event_dead', 'critical', $2, $3, 'event_log', $4
       where not exists (
         select 1 from agent_inbox_items
         where organization_id = $1
           and ref_kind = 'event_log'
           and ref_id = $4
           and status = 'open'
       )`,
      [row.organization_id, title, body, row.id],
    );

    if ((rowCount ?? 0) === 0) {
      skipped += 1;
      continue;
    }

    alarmed += 1;
    try {
      Sentry.captureMessage("event_log stale", {
        level: "warning",
        tags: {
          event_id: row.id,
          organization_id: row.organization_id,
          event_type: row.event_type,
        },
        extra: { age_s: ageS, attempts: row.attempts, stale_ms: staleMs },
      });
    } catch {
      // Sentry opcional — não derruba o watcher.
    }

    log.warn("event_log stale — inbox aberta", {
      event_id: row.id,
      organization_id: row.organization_id,
      event_type: row.event_type,
      age_s: ageS,
    });
  }

  return { scanned: rows.length, alarmed, skipped_dedup: skipped };
}
