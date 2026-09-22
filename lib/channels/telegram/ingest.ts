/**
 * Ingestão do canal Telegram — webhook → contato, conversa, mensagem, efeitos.
 *
 * A rota (`app/api/v1/webhooks/telegram/[token]/route.ts`) já verificou o
 * segredo do path e leu o payload cru em `TelegramUpdate` (módulo `./webhook`,
 * ao lado). Este módulo não decide de quem é o webhook nem se o segredo bate —
 * só escreve o que já se sabe: a sessão do bot, a organização, e o evento.
 *
 * Espelha `../zernio/ingest.ts` nas três peças que todo canal de entrada
 * precisa (identidade opaca, resolução de conversa por thread do provider,
 * dedup por `external_id`), porque são a MESMA regra de negócio, não
 * característica deste transporte. Onde diverge do zernio é só onde a Bot API
 * diverge de verdade: aqui não há intermediário (`socialMessage`/`platform`),
 * o `channel` gravado é sempre o literal `'telegram'`, e a mídia chega como
 * `file_id` opaco que precisa de uma chamada extra (`getFile`) antes de virar
 * URL.
 *
 * ─── Idempotência ────────────────────────────────────────────────────────
 *
 * O Telegram reentrega o update quando não recebe 200 no tempo esperado — e
 * reentrega o MESMO `update_id`/mensagem. A chave é `(organization_id,
 * external_id)` no INSERT de `messages`, com `external_id` composto
 * `"<chat_id>:<message_id>"` (mesmo formato que `lib/channels/adapters/
 * telegram.ts` usa no envio, para que `reply_to_message_id` funcione nos dois
 * sentidos). Captura do `23505` devolve `{status: "duplicate"}` sem repetir
 * nenhum efeito colateral.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { aplicarEfeitosPosEntrada } from "../pos-entrada";
import { telegramApiBaseUrl } from "./credentials";
import type { TelegramMessage, TelegramUpdate } from "./webhook";

export interface TelegramIngestResult {
  status: "processed" | "duplicate" | "ignored";
  reason?: string;
}

/** O que a Bot API devolve para `getFile`. */
interface TelegramGetFileResponse {
  ok?: boolean;
  result?: { file_id: string; file_path?: string };
  description?: string;
}

/** O resultado de resolver o campo de mídia presente na mensagem, já pronto para gravar. */
interface MidiaResolvida {
  type: "image" | "audio" | "video" | "document" | "text";
  mediaUrl: string | null;
  mediaMime: string | null;
  /** Placeholder de corpo quando não há legenda e a mídia não baixou (ou não existe nenhuma). */
  bodyFallback: string | null;
}

/**
 * Concurrent first messages share a database uniqueness constraint — mesma
 * corrida que `upsertSocialContact` do zernio resolve: duas primeiras
 * mensagens do mesmo chat chegando juntas não podem virar dois contatos.
 */
async function upsertTelegramContact(
  admin: SupabaseClient,
  organizationId: string,
  identity: string,
  nome: string | null,
): Promise<string> {
  const { data: existing, error: readError } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("social_identity", identity)
    .maybeSingle();
  if (readError) throw new Error("telegram_contact_lookup_failed");
  if (existing) return existing.id as string;

  const { data, error } = await admin
    .from("contacts")
    .insert({
      organization_id: organizationId,
      social_identity: identity,
      name: nome,
      display_name: nome,
      source: "social",
    })
    .select("id")
    .single();
  if (error?.code === "23505") {
    const { data: winner, error: retryError } = await admin
      .from("contacts")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("social_identity", identity)
      .single();
    if (retryError || !winner) throw new Error("telegram_contact_race_failed");
    return winner.id as string;
  }
  if (error || !data) throw new Error("telegram_contact_create_failed");
  return data.id as string;
}

/** A conversa que o Telegram já associou a este chat, se houver (ver `conversaPelaThread` do zernio). */
async function conversaPelaThread(
  admin: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
  chatId: number,
): Promise<{ id: string; contact_id: string } | null> {
  const { data } = await admin
    .from("conversations")
    .select("id, contact_id")
    .eq("organization_id", organizationId)
    .eq("channel_session_id", channelSessionId)
    .eq("provider_conversation_id", String(chatId))
    .maybeSingle();
  const row = data as { id: string; contact_id: string | null } | null;
  return row?.contact_id ? { id: row.id, contact_id: row.contact_id } : null;
}

/**
 * Cria a conversa e grava a thread do provider — reusa a mesma RPC que o
 * zernio usa (`fn_upsert_wa_conversation`), genérica o suficiente apesar do
 * nome: só resolve/cria a linha de `conversations` para `(org, contact,
 * session)`, sem nada específico do WhatsApp no meio.
 */
async function upsertConversation(
  admin: SupabaseClient,
  input: { organizationId: string; contactId: string; channelSessionId: string; chatId: number },
): Promise<string | null> {
  const { data, error } = await admin.rpc("fn_upsert_wa_conversation", {
    p_org: input.organizationId,
    p_contact: input.contactId,
    p_session: input.channelSessionId,
  });
  if (error || !data) return null;
  const conversationId = data as string;

  // SEM `.neq()` — de propósito. Ver o comentário extenso em
  // `../zernio/ingest.ts` (`upsertConversation`): em SQL `NULL <> 'valor'` é
  // NULL, não TRUE, então uma conversa recém-criada (coluna ainda nula) nunca
  // seria alcançada por um update condicional, e a thread ficaria sem
  // `provider_conversation_id` para sempre.
  await admin
    .from("conversations")
    .update({ provider_conversation_id: String(input.chatId) })
    .eq("id", conversationId);

  return conversationId;
}

/** Mime esperado para cada tipo de mídia quando a Bot API não manda `mime_type`. */
function mimePadrao(tipo: "image" | "audio" | "video" | "document"): string | null {
  // Só `photo` tem formato fixo garantido pela Bot API — os demais dependem
  // do que o cliente mandou, e inventar um mime aqui mentiria para quem for
  // exibir o arquivo depois.
  return tipo === "image" ? "image/jpeg" : null;
}

/**
 * Resolve o campo de mídia presente na mensagem (se houver) numa URL de
 * download, chamando `getFile` na Bot API ANTES de a mensagem ser inserida.
 *
 * Nunca lança: perder a mídia não pode perder a mensagem inteira. Em falha
 * (chamada, ou `file_path` ausente), devolve `mediaUrl: null` e um
 * placeholder de corpo — o atendente precisa ver QUE algo chegou, mesmo sem
 * o arquivo.
 */
async function resolverMidia(
  message: TelegramMessage,
  botToken: string,
): Promise<MidiaResolvida | null> {
  let tipo: "image" | "audio" | "video" | "document";
  let fileId: string;
  let mimeDoCampo: string | null | undefined;

  // Prioridade defensiva: não deveria haver mais de um campo de mídia no
  // mesmo update, mas se houver, esta é a ordem.
  if (message.photo && message.photo.length > 0) {
    tipo = "image";
    // A Bot API lista do menor para o maior tamanho — o último é a maior resolução.
    fileId = message.photo[message.photo.length - 1].file_id;
    mimeDoCampo = "image/jpeg";
  } else if (message.voice) {
    tipo = "audio";
    fileId = message.voice.file_id;
    mimeDoCampo = message.voice.mime_type;
  } else if (message.video) {
    tipo = "video";
    fileId = message.video.file_id;
    mimeDoCampo = message.video.mime_type;
  } else if (message.document) {
    tipo = "document";
    fileId = message.document.file_id;
    mimeDoCampo = message.document.mime_type;
  } else if (message.audio) {
    tipo = "audio";
    fileId = message.audio.file_id;
    mimeDoCampo = message.audio.mime_type;
  } else {
    return null;
  }

  const legenda = message.caption ?? null;
  const placeholderIndisponivel = "[mídia recebida, indisponível para download]";

  try {
    const url = `${telegramApiBaseUrl()}/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
    const res = await fetch(url);
    const json = (await res.json().catch(() => null)) as TelegramGetFileResponse | null;

    if (!res.ok || json?.ok !== true || !json?.result?.file_path) {
      logger.warn("[telegram] getFile falhou — mensagem entra sem mídia", {
        tipo,
        status: res.status,
        descricao: json?.description ?? null,
      });
      return {
        type: tipo,
        mediaUrl: null,
        mediaMime: null,
        bodyFallback: legenda ?? placeholderIndisponivel,
      };
    }

    return {
      type: tipo,
      mediaUrl: `${telegramApiBaseUrl()}/file/bot${botToken}/${json.result.file_path}`,
      mediaMime: mimeDoCampo ?? mimePadrao(tipo),
      bodyFallback: legenda,
    };
  } catch (err) {
    logger.warn("[telegram] getFile lançou — mensagem entra sem mídia", {
      tipo,
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
    return {
      type: tipo,
      mediaUrl: null,
      mediaMime: null,
      bodyFallback: legenda ?? placeholderIndisponivel,
    };
  }
}

/**
 * Grava a linha de `messages` para esta mensagem de entrada.
 *
 * Devolve o id novo, ou `"duplicate"` quando o `external_id` já existe — o
 * desfecho ESPERADO de uma reentrega, não erro: o Telegram reenvia quando não
 * recebe 200, e tratar isto como falha faria a rota devolver 500 e ele
 * reenviar de novo, para sempre.
 */
async function insertMessage(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    conversationId: string;
    contactId: string;
    channelSessionId: string;
    message: TelegramMessage;
    body: string | null;
    type: "image" | "audio" | "video" | "document" | "text";
    mediaUrl: string | null;
    mediaMime: string | null;
  },
): Promise<string | "duplicate"> {
  const { message } = input;
  const externalId = `${message.chat.id}:${message.message_id}`;

  const { data, error } = await admin
    .from("messages")
    .insert({
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      contact_id: input.contactId,
      channel_session_id: input.channelSessionId,
      external_id: externalId,
      direction: "inbound",
      // Toda linha nascida do webhook veio de FORA do CRM — mesma marca que
      // zernio e o canal por QR usam, e da qual dependem as métricas de
      // fricção e o filtro de eco do próprio envio.
      sent_via: "external_device",
      status: "delivered",
      type: input.type,
      body: input.body,
      ...(input.mediaUrl ? { media_url: input.mediaUrl } : {}),
      ...(input.mediaMime ? { media_mime: input.mediaMime } : {}),
      // O Telegram manda `date` em segundos Unix, não milissegundos.
      sent_at: new Date(message.date * 1000).toISOString(),
    })
    .select("id")
    .maybeSingle();

  if (error?.code === "23505") return "duplicate";
  if (error || !data) throw new Error(`telegram_ingest_insert_failed: ${error?.message ?? "sem id"}`);

  return (data as { id: string }).id;
}

/** Nome de exibição a partir de `from` — concatena primeiro e último nome, quando houver. */
function nomeDoRemetente(message: TelegramMessage): string | null {
  if (!message.from) return null;
  const partes = [message.from.first_name, message.from.last_name].filter(Boolean);
  return partes.length > 0 ? partes.join(" ") : null;
}

/**
 * Grava um update já autenticado e resolvido pela rota.
 *
 * Recebe `session` (id, organização, bot) já resolvidos por quem chama — este
 * módulo não descobre de quem é o webhook, só escreve o que já se sabe.
 *
 * Erros de escrita (fora do `23505`) sobem: é o comportamento certo para
 * "evento bom, nós que não gravamos" — a rota devolve 500 e o Telegram
 * reentrega.
 */
export async function ingestTelegramInbound(
  admin: SupabaseClient,
  input: {
    session: { id: string; organizationId: string; telegramBotId: string };
    update: TelegramUpdate;
    botToken: string;
    requestId: string;
  },
): Promise<{ status: string; reason?: string }> {
  const { session, update } = input;

  const message = update.message;
  if (!message) return { status: "ignored", reason: "tipo_de_update_nao_suportado" };

  // Só chat PRIVADO nesta fase — grupos/canais ficam para depois (a
  // capability `groups: "limited"` da Fase 2 já sinaliza o suporte reduzido).
  if (message.chat.type !== "private") {
    return { status: "ignored", reason: "chat_nao_privado" };
  }

  const nome = nomeDoRemetente(message);

  // A THREAD é a prova de identidade, e vem ANTES da âncora — mesma regra do
  // zernio: se já existe conversa para este chat, é a MESMA pessoa, e pular a
  // resolução de contato evita criar um contato duplicado quando a thread já
  // é conhecida.
  const existente = await conversaPelaThread(admin, session.organizationId, session.id, message.chat.id);

  let conversationId: string;
  let contactId: string;

  if (existente) {
    conversationId = existente.id;
    contactId = existente.contact_id;
  } else {
    const identity = `telegram:${session.telegramBotId}:${message.chat.id}`;
    contactId = await upsertTelegramContact(admin, session.organizationId, identity, nome);

    const novaConversationId = await upsertConversation(admin, {
      organizationId: session.organizationId,
      contactId,
      channelSessionId: session.id,
      chatId: message.chat.id,
    });
    if (!novaConversationId) return { status: "ignored", reason: "conversa_nao_resolvida" };
    conversationId = novaConversationId;
  }

  // Gravação direta do literal — diferente do zernio, `'telegram'` não passa
  // por `SOCIAL_NETWORKS`/`ehCanalDeConversa`: aqui a plataforma não é
  // variável, é sempre a mesma string, já aceita pelo CHECK do banco desde a
  // Fase 1 deste plano.
  const { error: channelError } = await admin
    .from("conversations")
    .update({ channel: "telegram" })
    .eq("organization_id", session.organizationId)
    .eq("id", conversationId);
  if (channelError) throw new Error(`telegram_conversation_channel_update_failed: ${channelError.message}`);

  const midia = await resolverMidia(message, input.botToken);

  let type: "image" | "audio" | "video" | "document" | "text";
  let body: string | null;
  let mediaUrl: string | null;
  let mediaMime: string | null;

  if (midia) {
    type = midia.type;
    body = midia.bodyFallback;
    mediaUrl = midia.mediaUrl;
    mediaMime = midia.mediaMime;
  } else if (message.text) {
    type = "text";
    body = message.text;
    mediaUrl = null;
    mediaMime = null;
  } else {
    // Nenhum campo coberto pelo shape de `TelegramMessage` (location, contact,
    // sticker, etc.) — o JSON pode trazer esses campos mesmo sem o TYPE os
    // declarar. Não descarta: silêncio total no inbox é pior que um placeholder.
    type = "text";
    body = "[conteúdo não suportado neste canal ainda]";
    mediaUrl = null;
    mediaMime = null;
  }

  const inserted = await insertMessage(admin, {
    organizationId: session.organizationId,
    conversationId,
    contactId,
    channelSessionId: session.id,
    message,
    body,
    type,
    mediaUrl,
    mediaMime,
  });

  if (inserted === "duplicate") return { status: "duplicate" };

  await aplicarEfeitosPosEntrada(admin, {
    organizationId: session.organizationId,
    contactId,
    conversationId,
    messageId: inserted,
    channelSessionId: session.id,
    texto: body,
    nomeDoContato: nome,
    requestId: input.requestId,
    origem: "telegram_webhook",
  });

  return { status: "processed" };
}
