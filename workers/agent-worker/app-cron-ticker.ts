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
  // 3s, não 60s: este drain está no CAMINHO CRÍTICO da resposta ao cliente —
  // é ele que move media.persist_requested → media.derive_requested (áudio
  // virando texto antes de o agente responder). A 60s eram DOIS hops de até um
  // minuto cada, o que colocava a transcrição em ~75s e, de quebra, estourava a
  // validade da URL de mídia do WAHA (áudio perdido com waha_media_404).
  { path: "event-log-drain", everyMs: 3_000, timeoutMs: 45_000 },
  // Onda 6: alarme de evento parado (pending crítico > limiar → inbox + Sentry).
  { path: "event-log-stale-watcher", everyMs: 60_000, timeoutMs: 25_000 },
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
  /** Resolução do loop (default 1s — precisa ser ≤ o menor everyMs). */
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
  const tickMs = opts.tickMs ?? 1_000;
  const base = opts.baseUrl.replace(/\/$/, "");
  const lastRun = new Map<string, number>();
  // Um cron LENTO não pode segurar um cron RÁPIDO. Antes o loop era sequencial
  // com `await` por job: um kb-conversations-batch de 120s congelava o
  // event-log-drain junto, e com ele a resposta ao cliente. Agora cada job voa
  // solto e este set garante que ele não empilhe consigo mesmo.
  const inFlight = new Set<string>();
  const voando = new Set<Promise<void>>();

  log.info("app-cron-ticker: ligado", {
    base_url: base,
    jobs: jobs.length,
    tick_ms: tickMs,
  });

  const dispara = async (job: AppCronJob): Promise<void> => {
    const url = `${base}/api/v1/cron/${job.path}`;
    const timeoutMs = job.timeoutMs ?? 25_000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const abortaJunto = (): void => ac.abort();
    signal.addEventListener("abort", abortaJunto, { once: true });
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${opts.secret}` },
        signal: ac.signal,
        cache: "no-store",
      });
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
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abortaJunto);
      // Avança SEMPRE (inclusive em falha): quem dita o ritmo de retentativa é o
      // everyMs do job. Não avançar aqui, com tick de 1s, viraria martelada no
      // app fora do ar.
      lastRun.set(job.path, Date.now());
      inFlight.delete(job.path);
    }
  };

  while (!signal.aborted) {
    const now = Date.now();
    for (const job of jobs) {
      if (signal.aborted) break;
      if (inFlight.has(job.path)) continue;
      const prev = lastRun.get(job.path) ?? 0;
      if (now - prev < job.everyMs) continue;
      inFlight.add(job.path);
      const p = dispara(job).finally(() => voando.delete(p));
      voando.add(p);
    }
    await sleep(tickMs, undefined, { signal }).catch(() => undefined);
  }
  // Shutdown limpo: o abort acima já cancelou os fetches em voo; aqui só
  // esperamos eles assentarem antes de devolver o controle ao main.
  await Promise.allSettled([...voando]);
}
