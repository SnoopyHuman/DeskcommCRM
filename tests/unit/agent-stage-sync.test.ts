import { describe, expect, it } from "vitest";

import {
  razaoDaMudancaPeloAgente,
  resolveDestinoDoAgente,
  type EstagioCandidato,
} from "@/lib/leads/agent-stage-sync";

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
