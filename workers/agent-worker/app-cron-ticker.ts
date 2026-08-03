/**
 * Dispara os crons HTTP do app Next.js (paridade com o serviço `scheduler`
 * do docker-compose.prod.yml). No Railway free não cabe um 6º serviço; o
 * agent-worker 24/7 assume o papel do crond.
 *
 * Auth: Bearer INTERNAL_SECRET (mesmo contrato dos /api/v1/cron/*).
 */
import { setTimeout as sleep } from "node:timers/promises";

import type { Logger } from "@/lib/agent-engine/obs/logger";

export interface AppCronJob {
  /** Path sob /api/v1/cron/ (sem leading slash). */
  path: string;
  /** Intervalo mínimo entre disparos (ms). */
  everyMs: number;
  /** Timeout do fetch (ms). */
  timeoutMs?: number;
}

/** Espelho do crontab do compose.prod (+ crons que existem no app e faltavam lá). */
export const DEFAULT_APP_CRON_JOBS: AppCronJob[] = [
  { path: "agent-dispatcher", everyMs: 60_000, timeoutMs: 25_000 },
  { path: "followup-flow-worker", everyMs: 60_000, timeoutMs: 25_000 },
  { path: "event-log-drain", everyMs: 60_000, timeoutMs: 45_000 },
  { path: "routing-worker", everyMs: 60_000, timeoutMs: 25_000 },
  { path: "storage-redaction?limit=50", everyMs: 5 * 60_000, timeoutMs: 25_000 },
  { path: "snooze-watcher", everyMs: 5 * 60_000, timeoutMs: 25_000 },
  { path: "attendant-heartbeat", everyMs: 5 * 60_000, timeoutMs: 25_000 },
  { path: "risk-watcher", everyMs: 5 * 60_000, timeoutMs: 25_000 },
  { path: "lgpd-sla-watcher", everyMs: 60 * 60_000, timeoutMs: 60_000 },
  { path: "context-lifecycle-watcher", everyMs: 60 * 60_000, timeoutMs: 60_000 },
  { path: "kb-conversations-batch", everyMs: 24 * 60 * 60_000, timeoutMs: 120_000 },
];

export interface AppCronTickerOpts {
  baseUrl: string;
  secret: string;
  jobs?: AppCronJob[];
  /** Resolução do loop (default 15s). */
  tickMs?: number;
}

function errMsg(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return (message.split("\n", 1)[0] ?? "").slice(0, 300);
}

export async function runAppCronTicker(
  opts: AppCronTickerOpts,
  log: Logger,
  signal: AbortSignal,
): Promise<void> {
  const jobs = opts.jobs ?? DEFAULT_APP_CRON_JOBS;
  const tickMs = opts.tickMs ?? 15_000;
  const base = opts.baseUrl.replace(/\/$/, "");
  const lastRun = new Map<string, number>();

  log.info("app-cron-ticker: ligado", {
    base_url: base,
    jobs: jobs.length,
    tick_ms: tickMs,
  });

  while (!signal.aborted) {
    const now = Date.now();
    for (const job of jobs) {
      if (signal.aborted) break;
      const prev = lastRun.get(job.path) ?? 0;
      if (now - prev < job.everyMs) continue;

      const url = `${base}/api/v1/cron/${job.path}`;
      const timeoutMs = job.timeoutMs ?? 25_000;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${opts.secret}` },
          signal: ac.signal,
          cache: "no-store",
        });
        lastRun.set(job.path, Date.now());
        if (!res.ok) {
          // 404 = rota ainda não deployada (ex.: feature em branch) — warn, não fatal.
          log.warn("app-cron-ticker: cron respondeu não-OK", {
            path: job.path,
            status: res.status,
          });
        }
      } catch (err) {
        log.error("app-cron-ticker: falha ao disparar cron", {
          path: job.path,
          error: errMsg(err),
        });
        // Não avança lastRun em falha de rede — tenta de novo no próximo tick.
      } finally {
        clearTimeout(timer);
      }
    }
    await sleep(tickMs, undefined, { signal }).catch(() => undefined);
  }
}
