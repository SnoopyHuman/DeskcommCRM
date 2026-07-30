"use server";

/**
 * Server Action: create the tenant's first ai_agent (default) and stamp the
 * onboarding state. Uses canonical Spec 05 defaults baked into ai_agents.
 */
import { redirect } from "next/navigation";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { aiAgentDefaultSchema, type PromptTemplate } from "@/lib/schemas/onboarding";
import { requireOnboardingCtx, patchOnboardingState, OnboardingError } from "./_shared";

const PROMPT_BODIES: Record<PromptTemplate, string> = {
  ecommerce_friendly: `Você é um(a) atendente virtual amigável de uma loja online. Cumprimente, entenda a dúvida do cliente, ofereça opções claras e use linguagem calorosa. Confirme detalhes do pedido antes de agir.`,
  ecommerce_professional: `Você é um(a) atendente virtual profissional de e-commerce. Comunicação objetiva, formal e empática. Sempre cite o número do pedido quando relevante e ofereça próximos passos práticos.`,
  support_minimal: `Você é um(a) agente de suporte minimalista. Responda em frases curtas, peça apenas o necessário e direcione para um humano quando a confiança for baixa.`,
};

/**
 * Publica a 1ª versão do agente criado no onboarding.
 *
 * Sem isso, o passo "Configurar IA" gravava só a linha em `ai_agents` — formato
 * do `rag_bot` legado. Só que os dois runtimes atuais (o dispatcher do CRM e o
 * agent-engine) resolvem o agente por
 * `join ai_agent_versions on v.id = a.published_version_id`, então um agente
 * sem versão publicada é invisível para ambos: a pessoa terminava o onboarding
 * com um "Atendente IA" que nunca responderia uma única mensagem.
 *
 * Se ainda não existe número de WhatsApp (a versão exige `channel_session_id`),
 * o agente fica como rascunho — e o badge da lista passa a dizer isso, em vez
 * de anunciar "Publicado".
 */
async function publishFirstVersion(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  agentId: string,
  systemPrompt: string,
  userId: string,
): Promise<void> {
  const { data: session } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!session?.id) return; // sem canal ainda: fica rascunho, e a lista mostra "Rascunho"

  const { data: model } = await admin
    .from("ai_models")
    .select("model_id")
    .eq("provider", "anthropic")
    .eq("is_default_for_provider", true)
    .limit(1)
    .maybeSingle();

  const { data: version } = await admin
    .from("ai_agent_versions")
    .insert({
      organization_id: orgId,
      agent_id: agentId,
      version_number: 1,
      system_prompt: systemPrompt,
      provider: "anthropic",
      model: (model?.model_id as string) ?? "claude-sonnet-4-6",
      channel_session_id: session.id as string,
      status: "published",
      published_at: new Date().toISOString(),
      created_by: userId,
    })
    .select("id")
    .single();
  if (!version?.id) return;

  await admin
    .from("ai_agents")
    .update({ published_version_id: version.id as string })
    .eq("id", agentId)
    .eq("organization_id", orgId);
}

export type CreateAgentResult =
  | { ok: true; agent_id: string }
  | { ok: false; error: "auth_required" | "no_active_org" | "invalid_input" | "db_error"; details?: unknown };

export async function createDefaultAgent(formData: FormData): Promise<CreateAgentResult> {
  let ctx;
  try {
    ctx = await requireOnboardingCtx();
  } catch (err) {
    if (err instanceof OnboardingError) return { ok: false, error: err.code as never };
    throw err;
  }

  const raw = {
    name: String(formData.get("name") ?? "Atendente IA").trim(),
    prompt_template: String(formData.get("prompt_template") ?? "ecommerce_friendly"),
  };

  let input;
  try {
    input = aiAgentDefaultSchema.parse(raw);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { ok: false, error: "invalid_input", details: err.flatten() };
    }
    throw err;
  }

  const admin = createAdminClient();
  // Reset existing default to avoid trigger collisions if any.
  await admin
    .from("ai_agents")
    .update({ is_default: false })
    .eq("organization_id", ctx.orgId)
    .eq("is_default", true);

  const { data, error } = await admin
    .from("ai_agents")
    .insert({
      organization_id: ctx.orgId,
      name: input.name,
      system_prompt: PROMPT_BODIES[input.prompt_template],
      is_default: true,
      is_active: true,
      created_by: ctx.userId,
    })
    .select("id")
    .single();

  if (error || !data) {
    return { ok: false, error: "db_error", details: error?.message };
  }

  await publishFirstVersion(admin, ctx.orgId, data.id as string, PROMPT_BODIES[input.prompt_template], ctx.userId);

  try {
    await patchOnboardingState(ctx.orgId, {
      ai: { agent_id: data.id as string, prompt_template: input.prompt_template },
    });
  } catch (err) {
    if (err instanceof OnboardingError) return { ok: false, error: "db_error", details: err.message };
    throw err;
  }

  await audit({
    action: "onboarding.ai_configured",
    actorUserId: ctx.userId,
    organizationId: ctx.orgId,
    resourceType: "ai_agent",
    resourceId: data.id as string,
    metadata: { prompt_template: input.prompt_template, name: input.name },
  });

  // Emit a domain event for downstream listeners (Spec 01 §7 event log).
  await admin.from("event_log").insert({
    organization_id: ctx.orgId,
    event_type: "ai_agent.created",
    payload: { agent_id: data.id, source: "onboarding" },
  });

  redirect("/onboarding/invite-team");
}

export async function skipAi(): Promise<void> {
  const ctx = await requireOnboardingCtx();
  await patchOnboardingState(ctx.orgId, {
    ai: { agent_id: "", prompt_template: "skipped", skipped: true },
  });
  redirect("/onboarding/invite-team");
}
