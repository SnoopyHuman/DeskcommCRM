import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "@/lib/agent-engine/obs/logger";
import { scanStaleEvents } from "@/lib/agent-engine/obs/stale-events";

afterEach(() => {
  vi.unstubAllEnvs();
});

function fakePool(rows: unknown[], insertRowCount = 1) {
  return {
    query: vi
      .fn()
      .mockResolvedValueOnce({ rows })
      .mockResolvedValue({ rowCount: insertRowCount, rows: [] }),
  } as never;
}

describe("scanStaleEvents", () => {
  it("abre inbox para cada evento stale e conta alarmed", async () => {
    const pool = fakePool([
      {
        id: "e1",
        organization_id: "o1",
        event_type: "ai_agent.dispatch_requested",
        created_at: new Date(Date.now() - 180_000).toISOString(),
        attempts: 2,
      },
    ]);
    const result = await scanStaleEvents(pool, createLogger(), { staleMs: 60_000 });
    expect(result.scanned).toBe(1);
    expect(result.alarmed).toBe(1);
    expect(result.skipped_dedup).toBe(0);
  });

  it("dedup: insert 0 rows → skipped_dedup", async () => {
    const pool = fakePool(
      [
        {
          id: "e2",
          organization_id: "o1",
          event_type: "media.derive_requested",
          created_at: new Date(Date.now() - 200_000).toISOString(),
          attempts: 0,
        },
      ],
      0,
    );
    const result = await scanStaleEvents(pool, createLogger(), { staleMs: 60_000 });
    expect(result.alarmed).toBe(0);
    expect(result.skipped_dedup).toBe(1);
  });
});
