/**
 * POST /api/v1/webhooks/telegram/[token] — entrada da Bot API do Telegram.
 *
 * ─── Por que esta rota é DEDICADA, e não passa pela genérica de canal ──────
 *
 * `app/api/v1/webhooks/channel/[token]/route.ts` foi desenhada em volta de
 * assinatura HMAC sobre o corpo (zernio) — a verificação mora em
 * `lib/channels/inbound.ts`, que despacha por `provider` sem a rota precisar
 * saber o mecanismo. O Telegram não assina nada: o segredo configurado no
 * `setWebhook` volta inteiro no header `X-Telegram-Bot-Api-Secret-Token` (ver
 * `lib/channels/telegram/webhook.ts`), uma comparação de STRING, não HMAC.
 * Forçar esse mecanismo pela rota agnóstica exigiria ensiná-la sobre um tipo
 * de autenticação que os outros canais nem usam — mais barato manter uma
 * rota curta e dedicada, do mesmo jeito que `waha/[token]` já é dedicada ao
 * seu próprio esquema.
 *
 * ─── O 200 que evita a tempestade ───────────────────────────────────────────
 *
 * Payload que não interessa (corpo malformado, sessão sem credencial ou sem
 * segredo configurado) responde 200: o Telegram reentrega o que não recebeu
 * 200, e recusar algo que nunca vai virar evento válido faria a reentrega
 * durar para sempre. 401 fica reservado para o secret_token errado — aí a
 * recusa é o ponto. 500 fica reservado para falha de ESCRITA.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import {
  abrirArquivoDoWebhook,
  fecharArquivoDoWebhook,
} from "@/lib/channels/arquivo-de-webhook";
import { resolveTelegramCreds } from "@/lib/channels/telegram/credentials";
import { ingestTelegramInbound } from "@/lib/channels/telegram/ingest";
import { parseTelegramUpdate, verifyTelegramSecretToken } from "@/lib/channels/telegram/webhook";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { token } = await ctx.params;

  // Token curto nunca foi emitido por nós. 404 e não 401: quem varre URLs não
  // precisa saber que a rota existe.
  if (!token || token.length < 8) {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }

  const rawBody = await req.text();
  const admin = createAdminClient();

  const { data } = await queryTolerantToMissingArchived(
    () =>
      admin
        .from("channel_sessions")
        .select(
          `id, organization_id, provider, telegram_bot_id, webhook_secret_encrypted, ${ARCHIVED_AT}`,
        )
        .eq("webhook_path_token", token)
        .maybeSingle(),
    () =>
      admin
        .from("channel_sessions")
        .select("id, organization_id, provider, telegram_bot_id, webhook_secret_encrypted")
        .eq("webhook_path_token", token)
        .maybeSingle(),
  );

  const sessao = data as {
    id: string;
    organization_id: string;
    provider: string;
    telegram_bot_id: string | null;
    webhook_secret_encrypted: unknown;
    archived_at?: string | null;
  } | null;

  if (!sessao) return fail("not_found", "unknown webhook token", 404, { requestId });

  // Canal arquivado não ingere: o usuário mandou excluí-lo, e aceitar evento em
  // voo ressuscitaria a conversa no inbox com o operador sem poder responder.
  if (sessao.archived_at) {
    return ok({ status: "ignored", reason: "canal_arquivado" }, { requestId });
  }

  if (sessao.provider !== "telegram") {
    return fail("invalid_request", "provider_mismatch", 400, { requestId });
  }

  // Credencial ANTES do arquivamento: sem token de bot não há como chamar
  // `getFile` para mídia nem processar nada — não vale nem arquivar o corpo
  // de uma sessão que não tem como ser servida.
  const creds = sessao.telegram_bot_id
    ? await resolveTelegramCreds(admin, {
        organizationId: sessao.organization_id,
        botId: sessao.telegram_bot_id,
      })
    : null;

  if (!creds) {
    return ok({ status: "ignored", reason: "sem_credencial" }, { requestId });
  }

  const cifrado = sessao.webhook_secret_encrypted;
  const secret = cifrado ? await decryptWebhookSecret(admin, cifrado as string) : null;

  // Sessão sem segredo configurado é erro de CONFIGURAÇÃO do nosso lado, não
  // ataque — nunca vale a pena o Telegram reentregar pra sempre por isso.
  if (!secret) {
    return ok({ status: "ignored", reason: "canal_sem_segredo_configurado" }, { requestId });
  }

  // ─── O corpo cru vai para o arquivo ANTES da conferência do secret_token ──
  //
  // Quem chegou aqui já acertou o TOKEN da URL (que é secreto) e pode ter
  // errado só o secret_token do header — não é ruído de internet, é alguém
  // com metade das credenciais. Arquivar é o que permite investigar depois.
  const arquivo = await abrirArquivoDoWebhook(admin, {
    organizationId: sessao.organization_id,
    channelSessionId: sessao.id,
    provider: sessao.provider,
    rawBody,
    headers: req.headers,
  });

  const secretHeader = req.headers.get("x-telegram-bot-api-secret-token");
  if (!verifyTelegramSecretToken(secretHeader, secret)) {
    await fecharArquivoDoWebhook(admin, arquivo, {
      status: "error",
      validSignature: false,
      erro: "bad_secret_token",
    });
    return fail("unauthorized", "bad_secret_token", 401, { requestId });
  }

  const update = parseTelegramUpdate(rawBody);
  if (!update) {
    // Autenticação PASSOU — não é ataque, é corpo que não segue o contrato.
    // Não adianta o Telegram reentregar o mesmo corpo malformado pra sempre.
    await fecharArquivoDoWebhook(admin, arquivo, {
      status: "error",
      validSignature: true,
      erro: "payload_invalido",
    });
    return ok({ status: "ignored", reason: "payload_invalido" }, { requestId });
  }

  try {
    const resultado = await ingestTelegramInbound(admin, {
      session: {
        id: sessao.id,
        organizationId: sessao.organization_id,
        telegramBotId: sessao.telegram_bot_id ?? creds.botId,
      },
      update,
      botToken: creds.token,
      requestId,
    });

    await fecharArquivoDoWebhook(admin, arquivo, {
      status: "processed",
      validSignature: true,
      erro: resultado.reason ?? null,
    });
    return ok(resultado, { requestId });
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : "ingest_failed";
    await fecharArquivoDoWebhook(admin, arquivo, {
      status: "error",
      validSignature: null,
      erro: detalhe,
    });
    return fail("internal_error", detalhe, 500, { requestId });
  }
}
