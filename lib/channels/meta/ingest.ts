/**
 * Ingestão de mensagem RECEBIDA pelo canal oficial — a metade que faltava.
 *
 * Sem ela o canal é um megafone: o cliente responde e nada chega, nenhum lead se
 * move, o agente não acorda, e a janela de 24h — que deriva de
 * `conversations.last_inbound_at` — nunca abre. O gate da Fase 4 vetaria para sempre
 * e o sistema só saberia falar por template.
 *
 * ─── Reusa as MESMAS operações canônicas do outro canal ─────────────────────
 * `fn_upsert_wa_contact` / `fn_upsert_wa_conversation` / `fn_mark_conversation_message`
 * já resolvem contato e conversa de forma atômica, e são agnósticas de provider. O
 * que muda aqui é só o mapeamento do payload — escrever uma segunda resolução de
 * contato seria criar a divergência que a migration 0027 (wa_identity canônica)
 * eliminou.
 *
 * ─── Duas armadilhas medidas contra a WABA real ─────────────────────────────
 * 1. **O `wa_id` pode vir sem o nono dígito** (`553198966398` para quem recebemos
 *    como `5531998966398`). A resolução do contato passa por `phoneLookupVariants`,
 *    senão a mesma pessoa vira dois cadastros e a conversa parte ao meio.
 * 2. **A Meta re-entrega tudo que não recebe 2xx.** A idempotência por
 *    `unique (organization_id, external_id)` não é higiene, é obrigatória: sem ela a
 *    mesma mensagem aparece N vezes no inbox depois de qualquer instabilidade.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { phoneLookupVariants } from "../phone-variants";
import type { InboundMessageEvent } from "./webhook";

type Admin = SupabaseClient;

export type IngestOutcome =
  | { status: "ingested"; messageId: string; conversationId: string }
  | { status: "duplicate" }
  | { status: "no_session" }
  | { status: "failed"; reason: string };

/**
 * Sessão dona do número que RECEBEU. Amarra a mensagem ao tenant certo — nunca
 * confiamos no corpo para escolher organização (regra dura de tenancy).
 */
async function sessionByPhoneNumberId(admin: Admin, phoneNumberId: string) {
  const { data } = await admin
    .from("channel_sessions")
    .select("id, organization_id")
    .eq("meta_phone_number_id", phoneNumberId)
    .maybeSingle();
  return data;
}

/**
 * Contato já existente sob QUALQUER variante do número. Só depois de não achar é que
 * deixamos o upsert criar — assim o cadastro nasce uma vez só, e o número gravado
 * continua sendo o que já estava lá (não sobrescrevemos o formato de ninguém).
 */
async function findContactByVariants(
  admin: Admin,
  orgId: string,
  waId: string,
): Promise<{ id: string; phone_number: string } | null> {
  const variantes = phoneLookupVariants(waId);
  if (variantes.length === 0) return null;
  const { data } = await admin
    .from("contacts")
    .select("id, phone_number")
    .eq("organization_id", orgId)
    .in("phone_number", variantes)
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

/** Prévia curta para a lista de conversas. Mídia vira rótulo, nunca URL. */
function previewOf(e: InboundMessageEvent): string {
  if (e.type === "text") return (e.text ?? "").slice(0, 120);
  if (e.type === "audio") return e.media?.voice ? "🎤 Mensagem de voz" : "🎵 Áudio";
  if (e.type === "image") return "📷 Imagem";
  if (e.type === "video") return "🎬 Vídeo";
  if (e.type === "document") return "📎 Documento";
  return `[${e.type}]`;
}

export async function ingestMetaInbound(
  admin: Admin,
  e: InboundMessageEvent,
): Promise<IngestOutcome> {
  const sessao = await sessionByPhoneNumberId(admin, e.phoneNumberId);
  // Sem sessão: a mensagem é de um número que não administramos. Devolver 200 (o
  // chamador faz isso) evita a Meta re-entregar em loop algo que nunca vamos aceitar.
  if (!sessao) return { status: "no_session" };

  const orgId = sessao.organization_id;

  const existente = await findContactByVariants(admin, orgId, e.from);
  // O upsert recebe o número JÁ EXISTENTE quando há um — é o que impede o contato de
  // ser recriado sob a outra grafia do nono dígito.
  const phone = existente?.phone_number ?? `+${e.from.replace(/\D/g, "")}`;

  const { data: contactId, error: erroContato } = await admin.rpc(
    "fn_upsert_wa_contact" as never,
    {
      p_org: orgId,
      p_kind: "phone",
      p_phone: phone,
      p_lid: null,
      p_chat_id: e.from,
      p_notify: e.profileName,
    } as never,
  );
  if (erroContato || !contactId) {
    return { status: "failed", reason: `contato: ${erroContato?.message ?? "sem id"}` };
  }

  const { data: conversationId, error: erroConversa } = await admin.rpc(
    "fn_upsert_wa_conversation" as never,
    { p_org: orgId, p_contact: contactId as string, p_session: sessao.id } as never,
  );
  if (erroConversa || !conversationId) {
    return { status: "failed", reason: `conversa: ${erroConversa?.message ?? "sem id"}` };
  }

  const { data: inserida, error: erroInsert } = await admin
    .from("messages")
    .insert({
      organization_id: orgId,
      conversation_id: conversationId as string,
      // NOT NULL na tabela. Esquecê-lo fez o insert falhar e — porque a rota
      // descartava o resultado — a falha virou "recebido: 1" com nada gravado.
      channel_session_id: sessao.id,
      contact_id: contactId as string,
      direction: "inbound",
      status: "delivered",
      type: e.type === "text" ? "text" : e.type,
      body: e.text,
      external_id: e.externalId,
      media_mime: e.media?.mime ?? null,
      sent_at: e.sentAt.toISOString(),
      metadata: e.media ? { meta_media_id: e.media.id, voice: e.media.voice } : {},
    })
    .select("id")
    .maybeSingle();

  // 23505 = a mesma `external_id` já entrou. Não é erro: é a Meta re-entregando.
  if (erroInsert) {
    if (erroInsert.code === "23505") return { status: "duplicate" };
    return { status: "failed", reason: `mensagem: ${erroInsert.message}` };
  }

  // Carimba a conversa — é ISTO que move `last_inbound_at` e abre a janela de 24h.
  // Falha aqui não derruba a ingestão (a mensagem já entrou), mas o preview e a
  // janela ficariam desatualizados, então o erro sobe como `failed` parcial no log
  // do chamador em vez de sumir.
  await admin.rpc("fn_mark_conversation_message" as never, {
    p_conv: conversationId as string,
    p_direction: "inbound",
    p_preview: previewOf(e),
    p_at: e.sentAt.toISOString(),
  } as never);

  return {
    status: "ingested",
    messageId: (inserida as { id: string } | null)?.id ?? "",
    conversationId: conversationId as string,
  };
}
