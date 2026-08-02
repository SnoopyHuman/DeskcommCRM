import { describe, expect, it } from "vitest";

import { motivoDoCorte } from "@/lib/inbox/context-cutoff-label";

describe("motivoDoCorte", () => {
  it("stage_policy e ausência viram 'fim de ciclo'", () => {
    expect(motivoDoCorte("stage_policy")).toBe("fim de ciclo");
    expect(motivoDoCorte(null)).toBe("fim de ciclo");
    expect(motivoDoCorte(undefined)).toBe("fim de ciclo");
  });

  it("manual sem nome", () => {
    expect(motivoDoCorte("manual")).toBe("reset manual");
  });

  it("manual com nome", () => {
    expect(motivoDoCorte("manual:Renan Brandão")).toBe("reset manual por Renan Brandão");
  });
});
