/**
 * Onda 6 — timestamps por estágio do pipeline (messages.metadata.pipeline).
 * Merge jsonb, sem tabela nova. Best-effort: falha de stamp nunca derruba o fluxo.
 */
import type pg from "pg";

export type PipelineStage =
  | "webhook_at"
  | "dispatch_requested_at"
  | "drain_enqueued_at"
  | "debounce_until"
  | "turn_started_at"
  | "turn_completed_at"
  | "media_persist_started_at"
  | "media_persist_done_at"
  | "media_derive_started_at"
  | "media_derive_done_at"
  | "reply_sent_at";

export type PipelinePatch = Partial<Record<PipelineStage, string>>;

export async function stampMessagePipeline(
  pool: pg.Pool,
  organizationId: string,
  messageId: string,
  patch: PipelinePatch,
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  try {
    await pool.query(
      `update messages
       set metadata = jsonb_set(
         coalesce(metadata, '{}'::jsonb),
         '{pipeline}',
         coalesce(metadata->'pipeline', '{}'::jsonb) || $3::jsonb,
         true
       )
       where organization_id = $1 and id = $2`,
      [organizationId, messageId, JSON.stringify(patch)],
    );
  } catch {
    // cosmética de obs — nunca derruba ingestão/turno.
  }
}

export async function stampJobPipeline(
  pool: pg.Pool,
  organizationId: string,
  jobId: string,
  patch: PipelinePatch,
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  try {
    await pool.query(
      `update job_queue
       set payload = jsonb_set(
         coalesce(payload, '{}'::jsonb),
         '{pipeline}',
         coalesce(payload->'pipeline', '{}'::jsonb) || $3::jsonb,
         true
       )
       where organization_id = $1 and id = $2`,
      [organizationId, jobId, JSON.stringify(patch)],
    );
  } catch {
    // cosmética de obs.
  }
}

/** Carimbo ISO now() — atalho pros call sites. */
export function nowIso(): string {
  return new Date().toISOString();
}
