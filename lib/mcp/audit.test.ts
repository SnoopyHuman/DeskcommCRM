import { describe, it, expect, vi, beforeEach } from "vitest";

const auditSpy = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (e: unknown) => auditSpy(e) }));

import { auditMcpToolCall } from "./audit";
import type { McpContext } from "./types";

const ctx = {
  organizationId: "bcc12320-f555-4fef-8d90-38a0ac5950e0",
  apiTokenId: "d7ba0e68-0000-4000-8000-000000000001",
  requestId: "req-1",
  // Um token comum vira actor.type='user' com id = id do TOKEN (lib/mcp/auth.ts).
  actor: { type: "user", id: "d7ba0e68-0000-4000-8000-000000000001", role: "manager" },
} as unknown as McpContext;

describe("auditMcpToolCall", () => {
  beforeEach(() => auditSpy.mockClear());

  it("não manda o nome da tool em resource_id (coluna uuid no banco)", async () => {
    // Defeito de origem: resourceId recebia "crm_create_lead" e todo insert
    // morria com «invalid input syntax for type uuid», em silêncio — nenhuma
    // chamada MCP era auditada.
    await auditMcpToolCall({
      ctx, toolName: "crm_create_lead", args: {}, durationMs: 12, success: true,
    });
    const e = auditSpy.mock.calls[0]![0];
    expect(e.resourceId).toBeNull();
    expect(e.resourceType).toBe("mcp_tool");
    expect(e.metadata.tool_name).toBe("crm_create_lead");
  });

  it("não manda id de token em actorUserId (FK para auth.users)", async () => {
    await auditMcpToolCall({
      ctx, toolName: "crm_list_leads", args: {}, durationMs: 5, success: true,
    });
    const e = auditSpy.mock.calls[0]![0];
    expect(e.actorUserId).toBeNull();
    expect(e.actorApiTokenId).toBe(ctx.apiTokenId);
  });

  it("redige segredos nos argumentos", async () => {
    await auditMcpToolCall({
      ctx, toolName: "crm_get_contact", args: { cpf: "12345678900", query: "joana" },
      durationMs: 3, success: true,
    });
    const e = auditSpy.mock.calls[0]![0];
    expect(e.metadata.args.cpf).toBe("[redacted]");
    expect(e.metadata.args.query).toBe("joana");
  });
});
