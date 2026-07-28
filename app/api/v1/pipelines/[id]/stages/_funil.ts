/**
 * Leitura compartilhada pelas rotas de etapas (criar, editar, arquivar).
 *
 * Existe como arquivo único porque as três rotas precisam do MESMO recorte: o
 * funil INTEIRO, arquivadas incluídas. As regras de `lib/leads/stage-editing.ts`
 * dependem disso — `uniq_crm_stages_pipeline_slug` não é parcial (arquivada
 * continua ocupando o slug), enquanto os índices de ganho/perda são. Cada rota
 * montando o próprio `select` divergiria no primeiro ajuste, e o sintoma seria
 * um 23505 cru na tela.
 */
import { fail } from "@/lib/api/wrappers";
import type { EtapaEditavel } from "@/lib/leads/stage-editing";
import type { createClient } from "@/lib/supabase/server";

type Supabase = Awaited<ReturnType<typeof createClient>>;

/** As colunas que a tela e as regras usam. `position` entra: a reordenação calcula em cima dela. */
const COLUNAS = "id, name, slug, position, is_won, is_lost, is_archived, agent_stage_hint";

/**
 * O funil como as regras precisam dele, ou `null` quando não é desta organização.
 *
 * `null` cobre os dois casos de propósito — funil inexistente e funil de outro
 * tenant respondem a MESMA coisa (404): dizer "existe, mas não é seu" já vaza a
 * existência.
 */
export async function lerFunil(
  supabase: Supabase,
  orgId: string,
  pipelineId: string,
): Promise<EtapaEditavel[] | null> {
  const { data: pipeline, error: pipeErr } = await supabase
    .from("crm_pipelines")
    .select("id")
    .eq("id", pipelineId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (pipeErr) throw new Error(pipeErr.message);
  if (!pipeline) return null;

  const { data, error } = await supabase
    .from("crm_stages")
    .select(COLUNAS)
    .eq("organization_id", orgId)
    .eq("pipeline_id", pipelineId)
    .order("position", { ascending: true });
  if (error) throw new Error(error.message);

  return (data ?? []) as unknown as EtapaEditavel[];
}

/** O que a tela recebe de volta: o funil vivo, na ordem das colunas. */
export function corpo(etapas: EtapaEditavel[]): {
  etapas: Array<Pick<EtapaEditavel, "id" | "name" | "slug" | "position" | "is_won" | "is_lost">>;
} {
  return {
    etapas: etapas
      .filter((e) => !e.is_archived)
      .map(({ id, name, slug, position, is_won, is_lost }) => ({
        id,
        name,
        slug,
        position,
        is_won,
        is_lost,
      })),
  };
}

/**
 * Recusa do banco traduzida — ou `null` se o erro não é de conflito.
 *
 * ⚠️ ESCOPO EXATO, porque o contrário já foi escrito aqui e era falso: isto
 * cobre `23505` e `23514`, os dois conflitos que um funil editado em duas abas
 * produz. Eles viram texto de tela em português porque "duplicate key value
 * violates unique constraint uniq_crm_stages_pipeline_won" não ensina nada ao
 * dono da clínica.
 *
 * O QUE NÃO É COBERTO: qualquer outro erro sai como `internal_error`, e o
 * `message` dele é técnico por convenção do repo (é o que a rota irmã faz). A
 * regra que vale para as DUAS classes é a de composição — texto de banco nunca
 * entra COLADO numa frase escrita para leigo; quando a rota precisa dizer algo
 * ao usuário sobre uma falha técnica, o texto do Postgres vai em `details`.
 */
export function conflitoDoBanco(
  erro: { code?: string } | null | undefined,
  nomeDaEtapa: string,
  requestId: string,
) {
  const motivo: Record<string, string> = {
    "23505": `Outra etapa deste funil já ocupa esse lugar — «${nomeDaEtapa}» não pôde ser gravada.`,
    "23514": `«${nomeDaEtapa}» mudou de papel neste funil (ganho ou perda) enquanto você editava.`,
  };
  const texto = motivo[erro?.code ?? ""];
  if (!texto) return null;
  return fail("state_conflict", `${texto} Recarregue a página e tente de novo.`, 409, { requestId });
}
