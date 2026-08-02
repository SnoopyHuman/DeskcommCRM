import { describe, expect, it } from "vitest";

import { resolveSessionGapHours } from "./context-lifecycle";

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
