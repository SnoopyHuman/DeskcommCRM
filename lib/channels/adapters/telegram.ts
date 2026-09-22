/**
 * Adapter do canal Telegram — o transporte da Bot API oficial
 * (`https://api.telegram.org/bot<token>/<método>`).
 *
 * Burro como os irmãos: traduz formato e nada mais. Se aparecer aqui um `if`
 * sobre janela de 24h, cap diário ou horário, o desenho vazou — essas regras
 * vivem na cadeia `before_send` (doutrina `restricao-de-canal.md`). O
 * Telegram nem tem janela de reengajamento (`requiresTemplates: false`, Fase
 * 2) — o que existe aqui é só tradução de `kind` para método da Bot API.
 *
 * ─── O que É diferente dos irmãos zernio/waha ───────────────────────────────
 *
 * 1. `chat_id` endereça chat privado E grupo com o MESMO parâmetro — o
 *    Telegram não separa os dois recursos como o WhatsApp separa contato de
 *    grupo. `resolveRecipient` fica mais simples por isso, não por preguiça.
 * 2. O `message_id` que a Bot API devolve só é único DENTRO do chat — dois
 *    chats do MESMO bot podem repetir `message_id: 1`. `externalId` é
 *    composto (`"<chat_id>:<message_id>"`) para não colidir com o
 *    `UNIQUE (organization_id, external_id)` de `messages`. Ver o comentário
 *    em `send()`.
 * 3. Ao contrário do zernio, o Telegram tem suporte NATIVO a cartão de
 *    contato (`sendContact`) — não precisa lançar "not supported".
 * 4. **Endereça por THREAD, não por atributo do contato** — mesmo padrão de
 *    `lib/channels/social/adapter.ts` (zernio_social), diferente do zernio
 *    (que resolve telefone/id opaco a partir de `wa_identity`). O `chat_id`
 *    de verdade é `conversations.provider_conversation_id`, gravado pela
 *    ingestão (Fase 4) na PRIMEIRA mensagem que o cliente manda — um bot do
 *    Telegram nunca inicia conversa, então não existe cenário de "endereçar
 *    um contato que ainda não tem thread". `resolveRecipient` devolve só uma
 *    SENTINELA (existe conversa conhecida ou não); `send()` lê o endereço
 *    real de `envelope.providerConversationId`, nunca de `envelope.to`.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { FetchedMedia } from "@/lib/messaging/media/types";

import { resolveTelegramCreds } from "../telegram/credentials";
import type {
  ChannelAdapter,
  ChannelHealth,
  ChannelTenantScope,
  OutboundEnvelope,
  RecipientInput,
} from "../types";

/**
 * Desfaz `"<chat_id>:<message_id>"` de volta nas duas partes.
 *
 * Existe porque `replyToExternalId` chega no formato COMPOSTO que este mesmo
 * adapter gravou (ver `send()`), mas `reply_to_message_id` da Bot API quer só
 * o `message_id` numérico — mandar a string composta faz a API recusar o
 * parâmetro ou, pior, casar por acaso com outro id.
 */
function parseExternalId(externalId: string): { chatId: string; messageId: number } | null {
  const idx = externalId.indexOf(":");
  if (idx <= 0) return null;
  const chatId = externalId.slice(0, idx);
  const messageIdRaw = externalId.slice(idx + 1);
  if (!/^\d+$/.test(messageIdRaw)) return null;
  return { chatId, messageId: Number(messageIdRaw) };
}

/** Resposta crua de qualquer método `send*` da Bot API. */
interface TelegramSendResponse {
  ok?: boolean;
  result?: { message_id?: number; chat?: { id?: number | string } };
  error_code?: number;
  description?: string;
}

/** `POST {baseUrl}/bot{token}/{method}` com corpo JSON — o único formato que a Bot API fala. */
async function chamarBotApi(
  baseUrl: string,
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${baseUrl}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const telegramAdapter: ChannelAdapter = {
  provider: "telegram",

  /**
   * NÃO devolve o `chat_id` de verdade — devolve uma SENTINELA. Mesma decisão
   * de `lib/channels/social/adapter.ts` (zernio_social): canal que endereça
   * por THREAD do provider (`conversations.provider_conversation_id`), não
   * por atributo do contato, não tem endereço para calcular aqui — só tem
   * "existe conversa conhecida ou não", que é o que o handler/UI perguntam
   * com esta função (fila, estado de "sem destinatário"). O endereço real
   * chega em `send()` via `envelope.providerConversationId`.
   *
   * Grupo continua endereçado pelo próprio `chat_id` (o Telegram usa o MESMO
   * parâmetro para privado e grupo — diferente do WhatsApp/zernio, que
   * endereçam grupo por outro recurso). Grupos ainda não são ingeridos
   * (Fase 4 é só chat privado), então este ramo fica pronto para quando
   * existir, sem quebrar nada hoje.
   */
  resolveRecipient(input: RecipientInput): string | null {
    if (input.isGroup) return input.groupChatId ?? null;
    return "provider-thread";
  },

  /**
   * SEMPRE `true`, pelo mesmo motivo do zernio: a credencial pode viver só na
   * sessão cifrada (banco), e este método é SÍNCRONO — não pode consultar o
   * banco para responder com honestidade. Responder `false` sem consultar a
   * sessão faria toda organização que conectou o bot pela tela (sem
   * `TELEGRAM_BOT_TOKEN` no `.env`) ficar com mensagem parada em `queued`,
   * canal aparentemente "não configurado" enquanto está conectado e
   * funcionando.
   *
   * Quem desiste de verdade é `send()`, que LANÇA quando não acha credencial
   * nem na sessão nem no ambiente — nunca devolve `{externalId: null}`, que
   * colapsaria "não tentei" com "tentei e falhei" e faria o chamador gravar
   * `sent` para uma mensagem que nunca saiu.
   */
  isConfigured(): boolean {
    return true;
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    const admin = createAdminClient();
    const creds = await resolveTelegramCreds(admin, {
      organizationId: envelope.organizationId,
      botId: envelope.sessionRef,
    });
    if (!creds) {
      throw new Error(
        "telegram_not_configured: nenhuma credencial para este bot (nem na sessão, nem no ambiente).",
      );
    }

    // Sem thread conhecida não há envio possível — e não é caso raro de
    // borda: é a REGRA. Um bot do Telegram nunca inicia conversa (o usuário
    // sempre dá o primeiro passo), então `providerConversationId` SEMPRE
    // existe antes do primeiro envio nosso — ele nasce na ingestão (Fase 4),
    // na primeira mensagem que o cliente manda. Ausência aqui é bug de outra
    // camada (conversa criada fora do fluxo de webhook), não do cliente.
    const chatId = envelope.providerConversationId;
    if (!chatId) {
      throw new Error(
        "telegram_no_conversation: envio exige a thread do provider (chat_id); " +
          "ela só existe depois da primeira mensagem do cliente — bots não iniciam conversa no Telegram.",
      );
    }

    let method: string;
    let body: Record<string, unknown>;

    if (envelope.kind === "contact") {
      if (!envelope.contact) {
        throw new Error("telegram_contact_missing: envelope de contato sem dados de contato.");
      }
      const [firstName, ...resto] = envelope.contact.fullName.trim().split(/\s+/);
      method = "sendContact";
      body = {
        chat_id: chatId,
        phone_number: envelope.contact.phoneNumber,
        first_name: firstName || envelope.contact.fullName,
        ...(resto.length ? { last_name: resto.join(" ") } : {}),
      };
    } else if (envelope.kind === "image") {
      method = "sendPhoto";
      body = {
        chat_id: chatId,
        photo: envelope.media?.url,
        ...(envelope.media?.caption ? { caption: envelope.media.caption } : {}),
      };
    } else if (envelope.kind === "video") {
      method = "sendVideo";
      body = {
        chat_id: chatId,
        video: envelope.media?.url,
        ...(envelope.media?.caption ? { caption: envelope.media.caption } : {}),
      };
    } else if (envelope.kind === "audio") {
      // `sendVoice`, não `sendAudio`: é o que vira bolha de voz reproduzível.
      // A Bot API EXIGE ogg/opus para isso — mandar mp3 entrega arquivo de
      // música, a mesma armadilha que a capability `voiceNote: "opus-only"`
      // (Fase 2) já documenta. A conversão é de quem PREPARA a mídia antes do
      // envelope chegar aqui, não deste adapter.
      method = "sendVoice";
      body = {
        chat_id: chatId,
        voice: envelope.media?.url,
        ...(envelope.media?.caption ? { caption: envelope.media.caption } : {}),
      };
    } else if (!envelope.media && envelope.kind !== "document") {
      // "text" e qualquer kind sem mídia caem aqui como mensagem de texto —
      // é o caminho comum de resposta em conversa.
      method = "sendMessage";
      const replyTo = envelope.replyToExternalId ? parseExternalId(envelope.replyToExternalId) : null;
      body = {
        chat_id: chatId,
        text: envelope.body ?? "",
        ...(replyTo ? { reply_to_message_id: replyTo.messageId } : {}),
      };
    } else {
      // `document` e qualquer outro kind não coberto acima (`sticker`,
      // `location`, `template`…) caem em `sendDocument` como fallback
      // seguro: degradação DELIBERADA — o arquivo chega, só não como
      // sticker animado ou localização nativa, e é melhor que recusar o
      // envio inteiro.
      if (!envelope.media?.url) {
        throw new Error(`telegram_kind_unsupported: ${envelope.kind} sem mídia para enviar como documento.`);
      }
      method = "sendDocument";
      body = {
        chat_id: chatId,
        document: envelope.media.url,
        ...(envelope.media.caption ? { caption: envelope.media.caption } : {}),
      };
    }

    await envelope.beforeSend?.();
    const res = await chamarBotApi(creds.baseUrl, creds.token, method, body);
    const json = (await res.json().catch(() => null)) as TelegramSendResponse | null;

    if (!res.ok || json?.ok === false) {
      throw new Error(
        `telegram_send_failed: ${res.status} ${json?.error_code ?? ""} ${json?.description ?? res.statusText}`.trim(),
      );
    }

    if (!json?.result) return { externalId: null };

    // O `message_id` só é único DENTRO do chat — dois chats diferentes do
    // MESMO bot podem devolver `message_id: 1` cada um. `messages` tem
    // `UNIQUE (organization_id, external_id)`: gravar o `message_id` cru
    // arriscaria colisão entre conversas diferentes da mesma organização
    // assim que duas ficassem ativas ao mesmo tempo — bug que só aparece em
    // produção, nunca num teste com um chat só. Compor com o `chat.id`
    // resolve por construção.
    return { externalId: `${json.result.chat?.id}:${json.result.message_id}` };
  },

  /**
   * Baixa a mídia que o cliente MANDOU.
   *
   * Contrato ESTREITO de propósito: a Bot API não entrega URL de mídia direto
   * no webhook — entrega um `file_id`, que exige um `getFile` prévio para
   * virar `file_path`, e só então a URL de download fica pronta. Esse passo
   * (`file_id` → `getFile` → path) é trabalho da camada de INGESTÃO
   * (webhook), que ainda não existe nesta fase — fica para uma fase futura do
   * plano. Este método assume que `input.url` já chega TOTALMENTE resolvida,
   * no formato `https://api.telegram.org/file/bot<token>/<path>` — o próprio
   * token já vem embutido nesse formato de URL, por isso não há header
   * `Authorization` separado (diferente do zernio).
   */
  async fetchInboundMedia(input: ChannelTenantScope & {
    sessionRef: string;
    url: string;
    hintMime?: string | null;
  }): Promise<FetchedMedia> {
    const url = new URL(input.url);
    // A Bot API só serve estes dois hosts para download de arquivo — qualquer
    // outro valor aqui é a ingestão (fase futura) tendo montado a URL errado,
    // ou um payload malicioso tentando usar este fetch como proxy para outro
    // host.
    if (url.protocol !== "https:" || !/(^|\.)api\.telegram\.org$/.test(url.hostname)) {
      throw new Error("telegram_media_url_invalida: só aceito https://api.telegram.org/file/...");
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      throw new Error(`telegram_media_failed: ${res.status} ${res.statusText}`.trim());
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || input.hintMime || "application/octet-stream";
    return { buffer, mime };
  },

  /**
   * `getMe` — o único jeito de perguntar à Bot API se o token ainda vale.
   *
   * NÃO há um caso `"STOPPED"` aqui, diferente do zernio (que tem 404 = conta
   * sumiu): bots do Telegram não "somem" do lado da API por ação do usuário
   * do mesmo jeito que uma conta WhatsApp desconecta. `getMe` com token
   * válido sempre responde `ok:true` enquanto o bot existir — o único jeito
   * de o bot "cair" é o token ser revogado, e isso já cai no caso 401/403
   * abaixo.
   */
  async checkHealth(input: ChannelTenantScope & { sessionRef: string }): Promise<ChannelHealth> {
    const admin = createAdminClient();
    const creds = await resolveTelegramCreds(admin, {
      organizationId: input.organizationId,
      botId: input.sessionRef,
    });
    if (!creds) return { reachable: false, status: null, detail: "sem_credencial_para_a_sessao" };

    let res: Response;
    try {
      // Teto de espera: sem ele, um provedor que pendura a conexão pendura o
      // cron junto, e a varredura de saúde deixa de rodar para TODAS as sessões.
      res = await fetch(`${creds.baseUrl}/bot${creds.token}/getMe`, {
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : "erro_desconhecido";
      return { reachable: false, status: null, detail: detail.slice(0, 200) };
    }

    if (res.status === 401 || res.status === 403) {
      return { reachable: true, status: "FAILED", detail: null };
    }
    if (!res.ok) {
      return { reachable: false, status: null, detail: `provedor_respondeu_${res.status}` };
    }

    const json = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    if (json?.ok === true) {
      return { reachable: true, status: "WORKING", detail: null };
    }
    return { reachable: false, status: null, detail: "resposta_sem_ok" };
  },

  // Sem `signalTyping`: mesma decisão de `lib/channels/social/adapter.ts`
  // (zernio_social), e pelo MESMO motivo estrutural. O único "endereço" que
  // `presenca.ts` tem disponível para passar aqui é o que `resolveRecipient`
  // devolveu — e para este adapter isso é a sentinela `"provider-thread"`,
  // não um `chat_id` de verdade (ver comentário em `resolveRecipient`).
  // Implementar `sendChatAction` contra a sentinela mandaria "digitando" para
  // um chat que não existe. A interface trata isto como OPCIONAL de
  // propósito — `presenca.ts:91` já guarda com `if (!adapter.signalTyping)
  // return;` —, então omitir aqui é silencioso e seguro: o cliente ainda
  // ganha a espera proporcional ao texto, só não vê o indicador visual.
  // Destravar isto exige `presenca.ts` aprender a ler
  // `conversations.provider_conversation_id` para canais que endereçam por
  // thread — mudança de escopo maior que esta fase, e fora dela.

  codes: {
    notConfigured: "telegram_not_configured",
    sendFailed: "telegram_send_failed",
    unknownError: "telegram_unknown",
  },
};
