import { describe, expect, it } from "vitest";
import { kindLabel, KIND_LABEL, SEVERITY_LABEL } from "./agent-inbox-copy";

describe("agent-inbox-copy — rótulos leigos dos avisos do runtime", () => {
  it("traduz kinds conhecidos do schema (agent_inbox_items.kind)", () => {
    expect(kindLabel("qr_rescan")).toContain("QR");
    expect(kindLabel("budget_exceeded")).toContain("orçamento");
    expect(kindLabel("handoff")).toContain("humano");
  });

  it("kind desconhecido cai no rótulo genérico sem quebrar", () => {
    expect(kindLabel("kind_novo_do_engine")).toBe("Aviso do assistente");
  });

  /**
   * A versão anterior deste teste se chamava "cobre todos os kinds do check
   * constraint" e comparava contra uma **cópia congelada** do CHECK da 0050.
   * Três migrations depois (`followup_dead`, `snooze_expired`,
   * `next_action_ambiguous`) a lista nunca cresceu: o teste continuou verde
   * afirmando cobrir uma fonte da verdade que já não lia. Um teste que copia
   * aquilo que deveria conferir só verifica a si mesmo.
   *
   * A cobertura agora é mecânica e mora em dois lugares que NÃO envelhecem:
   *   compilador → `satisfies Record<InboxKind, string>` em agent-inbox-copy.ts
   *                (kind no tipo sem rótulo = erro de build)
   *   Postgres   → tests/invariants/vocabulario-banco-x-typescript.test.ts
   *                (CHECK do banco × InboxKind, contra banco real)
   * Aqui fica só o que nenhum dos dois vê: se o rótulo é texto útil.
   */
  it("todo rótulo é frase em pt-BR, não o identificador cru", () => {
    const chaves = Object.keys(KIND_LABEL);
    expect(chaves.length).toBeGreaterThan(0);
    for (const k of chaves) {
      const rotulo = KIND_LABEL[k as keyof typeof KIND_LABEL];
      expect(rotulo, `sem rótulo para kind '${k}'`).toBeTruthy();
      expect(rotulo, `rótulo de '${k}' é o próprio identificador`).not.toBe(k);
      expect(rotulo, `rótulo de '${k}' vazou snake_case`).not.toMatch(/[a-z]+_[a-z]+/);
    }
  });

  it("o item ambíguo se anuncia pelo que pede, não pelo genérico", () => {
    // Regressão direta: este kind nasceu na 0073 e chegou à tela caindo no
    // "Aviso do assistente" — genérico num item cuja razão de existir é pedir
    // uma escolha. O teste falha se alguém remover o rótulo.
    expect(kindLabel("next_action_ambiguous")).not.toBe("Aviso do assistente");
    expect(kindLabel("next_action_ambiguous")).toContain("escolha");
  });

  it("severidades têm rótulo leigo", () => {
    expect(SEVERITY_LABEL.info).toBe("informativo");
    expect(SEVERITY_LABEL.warn).toBe("atenção");
    expect(SEVERITY_LABEL.critical).toBe("crítico");
  });
});
