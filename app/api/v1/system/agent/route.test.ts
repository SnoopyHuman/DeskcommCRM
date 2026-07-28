import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "segredo-de-teste", INTERNAL_CRON_SECRET: "" } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const RUN_ID = "33333333-3333-4333-8333-333333333333";

function req(body: unknown, secret = "segredo-de-teste") {
  return new NextRequest("http://localhost/api/v1/system/agent", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
}

const HEARTBEAT = {
  kind: "heartbeat",
  current_version: "1.0.0",
  current_sha: "abc1234",
  off_release: false,
  latest_version: "1.1.0",
  changelog: "## [1.1.0] — 2026-08-02\n\nnovidade\n",
};

/** Estado do banco simulado, controlado por caso. */
let versionRow: Record<string, unknown>;
let runRow: Record<string, unknown> | null;
let updated: Record<string, unknown> | null;

beforeEach(() => {
  versionRow = { id: 1, update_requested_at: null, update_requested_by: null };
  runRow = null;
  updated = null;

  vi.mocked(createAdminClient).mockReturnValue({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: table === "system_version" ? versionRow : runRow, error: null }) }),
        order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: runRow, error: null }) }) }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: async () => { updated = { table, ...patch }; return { error: null }; },
      }),
    }),
  } as never);
});

describe("POST /api/v1/system/agent", () => {
  it("recusa sem o segredo", async () => {
    const { POST } = await import("./route");
    const res = await POST(req(HEARTBEAT, "segredo-errado"));
    expect(res.status).toBe(401);
    expect(updated).toBeNull();
  });

  it("recusa segredo de tamanho diferente sem lançar (timingSafeEqual explode com buffers de tamanho distinto)", async () => {
    const { POST } = await import("./route");
    const res = await POST(req(HEARTBEAT, "x"));
    expect(res.status).toBe(401);
    expect(updated).toBeNull();
  });

  it("heartbeat grava versão, changelog e o carimbo de vida do agente", async () => {
    const { POST } = await import("./route");
    const res = await POST(req(HEARTBEAT));
    expect(res.status).toBe(200);
    expect(updated).toMatchObject({
      table: "system_version",
      current_version: "1.0.0",
      latest_version: "1.1.0",
    });
    expect(updated?.agent_last_seen_at).toBeTruthy();
  });

  it("heartbeat responde update_requested=false quando ninguém pediu", async () => {
    const { POST } = await import("./route");
    const body = await (await POST(req(HEARTBEAT))).json();
    expect(body.data.update_requested).toBe(false);
    expect(body.data.run_id).toBeNull();
  });

  it("heartbeat responde a ordem pendente e devolve o run", async () => {
    versionRow = { id: 1, update_requested_at: new Date().toISOString(), update_requested_by: null };
    runRow = { id: RUN_ID, status: "dispatched", dispatched_at: new Date().toISOString() };
    const { POST } = await import("./route");
    const body = await (await POST(req(HEARTBEAT))).json();
    expect(body.data.update_requested).toBe(true);
    expect(body.data.run_id).toBe(RUN_ID);
  });

  it("recusa changelog acima do teto", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({ ...HEARTBEAT, changelog: "x".repeat(70_000) }));
    expect(res.status).toBe(422);
  });

  it("run_progress grava o passo sem encerrar o run", async () => {
    runRow = { id: RUN_ID, status: "dispatched", dispatched_at: new Date().toISOString() };
    const { POST } = await import("./route");
    const res = await POST(req({ kind: "run_progress", run_id: RUN_ID, step: "banco" }));
    expect(res.status).toBe(200);
    expect(updated).toMatchObject({ table: "system_update_runs", last_step: "banco" });
    expect(updated?.status).toBeUndefined();
  });

  it("run_result encerra o run, limpa o pedido e audita o desfecho", async () => {
    const { audit } = await import("@/lib/audit");
    runRow = { id: RUN_ID, status: "dispatched", dispatched_at: new Date().toISOString() };
    const { POST } = await import("./route");
    const res = await POST(req({ kind: "run_result", run_id: RUN_ID, status: "success", log_tail: "ok" }));
    expect(res.status).toBe(200);
    expect(updated).toMatchObject({ table: "system_update_runs", status: "success" });
    expect(updated?.finished_at).toBeTruthy();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "system.update_finished", resourceId: RUN_ID }),
    );
  });

  it("recusa reescrever um run que já terminou", async () => {
    runRow = { id: RUN_ID, status: "success", dispatched_at: new Date().toISOString() };
    const { POST } = await import("./route");
    const res = await POST(req({ kind: "run_result", run_id: RUN_ID, status: "failed", log_tail: "" }));
    expect(res.status).toBe(409);
  });

  it("recusa corpo com kind desconhecido", async () => {
    const { POST } = await import("./route");
    expect((await POST(req({ kind: "sei-la" }))).status).toBe(422);
  });
});
