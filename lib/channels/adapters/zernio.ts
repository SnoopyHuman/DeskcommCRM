/**
 * Adapter do canal intermediado — o transporte de um BSP.
 *
 * Burro como os dois irmãos: traduz formato e nada mais. Se aparecer aqui um
 * `if` sobre janela de 24h, cap diário ou horário, o desenho vazou — essas
 * regras vivem na cadeia `before_send` (doutrina `restricao-de-canal.md`).
 *
 * ─── A diferença que morde quem copia o adapter do canal oficial ────────────
 *
 * Os dois canais existentes DERIVAM o destinatário do contato: um monta o
 * chatId a partir do telefone, o outro usa o E.164 em dígitos. **Este não.**
 * Quem endereça é um id de thread que o intermediário inventa, e que chega pelo
 * webhook. Medido contra a API real, não lido da doc:
 *
 *   POST /v1/inbox/conversations/6a3580f68fcd5b3a5b946bf8/messages  → 200
 *   { success: true, data: { messageId: "wamid.HBgMNTk1...", conversationId } }
 *
 * Por isso `send` exige `providerConversationId`. Sem ele NÃO existe envio de
 * texto livre: o endpoint que aceita telefone exige template e devolve
 * `TEMPLATE_REQUIRED`, que é o caminho de reengajamento, não o de resposta.
 *
 * `resolveRecipient` continua devolvendo o telefone porque é o que identifica o
 * contato para o resto do sistema (dedup de eco, log, abertura de conversa por
 * template) — mas não é o que endereça este envio.
 *
 * ─── Duas coisas medidas na API, não supostas ───────────────────────────────
 *
 * 1. O `messageId` devolvido é um **wamid da Meta**, não um id do
 *    intermediário. É o mesmo espaço de identificador do canal oficial, então
 *    o eco do webhook casa direto e não precisa de `echoExternalIds`.
 * 2. Os dois endpoints devolvem a MESMA forma (`data.messageId`), mas com
 *    status HTTP diferentes — 201 ao abrir a conversa, 200 ao responder nela.
 *    Ler `res.ok` e não o código exato é o que faz os dois caminhos
 *    conviverem.
 */
import { createAdminClient } from "@/lib/supabase/admin";

import { resolveZernioCreds, zernioCredsFromEnv } from "../zernio/credentials";
import { zernioTemplateOps } from "../zernio/templates";
import type { ChannelAdapter, OutboundEnvelope, RecipientInput } from "../types";

/** Só dígitos. `+595 (99) 173-3685` → `595991733685`. */
function toE164Digits(raw: string): string {
  return raw.replace(/\D/g, "");
}

/** `kind` do envelope → o par (attachmentType, voiceNote) que a API espera. */
function attachmentFields(env: OutboundEnvelope): Record<string, unknown> {
  if (!env.media) return {};
  const base: Record<string, unknown> = {
    attachmentUrl: env.media.url,
    ...(env.media.filename ? { attachmentName: env.media.filename } : {}),
    ...(env.media.caption ? { message: env.media.caption } : {}),
  };
  switch (env.kind) {
    case "image":
      return { ...base, attachmentType: "image" };
    case "video":
      return { ...base, attachmentType: "video" };
    case "audio":
      // `voiceNote: true` é o que faz virar BOLHA DE VOZ. A API aceita a flag
      // mas NÃO converte: exige ogg/opus mono, igual ao canal oficial. Mandar
      // mp3 com a flag entrega anexo de música — por isso a capability declara
      // `opus-only`, e a conversão é de quem prepara a mídia, não daqui.
      return { ...base, attachmentType: "audio", voiceNote: true };
    default:
      return { ...base, attachmentType: "file" };
  }
}

export const zernioAdapter: ChannelAdapter = {
  provider: "zernio",

  /**
   * Telefone em dígitos — é o `participantId` da API.
   *
   * Grupo devolve `null`: a API de grupos deste canal é outro recurso
   * (`/wa-groups`), com id próprio, e fingir que um chatId de grupo cabe aqui
   * mandaria a mensagem para o lugar errado.
   */
  resolveRecipient(input: RecipientInput): string | null {
    if (input.isGroup) return null;
    const doIdentity = input.waIdentity?.startsWith("phone:")
      ? input.waIdentity.slice("phone:".length)
      : null;
    const bruto = doIdentity ?? input.phoneNumber ?? null;
    if (!bruto) return null;
    const digitos = toE164Digits(bruto);
    return digitos.length > 0 ? digitos : null;
  },

  /**
   * Síncrono de propósito, como no canal oficial: responde "dá para tentar?"
   * sem tocar o banco. A credencial gravada na SESSÃO é resolvida de novo
   * dentro de `send`, que é async — devolver `false` aqui com sessão
   * configurada faria o handler gravar `queued` sem motivo.
   */
  isConfigured(): boolean {
    return zernioCredsFromEnv() !== null || !!process.env.ZERNIO_API_KEY;
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    const admin = createAdminClient();
    const creds = await resolveZernioCreds(admin, envelope.sessionRef);
    if (!creds) return { externalId: null };

    // Sem thread conhecida não há envio livre. Falhar aqui, com mensagem que
    // nomeia o motivo, é melhor que montar uma URL com `undefined` e receber um
    // 404 que ninguém consegue interpretar seis meses depois.
    if (!envelope.providerConversationId) {
      throw new Error(
        "zernio_no_conversation: envio livre exige a thread do provider; " +
          "abra a conversa com um template antes (a thread chega no webhook).",
      );
    }

    const url =
      `${creds.baseUrl}/v1/inbox/conversations/` +
      `${encodeURIComponent(envelope.providerConversationId)}/messages`;

    const body: Record<string, unknown> = {
      accountId: creds.accountId,
      ...(envelope.media ? attachmentFields(envelope) : { message: envelope.body ?? "" }),
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const json = (await res.json().catch(() => null)) as {
      success?: boolean;
      data?: { messageId?: string };
      error?: string;
      code?: string;
    } | null;

    if (!res.ok || json?.success === false) {
      // O `code` do provider entra na mensagem quando existe: é ele que
      // distingue "fora da janela" de "número bloqueado" de "conta suspensa", e
      // sem isso o operador vê só "falhou".
      const detalhe = json?.code ? `${json.code}: ${json.error ?? ""}` : (json?.error ?? res.statusText);
      throw new Error(`zernio_send_failed: ${res.status} ${detalhe}`.trim());
    }

    // 201 ao abrir a conversa, 200 ao responder nela — os dois caminhos
    // devolvem a mesma forma, então quem lê não precisa saber qual foi.
    return { externalId: json?.data?.messageId ?? null };
  },

  /** Gestão das definições aprovadas — ver `../zernio/templates.ts`. */
  templates: zernioTemplateOps,

  codes: {
    notConfigured: "zernio_not_configured",
    sendFailed: "zernio_error",
    unknownError: "zernio_unknown",
  },
};
