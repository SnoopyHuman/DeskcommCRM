/**
 * O que este teste protege: **sem `AI_GATEWAY_API_KEY`, o embedding não pode
 * passar pelo gateway.**
 *
 * O arquivo prometia esse caminho no cabeçalho desde que nasceu ("otherwise uses
 * the OpenAI provider directly") e não o tinha: passava a string
 * `openai/text-embedding-3-small` direto para `embed()`, e no AI SDK um id com
 * barra é resolvido pelo **gateway da Vercel mesmo sem chave** — entrando no
 * plano anônimo. O teto desse plano devolve `GatewayRateLimitError`, o `catch`
 * do `searchKnowledge` engole, e a busca na base de conhecimento volta vazia sem
 * gravar nada. Foi exatamente o que aconteceu na prova da Fase 4.
 *
 * A asserção é sobre o TIPO do que chega em `embed({model})`: string significa
 * "deixa o gateway resolver"; objeto significa "provider explícito". É a única
 * diferença observável sem rede.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const embedSpy = vi.fn();
vi.mock("ai", () => ({
  embed: (args: unknown) => embedSpy(args),
}));

vi.mock("@/lib/ai/gateway", async () => {
  const real = await vi.importActual<typeof import("@/lib/ai/gateway")>("@/lib/ai/gateway");
  return {
    ...real,
    gatewayConfig: () => gatewayConfigMock(),
    // Mockado porque a resposta REAL depende de haver chave no ambiente, e este
    // teste mede qual OBJETO DE MODELO chega em `embed()` — não a configuração.
    // Sem isto o arquivo só passa em máquina com `.env.local` preenchido: no CI
    // `embedText` aborta em `embed_unavailable` antes de chegar no que se mede,
    // e o teste vira refém de credencial que ele não usa.
    isEmbeddingProviderConfigured: () => true,
  };
});

let gatewayConfigMock: () => { apiKey: string; baseURL?: string } | null;

import { embedText } from "@/lib/ai/embed";

beforeEach(() => {
  embedSpy.mockReset();
  embedSpy.mockResolvedValue({ embedding: [0.1, 0.2], usage: { tokens: 7 } });
  gatewayConfigMock = () => null;
});

describe("embedText", () => {
  it("SEM gateway, usa o provider OpenAI explícito — nunca a string com barra", async () => {
    await embedText("oi", { organizationId: "org-1" });

    const arg = embedSpy.mock.calls[0]?.[0] as { model: unknown; headers?: unknown };
    // String aqui = o gateway resolve = plano anônimo = teto. É o defeito.
    expect(
      typeof arg.model,
      "modelo chegou como string: o gateway vai resolver e cair no plano anônimo",
    ).not.toBe("string");
    expect(arg.model).toBeTypeOf("object");
    // Sem gateway não há tenant para observar: headers não fazem sentido.
    expect(arg.headers).toBeUndefined();
  });

  it("COM gateway, mantém a string (é ele quem roteia) e anexa os headers do tenant", async () => {
    gatewayConfigMock = () => ({ apiKey: "gw-key" });

    await embedText("oi", { organizationId: "org-1" });

    const arg = embedSpy.mock.calls[0]?.[0] as { model: unknown; headers?: Record<string, string> };
    expect(arg.model).toBe("openai/text-embedding-3-small");
    expect(arg.headers?.["X-AI-Gateway-Tenant-Id"]).toBe("org-1");
  });

  it("devolve a contagem de tokens que o SDK reporta", async () => {
    const r = await embedText("oi", { organizationId: "org-1" });
    expect(r.embedding).toEqual([0.1, 0.2]);
    expect(r.promptTokens).toBe(7);
  });
});
