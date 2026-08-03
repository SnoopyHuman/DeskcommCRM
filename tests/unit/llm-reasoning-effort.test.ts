import { describe, expect, it } from "vitest";

import { esforcoParaChamada } from "@/lib/agent-engine/edge/llm/reasoning-effort";

describe("esforcoParaChamada", () => {
  it("usa 'minimal' nos classificadores do caminho crítico", () => {
    for (const purpose of ["stage_classifier", "jailbreak_detect", "promise_semantic"]) {
      expect(esforcoParaChamada("openai", "gpt-5-mini", purpose)).toBe("minimal");
    }
  });

  it("usa 'low' no turno do agente (gera texto, não é classificação pura)", () => {
    expect(esforcoParaChamada("openai", "gpt-5-mini", "agent_turn")).toBe("low");
  });

  it("não opina em propósito fora do mapa — mantém o default do provider", () => {
    expect(esforcoParaChamada("openai", "gpt-5-mini", "checkpoint")).toBeUndefined();
    expect(esforcoParaChamada("openai", "gpt-5-mini", undefined)).toBeUndefined();
  });

  it("não manda reasoning_effort para modelo SEM raciocínio (seria 400 da API)", () => {
    expect(esforcoParaChamada("openai", "gpt-4o", "agent_turn")).toBeUndefined();
    expect(esforcoParaChamada("openai", "gpt-4o-mini", "stage_classifier")).toBeUndefined();
  });

  it("não vaza knob da OpenAI para outros providers", () => {
    expect(esforcoParaChamada("anthropic", "claude-sonnet-4-6", "agent_turn")).toBeUndefined();
    expect(esforcoParaChamada("google", "gemini-2.5-pro", "stage_classifier")).toBeUndefined();
  });

  it("reconhece as famílias de raciocínio da OpenAI", () => {
    expect(esforcoParaChamada("openai", "gpt-5", "agent_turn")).toBe("low");
    expect(esforcoParaChamada("openai", "o3-mini", "agent_turn")).toBe("low");
    // Case-insensitive e tolerante a provider capitalizado.
    expect(esforcoParaChamada("OpenAI", "GPT-5-MINI", "agent_turn")).toBe("low");
  });
});
