/**
 * POST /api/v1/pipelines/[id]/stages — cria uma etapa no fim do funil.
 *
 * Até aqui NENHUMA tela criava etapa: o gatilho `trg_seed_default_pipeline_for_org`
 * semeia um funil de e-commerce em toda organização nova, então uma clínica abre
 * o sistema e vê "Carrinho abandonado" sem ter como corrigir. Esta rota é a
 * primeira metade da saída; as regras vivem em `lib/leads/stage-editing.ts`
 * (puras, testadas) e aqui só há transporte.
 *
 * Auth: sessão por cookie, papel manager+ (é configuração do funil, não trabalho
 * de card). `organization_id` sai do JWT — nunca do body. O client é o do
 * usuário, então a RLS vale; o filtro explícito é a convenção do repo e a rede
 * que sobra se a policy mudar.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { posicaoEntre, slugDeNome, validarNomeDeEtapa } from "@/lib/leads/stage-editing";
import { createClient } from "@/lib/supabase/server";

import { conflitoDoBanco, corpo, lerFunil } from "./_funil";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// `.max(80)`: o nome é o topo de uma coluna do quadro, não um parágrafo. O banco
// não limita, mas a tela quebra muito antes disso.
const bodySchema = z.object({ name: z.string().min(1).max(80) }).strict();

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "crm_stages" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const { id: pipelineId } = await ctx.params;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", "Corpo não é JSON válido.", 400, { requestId });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return fail("unprocessable_entity", "Dê um nome à etapa — é o que aparece no topo da coluna.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const name = parsed.data.name.trim();

  const supabase = await createClient();

  let etapas: Awaited<ReturnType<typeof lerFunil>>;
  try {
    etapas = await lerFunil(supabase, orgId, pipelineId);
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }
  // Funil de outra org morre AQUI, antes de qualquer escrita: responder 404
  // depois de gravar seria pior do que responder 200.
  if (!etapas) return fail("not_found", "Funil não encontrado.", 404, { requestId });

  // ⚠️ VALIDAR ANTES DE TOCAR O BANCO. As constraints são a rede de segurança,
  // não a primeira linha: um 23505 cru não diz QUAL etapa está errada.
  const veredito = validarNomeDeEtapa(name, etapas, null);
  if (!veredito.ok) {
    return fail("unprocessable_entity", veredito.erro, 422, { requestId });
  }

  const row = {
    organization_id: orgId,
    pipeline_id: pipelineId,
    name,
    // Slug nasce com a etapa e nunca muda (renomear não o toca). Arquivadas
    // entram na conta: `uniq_crm_stages_pipeline_slug` não é parcial.
    slug: slugDeNome(name, etapas.map((e) => e.slug)),
    // No fim do funil: etapa nova aparecendo no meio das colunas seria a tela
    // decidindo por quem criou. A conta usa a última posição do funil INTEIRO
    // (`lerFunil` vem ordenado) e não a última ativa — arquivada não aparece no
    // quadro, então passar por cima dela não muda nada para quem olha, e
    // filtrar seria uma segunda régua de posição para sustentar de graça.
    position: posicaoEntre(etapas[etapas.length - 1]?.position ?? null, null),
  };

  const { data: criada, error } = await supabase
    .from("crm_stages")
    .insert(row)
    .select("id")
    .single();

  if (error) {
    const conflito = conflitoDoBanco(error as { code?: string }, name, requestId);
    if (conflito) return conflito;
    return fail("internal_error", error.message, 500, { requestId });
  }

  void audit({
    action: "pipeline.stage_created",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "crm_stage",
    resourceId: (criada as { id: string }).id,
    requestId,
    metadata: { pipeline_id: pipelineId, name, slug: row.slug },
  });

  // Relê em vez de espelhar o que foi pedido: a tela mostra o que o banco tem.
  try {
    const depois = await lerFunil(supabase, orgId, pipelineId);
    if (!depois) return fail("not_found", "Funil não encontrado.", 404, { requestId });
    return ok(corpo(depois), { status: 201, requestId });
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }
}
