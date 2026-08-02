import { describe, expect, it } from "vitest";
import { indexDoDivisorDeCorte, mergeThreadItems } from "@/components/inbox/ChatThread";

describe("mergeThreadItems", () => {
  it("intercala mensagens e notas por tempo", () => {
    const msgs = [
      { id: "m1", sent_at: "2026-07-23T10:00:00Z" },
      { id: "m2", sent_at: "2026-07-23T10:02:00Z" },
    ] as never;
    const notes = [{ id: "n1", created_at: "2026-07-23T10:01:00Z" }] as never;
    const out = mergeThreadItems(msgs, notes);
    expect(out.map((i) => i.data.id)).toEqual(["m1", "n1", "m2"]);
    expect(out[1]!.kind).toBe("note");
  });

  it("sem notas → só mensagens", () => {
    const msgs = [{ id: "m1", sent_at: "2026-07-23T10:00:00Z" }] as never;
    expect(mergeThreadItems(msgs, []).every((i) => i.kind === "message")).toBe(true);
  });

  it("empate de timestamp mantém ordem estável (mensagem antes da nota)", () => {
    const msgs = [{ id: "m1", sent_at: "2026-07-23T10:00:00Z" }] as never;
    const notes = [{ id: "n1", created_at: "2026-07-23T10:00:00Z" }] as never;
    const out = mergeThreadItems(msgs, notes);
    expect(out.map((i) => i.data.id)).toEqual(["m1", "n1"]);
  });

  it("array vazio de ambos retorna vazio", () => {
    expect(mergeThreadItems([], [])).toEqual([]);
  });
});

describe("indexDoDivisorDeCorte", () => {
  const items = [
    { kind: "message" as const, ts: "2026-08-01T10:00:00Z", data: { id: "m1" } },
    { kind: "message" as const, ts: "2026-08-01T12:00:00Z", data: { id: "m2" } },
    { kind: "message" as const, ts: "2026-08-02T09:00:00Z", data: { id: "m3" } },
  ] as never;

  it("sem corte → -1", () => {
    expect(indexDoDivisorDeCorte(items, null)).toBe(-1);
    expect(indexDoDivisorDeCorte(items, undefined)).toBe(-1);
  });

  it("corte no meio → após o último item pré-corte", () => {
    expect(indexDoDivisorDeCorte(items, "2026-08-01T13:00:00Z")).toBe(2);
  });

  it("corte antes de tudo → índice 0", () => {
    expect(indexDoDivisorDeCorte(items, "2026-07-31T00:00:00Z")).toBe(0);
  });

  it("corte depois de tudo → após o último", () => {
    expect(indexDoDivisorDeCorte(items, "2026-08-03T00:00:00Z")).toBe(3);
  });
});
