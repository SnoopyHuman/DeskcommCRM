/**
 * DELETE /api/v1/contacts/[id]/context/cutoff — C2-05.
 *
 * Achado A da review do PR #4 (QA manual): a validação anterior limpou o
 * campo `context_reset_at` direto no banco em vez de chamar a rota real, e
 * portanto nunca exercitou o handler TypeScript. Este arquivo chama o `DELETE`
 * exportado de verdade (auth e Supabase mockados, no mesmo padrão de
 * app/api/v1/pipelines/[id]/stages/route.test.ts), cobrindo os 7 pontos que a
 * review pediu: cutoff limpo (200/cleared:true), reason nulo junto,
 * idempotência (200/cleared:false sem 2ª escrita), 404 sem vazamento
 * cross-tenant/contato inexistente, e role abaixo de manager.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const MANAGER_ID = "11111111-1111-4111-8111-111111111111";
const CONTACT_ID = "33333333-3333-4333-8333-333333333333";
const LEAD_ID = "44444444-4444-4444-8444-444444444444";

interface Contact {
  id: string;
  context_reset_at: string | null;
  context_reset_reason: string | null;
}

interface DbState {
  contact: Contact | null;
  leadId: string | null;
  updates: Array<{ table: string; patch: Record<string, unknown> }>;
  activities: Array<Record<string, unknown>>;
}

function chain(state: DbState, table: string): unknown {
  const self = {
    select: () => self,
    eq: () => self,
    order: () => self,
    limit: () => self,
    update: (patch: Record<string, unknown>) => {
      state.updates.push({ table, patch });
      return self;
    },
    insert: (row: Record<string, unknown>) => {
      state.activities.push(row);
      return self;
    },
    maybeSingle: async () => {
      if (table === "contacts") return { data: state.contact, error: null };
      if (table === "crm_leads") {
        return { data: state.leadId ? { id: state.leadId } : null, error: null };
      }
      return { data: null, error: null };
    },
    // Query builders do supabase-js são "thenable": `await supabase.from(...).update(...).eq(...)`
    // sem `.maybeSingle()` já resolve — precisa desse then pro caminho do UPDATE funcionar.
    then: (resolve: (v: { data: null; error: null }) => void) => resolve({ data: null, error: null }),
  };
  return self;
}

function makeDb(opts: { contact: Contact | null; leadId?: string | null }): DbState {
  const state: DbState = {
    contact: opts.contact,
    leadId: opts.leadId ?? LEAD_ID,
    updates: [],
    activities: [],
  };
  vi.mocked(createClient).mockResolvedValue({
    from: (table: string) => chain(state, table),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return state;
}

function authOk(): void {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    user: { id: MANAGER_ID } as any,
    org: { orgId: ORG_ID, name: "Org", role: "manager" },
  });
}

function delReq(): NextRequest {
  return new NextRequest(`http://localhost/api/v1/contacts/${CONTACT_ID}/context/cutoff`, {
    method: "DELETE",
  });
}

const ctx = { params: Promise.resolve({ id: CONTACT_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DELETE /api/v1/contacts/[id]/context/cutoff", () => {
  it("role abaixo de manager → repassa a resposta de requireRole, sem tocar no banco", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Permissão insuficiente. Requer role >= manager.", 403, {}),
    });
    const { DELETE } = await import("./route");
    const res = await DELETE(delReq(), ctx);
    expect(res.status).toBe(403);
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("manager");
  });

  it("contato inexistente ou de outra organização → 404, sem vazamento cross-tenant", async () => {
    authOk();
    const state = makeDb({ contact: null });
    const { DELETE } = await import("./route");
    const res = await DELETE(delReq(), ctx);
    expect(res.status).toBe(404);
    expect(state.updates).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("cutoff presente → 200, cleared:true, context_reset_at e context_reset_reason viram null, audit emitido", async () => {
    authOk();
    const state = makeDb({
      contact: {
        id: CONTACT_ID,
        context_reset_at: "2026-08-01T15:51:00Z",
        context_reset_reason: "stage_policy",
      },
    });
    const { DELETE } = await import("./route");
    const res = await DELETE(delReq(), ctx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { contact_id: string; cleared: boolean } };
    expect(body.data).toEqual({ contact_id: CONTACT_ID, cleared: true });

    const write = state.updates.find((u) => u.table === "contacts");
    expect(write?.patch).toEqual({ context_reset_at: null, context_reset_reason: null });

    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "context.cutoff_cleared",
        organizationId: ORG_ID,
        resourceType: "contact",
        resourceId: CONTACT_ID,
      }),
    );
    // Sem lead vinculado ainda emite atividade (lead existe na fixture) — prova
    // que o corte desfeito entra na timeline, não só no campo cru do contato.
    expect(state.activities).toHaveLength(1);
  });

  it("segunda chamada (sem cutoff) é idempotente: 200/cleared:false, nenhuma escrita nem audit", async () => {
    authOk();
    const state = makeDb({
      contact: { id: CONTACT_ID, context_reset_at: null, context_reset_reason: null },
    });
    const { DELETE } = await import("./route");
    const res = await DELETE(delReq(), ctx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { contact_id: string; cleared: boolean } };
    expect(body.data).toEqual({ contact_id: CONTACT_ID, cleared: false });
    expect(state.updates).toEqual([]);
    expect(state.activities).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });
});
