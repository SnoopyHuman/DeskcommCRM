import { beforeEach, describe, expect, it, vi } from "vitest";

import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import {
  razaoDaMudancaPeloAgente,
  resolveDestinoDoAgente,
  sincronizaEstagioDoAgente,
  type EstagioCandidato,
} from "@/lib/leads/agent-stage-sync";

vi.mock("@/lib/leads/activity-emitter", async (orig) => ({
  ...(await orig<typeof import("@/lib/leads/activity-emitter")>()),
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
}));

/**
 * O cenário 26 vive aqui: o MESMO passo do agente cai em estágios de nomes
 * completamente diferentes conforme o nicho, e o resolvedor não pode saber nada
 * sobre "Avaliação" ou "Aguardando pagamento" — só sobre o hint.
 */
const clinica: EstagioCandidato[] = [
  { id: "c1", name: "Primeiro contato", agent_stage_hint: "contacted", is_archived: false },
  { id: "c2", name: "Avaliação", agent_stage_hint: "qualifying", is_archived: false },
  { id: "c3", name: "Proposta enviada", agent_stage_hint: "negotiating", is_archived: false },
  { id: "c4", name: "Tratamento fechado", agent_stage_hint: "won", is_archived: false },
];
const ecommerce: EstagioCandidato[] = [
  { id: "e1", name: "Carrinho abandonado", agent_stage_hint: null, is_archived: false },
  { id: "e2", name: "Aguardando pagamento", agent_stage_hint: "negotiating", is_archived: false },
  { id: "e3", name: "Pago", agent_stage_hint: "won", is_archived: false },
  { id: "e4", name: "Em separação", agent_stage_hint: null, is_archived: false },
];

describe("resolveDestinoDoAgente", () => {
  it("cenário 26: o mesmo passo cai em nomes diferentes por nicho", () => {
    const naClinica = resolveDestinoDoAgente(clinica, "negotiating", "c1");
    const noEcommerce = resolveDestinoDoAgente(ecommerce, "negotiating", "e1");
    expect(naClinica).toEqual({ move: true, stageId: "c3", stageName: "Proposta enviada" });
    expect(noEcommerce).toEqual({ move: true, stageId: "e2", stageName: "Aguardando pagamento" });
  });

  it("sem mapeamento: NÃO move, e não inventa o mais próximo", () => {
    // O e-commerce não declarou nada para "qualifying". Mover para "Carrinho
    // abandonado" ou "Em separação" por proximidade poria o negócio num lugar
    // que ninguém escolheu — e o usuário veria um card se mexendo sozinho.
    expect(resolveDestinoDoAgente(ecommerce, "qualifying", "e1")).toEqual({
      move: false,
      motivo: "sem_mapeamento",
      passo: "qualifying",
    });
  });

  it("já está lá: não é falha, é ausência de trabalho", () => {
    // Distinguir de `sem_mapeamento` importa: um vira rastro de configuração
    // faltando, o outro é o caso normal de o agente reafirmar onde já está.
    expect(resolveDestinoDoAgente(clinica, "qualifying", "c2")).toEqual({
      move: false,
      motivo: "ja_esta_la",
      passo: "qualifying",
    });
  });

  it("estágio ARQUIVADO não é destino", () => {
    // Mandar um negócio vivo para um estágio arquivado o esconderia do board —
    // desaparecer é pior que não se mover.
    const comArquivado: EstagioCandidato[] = [
      { id: "x1", name: "Ativo", agent_stage_hint: null, is_archived: false },
      { id: "x2", name: "Antigo", agent_stage_hint: "qualifying", is_archived: true },
    ];
    expect(resolveDestinoDoAgente(comArquivado, "qualifying", "x1")).toEqual({
      move: false,
      motivo: "sem_mapeamento",
      passo: "qualifying",
    });
  });

  it("pipeline SEM hint nenhum nunca move — e isso é o estado de todo clone novo", () => {
    const semHints: EstagioCandidato[] = ecommerce.map((e) => ({ ...e, agent_stage_hint: null }));
    for (const passo of ["new", "contacted", "qualifying", "qualified", "negotiating", "won", "lost"]) {
      expect(resolveDestinoDoAgente(semHints, passo, "e1").move).toBe(false);
    }
  });

  it("a razão nomeia OS DOIS lados da tradução", () => {
    // Quem lê a timeline conhece só o nome do tenant; quem depura conhece só o
    // passo do agente. Um sem o outro deixa metade das pessoas sem contexto.
    const r = razaoDaMudancaPeloAgente("Avaliação", "qualifying");
    expect(r).toContain("Avaliação");
    expect(r).toContain("qualifying");
    expect(r).toContain("assistente");
  });
});

/* ────────────────────────────────────────────────────────────────────────── */

/**
 * `sincronizaEstagioDoAgente` contra um supabase-js falso — os dois defeitos que
 * só viraram comportamento de produção quando a ponte da Fase 4 acordou este
 * código (até então ele não tinha chamador nenhum):
 *
 *  1. o supabase-js NÃO LANÇA em falha de rede (devolve `{data:null, error}`), e
 *     o erro dos SELECTs era descartado — banco fora virava "sem_negocio";
 *  2. o UPDATE sem `.select()` não observa "0 linhas afetadas", então a trava
 *     otimista barrar (humano arrastou o card) era reportado como movimento
 *     feito, com atividade `stage_changed` de algo que não aconteceu.
 */
type Resposta = { data: unknown; error: { message: string } | null };
interface Cenario {
  leads: Resposta;
  stages: Resposta;
  update: Resposta;
}

const ORG = "org-1";
const CONTATO = "contato-1";
const LEAD = { id: "lead-1", organization_id: ORG, pipeline_id: "pipe-1", stage_id: "s1", status: "open", created_at: "2026-01-01T00:00:00Z", last_activity_at: null };
const STAGES = [
  { id: "s1", name: "Primeiro contato", agent_stage_hint: "contacted", is_archived: false },
  { id: "s2", name: "Proposta enviada", agent_stage_hint: "negotiating", is_archived: false },
];

function cenario(over: Partial<Cenario> = {}): Cenario {
  return {
    leads: { data: [LEAD], error: null },
    stages: { data: STAGES, error: null },
    update: { data: [{ id: LEAD.id }], error: null },
    ...over,
  };
}

/**
 * Fake do query builder: thenable, e distingue SELECT de UPDATE pela chamada.
 *
 * ⚠️ UPDATE **sem** `.select()` devolve `data: null`, como o supabase-js real —
 * é o que faz este fake exigir o `.select("id")` do código de produção. Sem essa
 * regra, remover só o `.select("id")` (mantendo o check de comprimento) passaria
 * verde aqui e, no banco de verdade, faria TODO movimento virar `conflito_humano`:
 * o card nunca mais andaria e o painel mostraria conflito onde não há.
 */
function fakeAdmin(c: Cenario) {
  return {
    from(tabela: string) {
      const b = {
        _update: false,
        _select: false,
        select: () => {
          b._select = true;
          return b;
        },
        update: () => {
          b._update = true;
          return b;
        },
        eq: () => b,
        maybeSingle: () => Promise.resolve({ data: { name: "Primeiro contato" }, error: null }),
        then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
          const r = b._update
            ? b._select
              ? c.update
              : { ...c.update, data: null } // UPDATE sem .select() não devolve linha nenhuma
            : tabela === "crm_leads"
              ? c.leads
              : c.stages;
          return Promise.resolve(r).then(onF, onR);
        },
      };
      return b;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const sincroniza = (c: Cenario) =>
  sincronizaEstagioDoAgente(fakeAdmin(c), { organizationId: ORG, contactId: CONTATO, passo: "negotiating" });

describe("sincronizaEstagioDoAgente", () => {
  beforeEach(() => vi.mocked(emitLeadActivity).mockClear());

  it("caminho feliz: move e emite UMA atividade", async () => {
    const r = await sincroniza(cenario());
    expect(r).toMatchObject({ moveu: true, motivo: "movido", stageName: "Proposta enviada" });
    expect(vi.mocked(emitLeadActivity)).toHaveBeenCalledTimes(1);
  });

  it("SELECT de leads com erro é INDISPONIBILIDADE, não 'sem_negocio'", async () => {
    const r = await sincroniza(cenario({ leads: { data: null, error: { message: "TypeError: fetch failed" } } }));
    expect(r.motivo).toBe("indisponivel");
    expect(r.detalhe).toContain("fetch failed");
    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });

  it("SELECT de stages com erro é INDISPONIBILIDADE, não 'sem_mapeamento'", async () => {
    const r = await sincroniza(cenario({ stages: { data: null, error: { message: "connection refused" } } }));
    expect(r.motivo).toBe("indisponivel");
  });

  it("UPDATE com erro é falha de escrita — jamais 'ja_esta_la' (que a ponte lê como sucesso)", async () => {
    const r = await sincroniza(cenario({ update: { data: null, error: { message: "deadlock detected" } } }));
    expect(r).toMatchObject({ moveu: false, motivo: "falha_de_escrita" });
    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });

  it("trava otimista atuou (0 linhas): não moveu, e NÃO fabrica atividade na timeline", async () => {
    const r = await sincroniza(cenario({ update: { data: [], error: null } }));
    expect(r).toMatchObject({ moveu: false, motivo: "conflito_humano" });
    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });
});
