import { beforeEach, describe, expect, it, vi } from "vitest";

const { createAdminClientMock, auditMock, emitLeadActivityMock } = vi.hoisted(() => ({
  createAdminClientMock: vi.fn(),
  auditMock: vi.fn().mockResolvedValue(undefined),
  emitLeadActivityMock: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: createAdminClientMock }));
vi.mock("@/lib/audit", () => ({ audit: auditMock }));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: emitLeadActivityMock,
}));
vi.mock("@/lib/env", () => ({
  env: {
    INTERNAL_CRON_SECRET: "cron-secret",
    INTERNAL_SECRET: "internal-secret",
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

interface FakeState {
  candidates: unknown[];
  openCases: unknown[];
  contacts: Map<string, string | null>;
  pendingJobs: Array<{ id: string; organization_id: string; contact_id: string }>;
}

function queryFor(state: FakeState, table: string) {
  const query: Record<string, unknown> = {};
  let operation: "select" | "update" = "select";
  let patch: Record<string, unknown> = {};
  const filters = new Map<string, unknown>();
  let orFilter = "";

  query.select = vi.fn(() => query);
  query.update = vi.fn((nextPatch: unknown) => {
    operation = "update";
    patch = nextPatch as Record<string, unknown>;
    return query;
  });
  query.eq = vi.fn((column: unknown, value: unknown) => {
    filters.set(String(column), value);
    return query;
  });
  query.not = vi.fn(() => query);
  query.or = vi.fn((value: unknown) => {
    orFilter = String(value);
    return query;
  });
  query.order = vi.fn(() => query);
  let rangeFrom = 0;
  let rangeTo = Number.POSITIVE_INFINITY;
  query.range = vi.fn((from: number, to: number) => {
    rangeFrom = from;
    rangeTo = to;
    return query;
  });
  query.maybeSingle = vi.fn(() => query);
  query.then = vi.fn((resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
    try {
      const organizationId = String(filters.get("organization_id") ?? "");
      const contactId = String(
        filters.get(table === "contacts" ? "id" : "contact_id") ?? "",
      );

      if (table === "crm_leads") {
        const candidates = state.candidates
          .map((row) => {
            const candidate = row as { contact_id?: string; contacts?: unknown };
            return {
              ...candidate,
              contacts: {
                organization_id: (candidate as { organization_id?: string }).organization_id ?? "",
                context_reset_at: state.contacts.get(candidate.contact_id ?? "") ?? null,
              },
            };
          })
          .slice(rangeFrom, rangeTo + 1);
        return Promise.resolve({ data: candidates, error: null }).then(resolve, reject);
      }
      if (table === "agent_cases") {
        return Promise.resolve({
          data: state.openCases.slice(rangeFrom, rangeTo + 1),
          error: null,
        }).then(resolve, reject);
      }

      if (table === "contacts" && operation === "update") {
        const current = state.contacts.get(contactId) ?? null;
        const [, lessThan] = orFilter.split(",context_reset_at.lt.");
        const canClaim =
          current === null ||
          (lessThan !== undefined && new Date(current).getTime() < new Date(lessThan).getTime());
        if (!canClaim) return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        state.contacts.set(contactId, String(patch.context_reset_at));
        return Promise.resolve({ data: [{ id: contactId }], error: null }).then(resolve, reject);
      }

      if (table === "job_queue" && operation === "update") {
        const canceled = state.pendingJobs.filter(
          (job) => job.organization_id === organizationId && job.contact_id === contactId,
        );
        state.pendingJobs = state.pendingJobs.filter((job) => !canceled.includes(job));
        return Promise.resolve({ data: canceled.map(({ id }) => ({ id })), error: null }).then(resolve, reject);
      }

      return Promise.resolve({ data: [], error: null }).then(resolve, reject);
    } catch (error) {
      return reject ? Promise.resolve(reject(error)) : Promise.reject(error);
    }
  });

  return query;
}

function fakeAdmin(state: FakeState) {
  return {
    from: vi.fn((table: string) => queryFor(state, table)),
  };
}

function candidate(
  id: string,
  organizationId: string,
  contactId: string,
  stageChangedAt: string,
  stageName: string,
  afterDays: number,
) {
  return {
    id,
    organization_id: organizationId,
    contact_id: contactId,
    stage_changed_at: stageChangedAt,
    crm_stages: {
      organization_id: organizationId,
      name: stageName,
      resets_context: true,
      context_reset_after_days: afterDays,
      is_archived: false,
    },
    contacts: { organization_id: organizationId, context_reset_at: null },
  };
}

async function callRoute(method: "GET" | "POST" = "POST", secret = "cron-secret") {
  const { GET, POST } = await import("./route");
  const handler = method === "GET" ? GET : POST;
  return handler(
    new Request("http://test.local/api/v1/cron/context-lifecycle-watcher", {
      method,
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    }) as never,
  );
}

describe("context-lifecycle-watcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falha fechado sem Bearer válido", async () => {
    const response = await callRoute("GET", "");
    expect(response.status).toBe(403);
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  it("marca só o que venceu, bloqueia caso humano, cancela jobs e deduplica por contato", async () => {
    const now = Date.now();
    const state: FakeState = {
      candidates: [
        // 8 dias: elegível.
        candidate("lead-a-1", "org-a", "contact-a", new Date(now - 8 * 86_400_000).toISOString(), "Entregue", 7),
        // Mesmo contato e mesmo estágio: uma atividade, não duas.
        candidate("lead-a-2", "org-a", "contact-a", new Date(now - 8 * 86_400_000).toISOString(), "Entregue", 7),
        // 6 dias: ainda dentro da carência de 7.
        candidate("lead-b", "org-a", "contact-b", new Date(now - 6 * 86_400_000).toISOString(), "Aguardando", 7),
        // 8 dias, mas caso humano aberto.
        candidate("lead-c", "org-a", "contact-c", new Date(now - 8 * 86_400_000).toISOString(), "Alta", 7),
        // Outra organização: deve ser tratada no próprio escopo.
        candidate("lead-d", "org-b", "contact-d", new Date(now - 8 * 86_400_000).toISOString(), "Pago", 7),
      ],
      openCases: [
        {
          organization_id: "org-a",
          conversations: { organization_id: "org-a", contact_id: "contact-c" },
        },
      ],
      contacts: new Map([
        ["contact-a", null],
        ["contact-b", null],
        ["contact-c", null],
        ["contact-d", null],
      ]),
      pendingJobs: [
        { id: "job-a", organization_id: "org-a", contact_id: "contact-a" },
        { id: "job-d", organization_id: "org-b", contact_id: "contact-d" },
      ],
    };
    createAdminClientMock.mockReturnValue(fakeAdmin(state));

    const first = await callRoute();
    expect(first.status).toBe(200);
    expect((await first.json()).data).toMatchObject({
      scanned: 2,
      marked: 2,
      jobs_canceled: 2,
      failures: 0,
    });
    expect(state.contacts.get("contact-a")).not.toBeNull();
    expect(state.contacts.get("contact-d")).not.toBeNull();
    expect(state.contacts.get("contact-b")).toBeNull();
    expect(state.contacts.get("contact-c")).toBeNull();
    expect(emitLeadActivityMock).toHaveBeenCalledTimes(2);
    expect(auditMock).toHaveBeenCalledTimes(2);

    // A segunda batida encontra as marcas feitas pela primeira e não cria
    // uma segunda atividade/auditoria.
    const second = await callRoute();
    expect(second.status).toBe(200);
    expect((await second.json()).data).toMatchObject({
      scanned: 0,
      marked: 0,
      jobs_canceled: 0,
    });
    expect(emitLeadActivityMock).toHaveBeenCalledTimes(2);
    expect(auditMock).toHaveBeenCalledTimes(2);
  });

  it("pagina além do limite de 1000 linhas do PostgREST em vez de travar na primeira página", async () => {
    const now = Date.now();
    // As primeiras 1000 linhas (posição 0-999, mesma ordenação da query real)
    // ainda estão dentro da carência de 7 dias — não vencidas. Só as linhas
    // 1000 e 1001 venceram. Sem paginar por .range(), o antigo código lia só
    // a primeira página de 1000 linhas do PostgREST e nunca via essas duas.
    const notYetDue = Array.from({ length: 1000 }, (_, i) =>
      candidate(
        `lead-wait-${i}`,
        "org-a",
        `contact-wait-${i}`,
        new Date(now - 1 * 86_400_000).toISOString(),
        "Entregue",
        7,
      ),
    );
    const due = [
      candidate("lead-due-0", "org-a", "contact-due-0", new Date(now - 8 * 86_400_000).toISOString(), "Entregue", 7),
      candidate("lead-due-1", "org-a", "contact-due-1", new Date(now - 8 * 86_400_000).toISOString(), "Entregue", 7),
    ];
    const candidates = [...notYetDue, ...due];
    const state: FakeState = {
      candidates,
      openCases: [],
      contacts: new Map(candidates.map((c) => [(c as { contact_id: string }).contact_id, null])),
      pendingJobs: [],
    };
    createAdminClientMock.mockReturnValue(fakeAdmin(state));

    const response = await callRoute();
    expect(response.status).toBe(200);
    const body = (await response.json()).data;
    expect(body.marked).toBe(2);
    expect(state.contacts.get("contact-due-0")).not.toBeNull();
    expect(state.contacts.get("contact-due-1")).not.toBeNull();
    for (const row of notYetDue) {
      const contactId = (row as { contact_id: string }).contact_id;
      expect(state.contacts.get(contactId)).toBeNull();
    }
  });
});
