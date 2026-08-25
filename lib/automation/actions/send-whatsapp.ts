import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import { renderTemplate } from "@/lib/automation/template";
import { ensureConversation } from "@/lib/automation/start-conversation";
import { checkDailyLimit, espacarEnvio } from "@/lib/automation/throttle";
import { adiarAteAJanelaAbrir } from "@/lib/automation/janela-do-canal";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { reportarEnvio, type MensagemEnviada } from "@/lib/automation/desfecho-do-envio";

async function postponeUntil(ctx: ActionCtx, config: Record<string, unknown>): Promise<string | null> {
  const sessionId = typeof config.channel_session_id === "string" ? config.channel_session_id : null;
  if (!sessionId) return null; // config inválida falha no execute, não adia

  // A janela vem dos knobs DO NÚMERO (fuso do tenant, domingo configurável) —
  // a mesma régua da tela de Conexões e do agente. Ver janela-do-canal.ts.
  const foraDaJanela = await adiarAteAJanelaAbrir(ctx.admin, ctx.organizationId, sessionId);
  if (foraDaJanela) return foraDaJanela;

  const daily = await checkDailyLimit(ctx.admin, ctx.organizationId, sessionId);
  return daily.allowed ? null : (daily.retry_at ?? null);
}

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const sessionId = typeof config.channel_session_id === "string" ? config.channel_session_id : null;
  const template = typeof config.template === "string" ? config.template : null;
  if (!sessionId || !template) {
    return { type: "send_whatsapp_message", status: "failed", error: "missing_config" };
  }
  const contact = ctx.context.contact as { id: string; is_blocked?: boolean; phone_number?: string | null } | undefined;
  if (!contact) return { type: "send_whatsapp_message", status: "skipped", detail: { reason: "no_contact" } };
  if (contact.is_blocked) return { type: "send_whatsapp_message", status: "skipped", detail: { reason: "contact_blocked" } };
  if (!contact.phone_number) return { type: "send_whatsapp_message", status: "skipped", detail: { reason: "no_phone" } };

  // O espaçamento é COMPARTILHADO com a ação de IA (mesmo número, mesmo
  // contador) — ver lib/automation/throttle.ts.
  await espacarEnvio(sessionId);

  try {
    const conversationId = await ensureConversation(ctx.admin, ctx.organizationId, contact.id, sessionId);
    const body = renderTemplate(template, ctx.context);
    const message = await sendMessageHandler(
      ctx.admin,
      {
        organization_id: ctx.organizationId,
        actor: { type: "webhook_source", id: ctx.ruleId },
        requestId: `rule:${ctx.ruleId}`,
      },
      { conversation_id: conversationId, type: "text", body } as Parameters<typeof sendMessageHandler>[2],
    );
    // O desfecho vem do ESTADO DA MENSAGEM, nunca da ausência de exceção:
    // `sendMessageHandler` marca `failed`/`queued` e devolve normalmente (ver
    // lib/automation/desfecho-do-envio.ts para o defeito medido).
    return await reportarEnvio(ctx, "send_whatsapp_message", message as unknown as MensagemEnviada, conversationId);
  } catch (err) {
    return {
      type: "send_whatsapp_message",
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

registerAction({ type: "send_whatsapp_message", postponeUntil, execute });
