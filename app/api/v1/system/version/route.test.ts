import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { loadAuthUser } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const OWNER = { id: "11111111-1111-4111-8111-111111111111", email: "dono@x.com", is_platform_admin: true };
const MEMBRO = { ...OWNER, id: "22222222-2222-4222-8222-222222222222", is_platform_admin: false };

let versionRow: Record<string, unknown>;
let runRow: Record<string, unknown> | null;
let inserted: Record<string, unknown> | null;
/**
 * Erro que o INSERT em `system_update_runs` deve devolver neste caso — usado
 * para simular a corrida entre dois cliques quase simultâneos batendo no
 * índice único parcial `uniq_system_update_runs_dispatched` (migration 0090).
 */
let insertError: { code: string; message: string } | null;
/** Erro que a leitura (`maybeSingle`) de `system_version` deve devolver neste caso. */
let versionSelectError: { message: string } | null;
/** Erro que a leitura (`maybeSingle`) de `system_update_runs` deve devolver neste caso. */
let runSelectError: { message: string } | null;

beforeEach(() => {
  vi.clearAllMocks();
  inserted = null;
  runRow = null;
  insertError = null;
  versionSelectError = null;
  runSelectError = null;
  versionRow = {
    id: 1,
    current_version: "1.0.0",
    latest_version: "1.1.0",
    off_release: false,
    changelog_raw: "## [1.1.0] — 2026-08-02\n\n**⚠️ Requer atenção**\n\nreconecte o número.\n\n### Adicionado\n\n- botão.\n",
    agent_last_seen_at: new Date().toISOString(),
    update_requested_at: null,
  };

  vi.mocked(createAdminClient).mockReturnValue({
    from: (table: string) => {
      // O double espelha o banco: `system_version` é sempre buscado por
      // `.eq("id", 1)`; `system_update_runs` é buscado tanto por
      // `.order().limit().maybeSingle()` (GET, pega o run mais recente,
      // qualquer status) quanto por `.eq("status","dispatched").order()
      // .limit().maybeSingle()` (POST, checa run em andamento). O `eq()`
      // do double PRECISA encadear para `order()` — se ele só devolvesse
      // `maybeSingle` direto, a chamada real do POST (`eq().order()...`)
      // quebraria com TypeError, e o teste "melhoraria" o mock em vez do
      // double refletir a query de verdade.
      const maybeSingle = async () => ({
        data: table === "system_version" ? versionRow : runRow,
        error: table === "system_version" ? versionSelectError : runSelectError,
      });
      return {
        select: () => ({
          eq: () => ({
            maybeSingle,
            order: () => ({ limit: () => ({ maybeSingle }) }),
          }),
          order: () => ({ limit: () => ({ maybeSingle }) }),
        }),
        insert: (row: Record<string, unknown>) => ({
          select: () => ({
            single: async () => {
              if (insertError) return { data: null, error: insertError };
              inserted = row;
              return { data: { id: "44444444-4444-4444-8444-444444444444", ...row }, error: null };
            },
          }),
        }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    },
  } as never);
});

function get() {
  return new NextRequest("http://localhost/api/v1/system/version");
}
function post() {
  return new NextRequest("http://localhost/api/v1/system/update", { method: "POST" });
}

describe("GET /api/v1/system/version", () => {
  it("exige sessão", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(null as never);
    const { GET } = await import("../version/route");
    const res = await GET(get());
    expect(res.status).toBe(401);
    // `unauthenticated`, não `unauthorized`: o catálogo (lib/api/errors.ts)
    // reserva `unauthorized` ao segredo interno das rotas host↔app. Um
    // frontend que decide por `error.code` (ex.: redirecionar pro login só em
    // `unauthenticated`) não reagiria a um código trocado — a asserção é o
    // que teria pego essa troca antes da revisão.
    const body = await res.json();
    expect(body.error.code).toBe("unauthenticated");
  });

  it("quando a leitura de system_version falha, devolve 500", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    versionSelectError = { message: "conexão caiu" };
    const { GET } = await import("../version/route");
    expect((await GET(get())).status).toBe(500);
  });

  it("quando a leitura do run mais recente falha, devolve 500", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    runSelectError = { message: "conexão caiu" };
    const { GET } = await import("../version/route");
    expect((await GET(get())).status).toBe(500);
  });

  it("entrega só a versão para quem não é dono do servidor", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(MEMBRO as never);
    const { GET } = await import("../version/route");
    const body = await (await GET(get())).json();
    expect(body.data.current_version).toBe("1.0.0");
    expect(body.data.is_owner).toBe(false);
    expect(body.data.update_available).toBeUndefined();
    expect(body.data.notes).toBeUndefined();
  });

  it("entrega o estado completo e a seção do CHANGELOG para o dono", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { GET } = await import("../version/route");
    const body = await (await GET(get())).json();
    expect(body.data.update_available).toBe(true);
    expect(body.data.notes.body).toContain("botão");
    expect(body.data.notes.requires_attention).toContain("reconecte o número");
  });

  it("marca o agente como offline quando o heartbeat é velho", async () => {
    versionRow.agent_last_seen_at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { GET } = await import("../version/route");
    const body = await (await GET(get())).json();
    expect(body.data.agent_online).toBe(false);
  });

  it("deriva unknown num run parado há muito tempo", async () => {
    runRow = {
      id: "55555555-5555-4555-8555-555555555555",
      status: "dispatched",
      last_step: "banco",
      dispatched_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    };
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { GET } = await import("../version/route");
    const body = await (await GET(get())).json();
    expect(body.data.run.status).toBe("unknown");
  });
});

describe("POST /api/v1/system/update", () => {
  it("exige sessão", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(null as never);
    const { POST } = await import("../update/route");
    const res = await POST(post());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthenticated");
  });

  it("nega para quem não é dono do servidor", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(MEMBRO as never);
    const { POST } = await import("../update/route");
    expect((await POST(post())).status).toBe(403);
    expect(inserted).toBeNull();
  });

  it("quando a leitura de system_version falha, devolve 500 e não 409", async () => {
    // Sem checar o erro do select, `current`/`latest` viram "" e o fluxo cai
    // no 409 otimista de "você já está em dia" — a pior mensagem possível
    // bem na hora de uma falha de infraestrutura real.
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    versionSelectError = { message: "conexão caiu" };
    const { POST } = await import("../update/route");
    const res = await POST(post());
    expect(res.status).toBe(500);
    expect(inserted).toBeNull();
  });

  it("cria o run, marca o pedido e audita", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { POST } = await import("../update/route");
    expect((await POST(post())).status).toBe(200);
    expect(inserted).toMatchObject({ from_version: "1.0.0", to_version: "1.1.0", status: "dispatched" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "system.update_requested" }));
  });

  it("recusa um segundo pedido enquanto há run em andamento", async () => {
    runRow = {
      id: "55555555-5555-4555-8555-555555555555",
      status: "dispatched",
      dispatched_at: new Date().toISOString(),
    };
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { POST } = await import("../update/route");
    expect((await POST(post())).status).toBe(409);
  });

  it("recusa quando já está na última versão", async () => {
    versionRow.latest_version = "1.0.0";
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { POST } = await import("../update/route");
    expect((await POST(post())).status).toBe(409);
  });

  it("converte a violação do índice único (corrida de dois cliques) em 409, não 500", async () => {
    // O check "já existe run em andamento" é só otimização — não é exclusão
    // mútua. Sob corrida, os dois requests passam por ele (runRow === null
    // pros dois) e só o segundo INSERT bate no índice único parcial
    // `uniq_system_update_runs_dispatched`. O Postgres devolve 23505; a rota
    // precisa tratar isso como o MESMO estado de negócio do check acima, não
    // deixar vazar como 500.
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    insertError = { code: "23505", message: 'duplicate key value violates unique constraint "uniq_system_update_runs_dispatched"' };
    const { POST } = await import("../update/route");
    const res = await POST(post());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("state_conflict");
    expect(body.error.message).toBe("Já existe uma atualização em andamento.");
  });
});
