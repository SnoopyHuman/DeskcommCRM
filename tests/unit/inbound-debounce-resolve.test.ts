import { describe, expect, it } from "vitest";

import { resolveInboundDebounce } from "@/lib/agent-engine/inbound-debounce/resolve";

describe("resolveInboundDebounce", () => {
  it("sem config da org → usa o default de env", () => {
    const r = resolveInboundDebounce(null, 5_000);
    expect(r.debounceMs).toBe(5_000);
    expect(r.maxWindowMs).toBe(15_000);
  });

  it("enabled=false → debounce 0", () => {
    const r = resolveInboundDebounce({ enabled: false, window_ms: 8_000 }, 5_000);
    expect(r.debounceMs).toBe(0);
    expect(r.maxWindowMs).toBe(0);
  });

  it("usa window_ms da org", () => {
    const r = resolveInboundDebounce({ enabled: true, window_ms: 8_000 }, 5_000);
    expect(r.debounceMs).toBe(8_000);
    expect(r.maxWindowMs).toBe(24_000);
  });

  it("respeita max_window_ms explícito", () => {
    const r = resolveInboundDebounce(
      { enabled: true, window_ms: 5_000, max_window_ms: 12_000 },
      5_000,
    );
    expect(r.maxWindowMs).toBe(12_000);
  });

  it("env 0 (sem debounce global) sem config → 0", () => {
    expect(resolveInboundDebounce(undefined, 0).debounceMs).toBe(0);
  });
});
