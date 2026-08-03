/**
 * Esforço de raciocínio por PROPÓSITO da chamada (famílias gpt-5/o-series da
 * OpenAI). Existe porque o default do provider é `medium`, e medido nesta VPS
 * isso custava caro no caminho crítico da resposta ao cliente: o
 * `jailbreak_detect` — que devolve um JSON de classificação de duas chaves —
 * gastava 276 tokens de saída e 6,8s, quase todo em raciocínio invisível.
 *
 * A regra é simples e conservadora:
 *  - classificação pura (saída minúscula, decisão binária/enum) → `minimal`;
 *  - geração no caminho crítico (o turno que o cliente espera) → `low`;
 *  - todo o resto → `undefined`, ou seja, NÃO mexemos (mantém o default do
 *    provider). Silêncio é a resposta segura para propósito desconhecido.
 *
 * Só se aplica a modelo de RACIOCÍNIO da OpenAI: mandar `reasoning_effort` para
 * um gpt-4o é erro 400 da API, então o gate de família é obrigatório, não
 * cosmético.
 */
export type EsforcoRaciocinio = 'minimal' | 'low' | 'medium' | 'high';

const POR_PROPOSITO: Record<string, EsforcoRaciocinio> = {
  // Classificadores: entrada curta, saída enum/JSON pequeno, zero necessidade
  // de cadeia de raciocínio. Os três primeiros estão no caminho crítico.
  stage_classifier: 'minimal',
  jailbreak_detect: 'minimal',
  promise_semantic: 'minimal',
  intent_router: 'minimal',
  followup_classify: 'minimal',
  // O turno em si: gera texto e usa tools, então não vai a `minimal` — mas
  // `low` já corta a maior parte da latência sem achatar a qualidade.
  agent_turn: 'low',
};

/** Famílias OpenAI que ACEITAM reasoning_effort. Deny by default. */
function ehModeloDeRaciocinio(modelId: string): boolean {
  const id = (modelId ?? '').toLowerCase();
  return /^(gpt-5|o1|o3|o4)/.test(id);
}

/**
 * Devolve o esforço a aplicar, ou `undefined` quando não devemos opinar
 * (provider não-OpenAI, modelo sem raciocínio, ou propósito não mapeado).
 */
export function esforcoParaChamada(
  provider: string,
  modelId: string,
  purpose: string | undefined,
): EsforcoRaciocinio | undefined {
  if ((provider ?? '').toLowerCase() !== 'openai') return undefined;
  if (!ehModeloDeRaciocinio(modelId)) return undefined;
  if (purpose === undefined) return undefined;
  return POR_PROPOSITO[purpose];
}
