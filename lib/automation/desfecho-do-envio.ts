/**
 * O QUE A AUTOMAÇÃO REPORTA DEPOIS DE PEDIR UM ENVIO.
 *
 * ═══ O defeito que este módulo existe para acabar ═══
 *
 * `sendMessageHandler` NÃO LANÇA quando o envio falha. Ele marca a LINHA da
 * mensagem (`status='failed'`, com `error_code`/`error_message`) ou a deixa em
 * `queued`, e devolve a mensagem normalmente — porque quem o chama pela tela é
 * o Inbox, que renderiza a bolha com o estado dela.
 *
 * A ação da automação só olhava se houve exceção. Resultado medido neste repo,
 * com o transporte de WhatsApp fora do ar e a regra ligada exatamente como a
 * tela a monta:
 *
 *     automation_rule_runs.status = 'success'   ← ✓ verde na aba Atividade
 *     messages.status             = 'failed'    ← o cliente não recebeu nada
 *     messages.error_code         = <o código de falha do adapter>
 *
 * Uma tela que afirma sucesso é pior que uma tela silenciosa: quem a lê para de
 * procurar. O status do run passa a ser DERIVADO do estado real da mensagem.
 *
 * ═══ Por que um módulo, e não duas linhas dentro da ação ═══
 *
 * Porque são DUAS ações que pedem envio (`send_whatsapp_message` e
 * `send_ai_message`), e a segunda nasceu depois. Traduzir o desfecho em cada
 * uma seria plantar o mesmo defeito na irmã no dia em que ela foi escrita.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import type { ActionResultDetail } from "@/lib/automation/types";
import { fraseDaFalhaDeCanal } from "@/lib/channels/frases-de-falha";

/** O subconjunto de `messages` de que a tradução precisa. */
export interface MensagemEnviada {
  id: string;
  status: string;
  error_code?: string | null;
  error_message?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Estados em que a mensagem SAIU. `sent` é o que o adapter confirma. */
const SAIU = new Set(["sent", "delivered", "read"]);


/**
 * Traduz o estado REAL da mensagem no desfecho que a automação registra.
 *
 * `postponed` para `queued` e não `failed`: a mensagem ainda pode sair (o
 * watchdog do agent-engine resgata `sent_via='ai'` em `queued` quando a sessão
 * volta a WORKING). Dizer que falhou faria quem lê desistir de uma mensagem que
 * está a caminho — o oposto do defeito, e igualmente mentiroso.
 */
export function desfechoDoEnvio(
  tipo: string,
  mensagem: MensagemEnviada,
): ActionResultDetail {
  const base = { message_id: mensagem.id };

  if (SAIU.has(mensagem.status)) {
    return { type: tipo, status: "success", detail: base };
  }

  if (mensagem.status === "queued") {
    const motivo =
      typeof mensagem.metadata?.queued_reason === "string"
        ? mensagem.metadata.queued_reason
        : "aguardando_o_canal";
    return {
      type: tipo,
      status: "postponed",
      detail: {
        ...base,
        reason: motivo,
        explicacao:
          fraseDaFalhaDeCanal(motivo) ??
          "A mensagem está na fila e sai assim que o canal aceitar.",
      },
    };
  }

  // `failed` e qualquer estado inesperado caem aqui: o desconhecido não pode
  // virar sucesso por omissão (falha ABERTA na informação).
  const codigo = mensagem.error_code ?? mensagem.status;
  return {
    type: tipo,
    status: "failed",
    error:
      fraseDaFalhaDeCanal(mensagem.error_code) ??
      mensagem.error_message ??
      `A mensagem não saiu (${codigo}).`,
    detail: { ...base, error_code: mensagem.error_code ?? null, status: mensagem.status },
  };
}

/**
 * O caminho completo que as DUAS ações de envio usam: traduz o desfecho, anexa
 * a conversa, e — só quando a mensagem morreu — abre o aviso na Central.
 *
 * O aviso sai apenas em `failed`. Em `postponed` a mensagem ainda está a
 * caminho, e avisar ali encheria a Central de alarme sobre coisa que se
 * resolve sozinha — que é o jeito mais rápido de fazer alguém parar de ler a
 * Central.
 */
export async function reportarEnvio(
  ctx: { admin: SupabaseClient; organizationId: string; ruleName: string },
  tipo: string,
  mensagem: MensagemEnviada,
  conversationId: string,
): Promise<ActionResultDetail> {
  const desfecho = desfechoDoEnvio(tipo, mensagem);
  desfecho.detail = { ...(desfecho.detail ?? {}), conversation_id: conversationId };

  if (desfecho.status === "failed") {
    await avisarEnvioQueFalhou(ctx.admin, {
      organizationId: ctx.organizationId,
      ruleName: ctx.ruleName,
      conversationId,
      motivo: desfecho.error ?? "A mensagem não saiu.",
    });
  }
  return desfecho;
}

/**
 * A falha PRECISA alcançar alguém que não está olhando a aba Atividade.
 *
 * Mesmo kind (`message_send_stuck`) e mesma tela do cron `recover-stuck-messages`:
 * é o mesmo fato de negócio — uma mensagem que devia ter chegado ao cliente e
 * não chegou —, e inventar um kind novo dividiria o mesmo problema em duas
 * listas. Fire-and-forget: um aviso que não entra não pode derrubar a regra.
 */
export async function avisarEnvioQueFalhou(
  admin: SupabaseClient,
  entrada: {
    organizationId: string;
    ruleName: string;
    conversationId?: string | null;
    motivo: string;
  },
): Promise<void> {
  const { error } = await admin.from("agent_inbox_items").insert({
    organization_id: entrada.organizationId,
    kind: "message_send_stuck",
    severity: "critical",
    title: "Uma automação não conseguiu falar com o cliente",
    body:
      `A automação "${entrada.ruleName}" disparou e a mensagem não chegou. ${entrada.motivo} ` +
      `Nada foi reenviado automaticamente — reenviar sem saber a causa arrisca mandar a mesma mensagem duas vezes.`,
    ref_kind: entrada.conversationId ? "conversation" : null,
    ref_id: entrada.conversationId ?? null,
  });
  if (error) {
    logger.error("[automation] aviso de envio falho não entrou na Central", {
      organization_id: entrada.organizationId,
      error: error.message,
    });
  }
}
