/**
 * O slot de fonte de conhecimento: quem o ocupa, quem o libera, e o que o
 * produto diz a quem esbarra nele (remediação do PR #277 / issue #265).
 *
 * O índice `ai_knowledge_sources_unique_per_agent` é
 * `(agent_id, source_type) WHERE is_active`. Três defeitos moravam aí:
 *
 *  1. **A mensagem do 409 mandava fazer o que o produto não faz.** Ela dizia
 *     "Edite ou arquive a existente" — e nenhuma das duas ações existe: editar
 *     FAQ é `toast.info("Editor de FAQ em breve.")` e não há controle de
 *     arquivar em tela nenhuma. Pior, arquivar não liberava o slot nem pela
 *     API: o DELETE só gravava `status='archived'` e `is_active` seguia `true`,
 *     que é o predicado do índice. Quem seguisse a instrução não saía do lugar.
 *  2. **O endpoint irmão tinha o mesmo 500 mudo.** O upload de política insere
 *     na MESMA tabela com `source_type: "policy"`, sob o MESMO índice, e o
 *     23505 dele continuava saindo como `internal_error` — conserto por
 *     instância deixa a classe do defeito viva.
 *  3. A regra "quais tipos aceitam texto colado" estava em quatro cópias.
 *
 * Os dois primeiros são comportamento e estão vigiados abaixo. O terceiro é
 * estrutura: `lib/ai/knowledge/tipos-de-fonte.ts` é a fonte única, e os testes
 * de tela/rota que dependem dela quebram se ela divergir.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ingestPolicyFile } from "@/lib/ai/rag/ingest/policy";
import { mensagemDeTipoJaEmUso } from "@/lib/ai/knowledge/tipos-de-fonte";
import type { AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(), resolveActiveOrg: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/rag/ingest/policy", () => ({
  ingestPolicyFile: vi.fn(),
  PdfExtractError: class PdfExtractError extends Error {},
}));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const KS_ID = "33333333-3333-4333-8333-333333333333";

const COLISAO = {
  code: "23505",
  message: 'duplicate key value violates unique constraint "ai_knowledge_sources_unique_per_agent"',
};

function sessaoOk(): void {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "user-1", email: "u@example.com" } as unknown as AuthUser,
    org: { orgId: ORG_ID, name: "Org", role: "manager" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Arquivar libera o slot
// ---------------------------------------------------------------------------

describe("DELETE /api/v1/ai/knowledge/sources/[id] — arquivar libera o slot", () => {
  /** Dubla o admin client e captura o payload do `.update()`. */
  function dublarBanco() {
    const leitura = {
      select: () => leitura,
      eq: () => leitura,
      maybeSingle: async () => ({ data: { id: KS_ID }, error: null }),
    };
    vi.mocked(createClient).mockResolvedValue({
      from: () => leitura,
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    const updates: Array<Record<string, unknown>> = [];
    const admin = {
      from: () => ({
        update: (payload: Record<string, unknown>) => {
          updates.push(payload);
          const cadeia = {
            eq: () => cadeia,
            then: (f: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(f),
          };
          return cadeia;
        },
      }),
    };
    vi.mocked(createAdminClient).mockReturnValue(
      admin as unknown as ReturnType<typeof createAdminClient>,
    );
    return { updates };
  }

  it("grava is_active=false JUNTO com status='archived'", async () => {
    sessaoOk();
    const { updates } = dublarBanco();
    const { DELETE } = await import("@/app/api/v1/ai/knowledge/sources/[id]/route");

    const res = await DELETE(
      new NextRequest(`http://localhost/api/v1/ai/knowledge/sources/${KS_ID}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: KS_ID }) },
    );

    expect(res.status).toBe(200);
    // O `status` sozinho passava antes e não liberava nada: o predicado do
    // índice único é `WHERE is_active`, e nada no repo punha essa coluna em
    // false. Exigir as DUAS chaves é o ponto — checar só `is_active` deixaria
    // passar um conserto que perdesse o arquivamento pelo caminho.
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ status: "archived", is_active: false });
  });
});

// ---------------------------------------------------------------------------
// 2. A mensagem do 409 não manda fazer o que a tela não faz
// ---------------------------------------------------------------------------

describe("mensagem do 409 knowledge_source_type_in_use", () => {
  it("não instrui editar nem arquivar pela tela — nenhuma das duas existe lá", () => {
    const msg = mensagemDeTipoJaEmUso("faq");

    // A frase antiga era "Edite ou arquive a existente em vez de criar outra".
    // Editar FAQ pela tela é um toast "em breve" e não há controle de arquivar
    // em lugar nenhum: quem seguisse a instrução não saía do lugar.
    expect(msg).not.toMatch(/\bEdite\b/);
    expect(msg).not.toMatch(/\bArquive\b/i);
    // Continua dizendo QUAL é o problema e nomeando a saída que de fato existe.
    expect(msg).toContain("FAQ");
    expect(msg).toContain("uma de cada tipo por agente");
    expect(msg).toContain("DELETE /api/v1/ai/knowledge/sources/:id");
  });

  it("nomeia o tipo certo — a de política não fala em FAQ", () => {
    expect(mensagemDeTipoJaEmUso("policy")).toContain("política");
    expect(mensagemDeTipoJaEmUso("policy")).not.toContain("FAQ");
  });
});

// ---------------------------------------------------------------------------
// 3. O endpoint irmão traduz a mesma colisão
// ---------------------------------------------------------------------------

describe("POST /api/v1/ai/knowledge/sources/upload — a mesma colisão, o mesmo 409", () => {
  /** `erroDoInsert` só afeta a escrita em `ai_knowledge_sources`. */
  function dublarBanco(erroDoInsert: { code?: string; message: string } | null) {
    const leitura = {
      select: () => leitura,
      eq: () => leitura,
      maybeSingle: async () => ({ data: { id: AGENT_ID }, error: null }),
    };
    vi.mocked(createClient).mockResolvedValue({
      from: () => leitura,
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    const removidos: string[][] = [];
    const admin = {
      from: () => ({
        insert: () => ({
          select: () => ({
            single: async () => ({
              data: erroDoInsert ? null : { id: KS_ID },
              error: erroDoInsert,
            }),
          }),
        }),
      }),
      storage: {
        from: () => ({
          upload: async () => ({ error: null }),
          remove: async (paths: string[]) => {
            removidos.push(paths);
            return { error: null };
          },
        }),
      },
      rpc: async () => ({ error: null }),
    };
    vi.mocked(createAdminClient).mockReturnValue(
      admin as unknown as ReturnType<typeof createAdminClient>,
    );
    vi.mocked(ingestPolicyFile).mockResolvedValue({ chunkCount: 3 } as never);
    return { removidos };
  }

  /**
   * Entrega o FormData direto, sem serializar multipart. A suíte roda em jsdom
   * (`vitest.config.ts`), e o `FormData`/`File` do jsdom não atravessam o
   * `Request` do undici: montar o corpo de verdade fazia `req.formData()`
   * lançar e a rota devolver 400 — o teste morria três guardas antes do insert,
   * que é o que ele existe para exercitar. A rota só chama `formData()`.
   */
  function req(): NextRequest {
    const form = new FormData();
    form.set("file", new File(["# Política de troca"], "politica.md", { type: "text/markdown" }));
    form.set("agent_id", AGENT_ID);
    form.set("name", "Política de troca");
    return { formData: async () => form } as unknown as NextRequest;
  }

  it("23505 vira 409 knowledge_source_type_in_use, não 500 mudo", async () => {
    sessaoOk();
    const { removidos } = dublarBanco(COLISAO);
    const { POST } = await import("@/app/api/v1/ai/knowledge/sources/upload/route");

    const res = await POST(req());

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("knowledge_source_type_in_use");
    expect(body.error.message).toContain("política");
    // O 500 antigo também citaria a constraint; o texto cru do Postgres não
    // pode vazar para quem lê.
    expect(body.error.message).not.toContain("constraint");
    expect(body.error.message).not.toContain("duplicate");
    // O blob órfão continua sendo removido — a tradução do erro não pode ter
    // pulado a limpeza que já existia.
    expect(removidos).toHaveLength(1);
  });

  it("outro erro do banco continua 500 — a tradução é só do conflito", async () => {
    sessaoOk();
    dublarBanco({ code: "08006", message: "connection failure" });
    const erroDoConsole = vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await import("@/app/api/v1/ai/knowledge/sources/upload/route");

    const res = await POST(req());
    erroDoConsole.mockRestore();

    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("internal_error");
  });
});
