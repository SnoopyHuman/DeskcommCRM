import { describe, expect, it } from "vitest";

import { hardResetContextSchema, resolveSessionGapHours } from "./context-lifecycle";

describe("resolveSessionGapHours", () => {
  it("chave ausente resolve para o default 6", () => {
    expect(resolveSessionGapHours(undefined)).toBe(6);
    expect(resolveSessionGapHours({})).toBe(6);
    expect(resolveSessionGapHours({ context_lifecycle: {} })).toBe(6);
  });

  it("valor explícito é respeitado", () => {
    expect(resolveSessionGapHours({ context_lifecycle: { session_gap_hours: 12 } })).toBe(12);
  });

  it("null explícito desliga a fronteira (não cai no default)", () => {
    expect(resolveSessionGapHours({ context_lifecycle: { session_gap_hours: null } })).toBeNull();
  });

  it("valor inválido cai no default 6 sem lançar", () => {
    expect(() =>
      resolveSessionGapHours({ context_lifecycle: { session_gap_hours: "abc" } }),
    ).not.toThrow();
    expect(resolveSessionGapHours({ context_lifecycle: { session_gap_hours: "abc" } })).toBe(6);
    expect(resolveSessionGapHours({ context_lifecycle: { session_gap_hours: -3 } })).toBe(6);
    expect(resolveSessionGapHours({ context_lifecycle: { session_gap_hours: 0 } })).toBe(6);
  });

  it("settings totalmente estranho (não-objeto) não lança", () => {
    expect(() => resolveSessionGapHours("nao-e-objeto")).not.toThrow();
    expect(resolveSessionGapHours("nao-e-objeto")).toBe(6);
    expect(resolveSessionGapHours(null)).toBe(6);
  });
});

describe("hardResetContextSchema", () => {
  it("aceita confirmation literal APAGAR com defaults", () => {
    const r = hardResetContextSchema.safeParse({ confirmation: "APAGAR" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.purge_knowledge_base).toBe(false);
      expect(r.data.reason).toBeUndefined();
    }
  });

  it("rejeita confirmation diferente de APAGAR", () => {
    expect(hardResetContextSchema.safeParse({ confirmation: "apagar" }).success).toBe(false);
    expect(hardResetContextSchema.safeParse({ confirmation: "DELETAR" }).success).toBe(false);
    expect(hardResetContextSchema.safeParse({}).success).toBe(false);
  });

  it("aceita purge_knowledge_base e reason opcionais", () => {
    const r = hardResetContextSchema.safeParse({
      confirmation: "APAGAR",
      purge_knowledge_base: true,
      reason: "dado de teste",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.purge_knowledge_base).toBe(true);
      expect(r.data.reason).toBe("dado de teste");
    }
  });
});
