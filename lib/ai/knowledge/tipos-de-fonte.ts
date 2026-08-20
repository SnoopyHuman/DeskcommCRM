/**
 * Vocabulário de `ai_knowledge_sources.source_type` e a única resposta à
 * pergunta "este tipo aceita texto colado?".
 *
 * A regra estava em QUATRO lugares (o `Set` da rota, um
 * `if (source_type === "faq" || === "policy")` 125 linhas abaixo NO MESMO
 * arquivo, o `cadastroManual` do cartão e um `type` no diálogo) — duplicação
 * sem fonte da verdade, o anti-pattern nº 2 do CLAUDE.md. Divergirem é questão
 * de tempo, e o custo já foi pago uma vez: o diálogo mentia o tipo no envio
 * (issue #265).
 *
 * Módulo puro de propósito: o cartão é client component e importa daqui.
 */

/** Todos os valores que o CHECK do banco aceita na coluna. */
export const TIPOS_DE_FONTE = [
  "faq",
  "policy",
  "conversation",
  "conversations",
  "catalog",
  "nuvemshop_catalog",
] as const;

export type TipoDeFonte = (typeof TIPOS_DE_FONTE)[number];

/**
 * Tipos cujo conteúdo colado (`items` / `markdown_blob`) a API realmente
 * ingere. Os outros existem no banco mas são preenchidos por pipeline:
 * `conversations` nasce da ingestão anonimizada
 * (`lib/ai/rag/ingest/conversations.ts`, cron `kb-conversations-batch`) e
 * `catalog` vem da sincronização do e-commerce.
 */
export const TIPOS_QUE_INGEREM_TEXTO = ["faq", "policy"] as const;

export type TipoComTextoColado = (typeof TIPOS_QUE_INGEREM_TEXTO)[number];

const COM_TEXTO_COLADO: ReadonlySet<string> = new Set(TIPOS_QUE_INGEREM_TEXTO);

/**
 * Aceita `string` porque os dois chamadores falam vocabulários diferentes: a
 * rota passa o `source_type` do banco (6 valores) e o cartão passa o slot da
 * tela (4 valores canônicos). "faq"/"policy" significam o mesmo nos dois.
 */
export function ingereTextoColado(tipo: string): tipo is TipoComTextoColado {
  return COM_TEXTO_COLADO.has(tipo);
}

/** Nome do tipo em português, para mensagem de erro que alguém lê na tela. */
export const ROTULO_DO_TIPO: Record<TipoDeFonte, string> = {
  faq: "FAQ",
  policy: "política",
  conversation: "conversas",
  conversations: "conversas",
  catalog: "catálogo",
  nuvemshop_catalog: "catálogo",
};

/**
 * Mensagem do 409 `knowledge_source_type_in_use`, compartilhada pelas DUAS
 * rotas que inserem na tabela (POST e o upload de política) — a segunda ficou
 * de fora do conserto original e seguia devolvendo 500 mudo no 23505.
 *
 * **Ela não manda o leitor editar nem arquivar pela tela**, e essa é a
 * correção: a versão anterior dizia "Edite ou arquive a existente" e nenhuma
 * das duas ações existe na interface — "Editar conteúdo" é um
 * `toast.info("Editor de FAQ em breve.")` e não há controle de arquivar em
 * lugar nenhum. Instrução que não se pode seguir é pior que nenhuma.
 */
export function mensagemDeTipoJaEmUso(tipo: TipoDeFonte): string {
  return (
    `Este agente já tem uma fonte de ${ROTULO_DO_TIPO[tipo]} ativa — é uma de cada tipo por agente. ` +
    `Trocar o conteúdo pela tela ainda não é possível; hoje só arquivando a atual pela API ` +
    `(DELETE /api/v1/ai/knowledge/sources/:id).`
  );
}
