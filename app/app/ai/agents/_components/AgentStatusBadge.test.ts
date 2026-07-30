import { describe, it, expect } from "vitest";

import { deriveAgentStatus } from "./AgentStatusBadge";
import type { AgentRow } from "@/hooks/ai/useAgent";

const base = {
  id: "a", organization_id: "o", name: "Atendente IA", description: null,
  model: "anthropic/claude-sonnet-4-6", system_prompt: "oi", is_active: true,
  is_default: true, kind: "rag_bot", priority: 0, published_version_id: null,
  archived_at: null, config: {}, guardrails: {}, active_kb_version_id: null,
  created_at: "", updated_at: "",
} as unknown as AgentRow;

describe("deriveAgentStatus", () => {
  it("sem versão publicada é RASCUNHO, mesmo ativo", () => {
    // O defeito de origem: o agente criado no onboarding (rag_bot, ativo, sem
    // versão) aparecia como "Publicado" enquanto os dois runtimes o ignoram —
    // ambos resolvem o agente por join com ai_agent_versions.
    expect(deriveAgentStatus({ ...base, is_active: true, published_version_id: null })).toBe("draft");
    expect(deriveAgentStatus({ ...base, kind: "mcp_agent", published_version_id: null } as AgentRow)).toBe("draft");
  });

  it("com versão publicada e ativo é PUBLICADO", () => {
    expect(deriveAgentStatus({ ...base, published_version_id: "v1" } as AgentRow)).toBe("published");
  });

  it("com versão publicada e inativo é PAUSADO", () => {
    expect(deriveAgentStatus({ ...base, published_version_id: "v1", is_active: false } as AgentRow)).toBe("paused");
  });

  it("arquivado vence tudo", () => {
    expect(deriveAgentStatus({ ...base, archived_at: "2026-01-01", published_version_id: "v1" } as AgentRow)).toBe("archived");
  });
});
