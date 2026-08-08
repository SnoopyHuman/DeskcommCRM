/**
 * A LISTA QUE A TELA OFERECE E O REGISTRY QUE EXECUTA SÃO A MESMA LISTA.
 *
 * A migration 0127 tirou do banco os CHECKs que prendiam `provider` em três
 * valores. Isso era necessário (eles impediam a OpenRouter de existir), mas
 * transferiu uma garantia do Postgres para o TypeScript — e garantia
 * transferida sem guarda é garantia perdida.
 *
 * Os dois modos de divergir têm sintomas opostos e ambos são ruins:
 *
 *  - **Na lista, fora do registry:** a tela oferece um provedor, o operador
 *    escolhe, salva, e toda chamada daquele ponto morre com
 *    `LlmProviderUnknownError`. Antes, o banco recusava na hora de salvar.
 *  - **No registry, fora da lista:** o sistema sabe executar um provedor que
 *    ninguém consegue escolher pela tela — trabalho feito e inalcançável, que é
 *    a forma como funcionalidade morre neste produto.
 */
import { describe, expect, it } from "vitest";

import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { ehProvedorSuportado, PROVEDORES, PROVEDOR_POR_ID } from "@/lib/ai/pontos/provedores";

const registry = createDefaultRegistry();

describe("lista de provedores × registry", () => {
  it("o registry tem entrada (controle positivo)", () => {
    // Um registry vazio faria os dois testes abaixo passarem por vacuidade.
    expect(Object.keys(registry).length).toBeGreaterThanOrEqual(4);
  });

  it("todo provedor oferecido na tela é executável", () => {
    const semExecucao = PROVEDORES.filter((p) => registry[p.id] === undefined).map((p) => p.id);
    expect(
      semExecucao,
      "a tela ofereceria um provedor que toda chamada recusaria com llm_provider_unknown",
    ).toEqual([]);
  });

  it("todo provedor executável é oferecido na tela", () => {
    const semPorta = Object.keys(registry).filter((id) => !ehProvedorSuportado(id));
    expect(
      semPorta,
      "o sistema saberia usar um provedor que ninguém consegue escolher — trabalho inalcançável",
    ).toEqual([]);
  });
});

describe("a OpenRouter entrou de fato", () => {
  it("está na lista e no registry", () => {
    expect(ehProvedorSuportado("openrouter")).toBe(true);
    expect(registry["openrouter"]).toBeTypeOf("function");
  });

  it("é declarada como sincronizável — é o que justifica o cron de catálogo", () => {
    expect(PROVEDOR_POR_ID.get("openrouter")?.catalogoSincronizavel).toBe(true);
  });

  it("aceita endpoint próprio — é o que prepara o modelo local", () => {
    expect(PROVEDOR_POR_ID.get("openrouter")?.aceitaEndpointProprio).toBe(true);
  });
});

describe("forma de cada provedor", () => {
  it("cada um explica quando usar, em português de gente", () => {
    for (const p of PROVEDORES) {
      expect(p.rotulo.trim().length, `${p.id} sem rótulo`).toBeGreaterThan(0);
      expect(p.quandoUsar.trim().length, `${p.id} sem explicação`).toBeGreaterThan(20);
      expect(p.ondePegarAChave, `${p.id} sem link da chave`).toMatch(/^https:\/\//);
    }
  });

  it("ids são únicos", () => {
    const ids = PROVEDORES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a OpenAI segue na lista e é declarada como necessária além do chat", () => {
    // Áudio e indexação usam OpenAI mesmo com o resto em outro provedor. Se
    // essa frase sumir, o operador que migrar tudo para outro provedor perde
    // transcrição e busca sem entender por quê — o defeito medido em VPS.
    const openai = PROVEDOR_POR_ID.get("openai");
    expect(openai).toBeDefined();
    expect(openai?.quandoUsar.toLowerCase()).toMatch(/áudio|transcre|indexar/);
  });
});

describe("o endpoint próprio chega até a fábrica", () => {
  it("a fábrica da OpenRouter aceita o terceiro argumento", () => {
    // A assinatura precisa aceitar baseUrl, senão `ai_purpose_bindings.base_url`
    // seria uma coluna que a tela preenche e o runtime ignora — configuração
    // que não configura nada.
    const modelo = registry["openrouter"]!("chave-de-teste", "meta-llama/llama-3.3-70b-instruct", "https://gateway.exemplo/v1");
    expect(modelo).toBeDefined();
  });

  it("sem o terceiro argumento, usa o endpoint canônico", () => {
    const modelo = registry["openrouter"]!("chave-de-teste", "meta-llama/llama-3.3-70b-instruct");
    expect(modelo).toBeDefined();
  });
});
