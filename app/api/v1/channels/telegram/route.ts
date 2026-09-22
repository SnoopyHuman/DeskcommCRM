import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/channels/telegram — estado da conexão do bot.
 * POST /api/v1/channels/telegram — VALIDA o token, REGISTRA o webhook na Bot
 * API e só então grava.
 *
 * O caminho não cita o canal, e o corpo desta rota também não: quem é o
 * "telegram", como se chamam as colunas dele e como se valida o token estão
 * em `lib/channels/telegram/connect`. Mesmo desenho de
 * `app/api/v1/channels/partner/route.ts`.
 *
 * ─── O que muda em relação ao canal parceiro (zernio) ───────────────────────
 *
 * Lá o operador cola a URL do webhook manualmente num painel de terceiro, e a
 * rota devolve o segredo do webhook UMA vez para ele colar do outro lado.
 * Aqui não há painel de terceiro: o Telegram tem API própria
 * (`setWebhook`), e é o PRÓPRIO CRM que registra a URL e o segredo lá — o
 * operador nunca vê o segredo, porque nunca precisa colá-lo em lugar nenhum.
 *
 * Valida ANTES de gravar, pelo mesmo motivo de sempre: gravar primeiro e
 * descobrir depois é o que faz o operador achar que conectou e só entender
 * que não na primeira mensagem que não sai, com o lead esperando. Aqui a
 * ordem é ainda mais estrita: se o REGISTRO do webhook falhar, a sessão nem
 * chega a ser gravada — não vale persistir um canal "conectado" que o
 * Telegram não vai mandar update nenhum.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  TELEGRAM_CHANNEL_LABEL,
  findTelegramSession,
  registerTelegramWebhook,
  saveTelegramSession,
  validateTelegramBotToken,
} from "@/lib/channels/telegram/connect";
import { telegramApiBaseUrl } from "@/lib/channels/telegram/credentials";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { basePublicaDaInstalacao } from "@/lib/webhooks/url-publica";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const conectarSchema = z.object({
  token: z.string().trim().min(20).max(200),
});

/**
 * Endereço público desta instalação — é para ONDE o CRM registra o webhook no
 * `setWebhook`, e não algo que o operador cola em lugar nenhum (ver
 * `registerTelegramWebhook`). A rota do webhook em si é da Fase 4
 * (`app/api/v1/webhooks/telegram/[token]/route.ts`).
 */
function urlDoWebhook(req: NextRequest, token: string): string {
  return `${basePublicaDaInstalacao(req)}/api/v1/webhooks/telegram/${token}`;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  // Conectar um canal expõe o bot da empresa: é decisão de dono, não de quem
  // atende.
  const authz = await requireRole("admin", { requestId, resource: "channels_telegram" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const sessao = await findTelegramSession(createAdminClient(), orgId);
  const conectado = !!sessao && !sessao.archivedAt;

  return ok(
    {
      label: TELEGRAM_CHANNEL_LABEL,
      connected: conectado,
      channel_session_id: sessao?.id ?? null,
      bot_username: sessao?.username ?? null,
      display_name: sessao?.displayName ?? null,
      status: sessao?.status ?? null,
      // Existe, não qual é.
      has_token: sessao?.hasToken ?? false,
      endpoint: telegramApiBaseUrl(),
      webhook_url: sessao ? urlDoWebhook(req, sessao.webhookPathToken as string) : null,
    },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  // Conectar um canal expõe o bot da empresa: é decisão de dono, não de quem
  // atende.
  const authz = await requireRole("admin", { requestId, resource: "channels_telegram" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const parsed = conectarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", t("Informe o token do bot."), 422, { requestId });
  }

  // A rota não sabe com quem fala: pergunta se o token presta e o canal responde.
  const v = await validateTelegramBotToken(parsed.data.token);
  // `v.reason` já é texto pronto vindo de `connect.ts`, não passa por `t()` —
  // mesma observação do canal parceiro.
  if (!v.ok) return fail("invalid_request", v.reason, 422, { requestId });

  const admin = createAdminClient();
  const tokenCifrado = await encryptWebhookSecret(admin, parsed.data.token);
  if (!tokenCifrado) {
    // Sem a GUC de cifra, gravar o token em claro seria pior que recusar. O
    // operador precisa saber que falta configuração de servidor.
    return fail(
      "internal_error",
      t("Cifra indisponível nesta instalação — o token não foi gravado."),
      422,
      { requestId },
    );
  }

  const existente = await findTelegramSession(admin, orgId);
  // Reconectar por cima de um canal excluído RESSUSCITA a linha, e o token de
  // caminho do webhook é preservado para não invalidar o que o Telegram já
  // tem registrado. O SEGREDO do webhook, por outro lado, é sempre novo — ver
  // abaixo.
  const pathToken = existente?.webhookPathToken ?? randomBytes(16).toString("hex");

  // Segredo do webhook: é o que autentica o que ENTRA. Gerado de novo mesmo em
  // reconexão — diferente do path token, que é reaproveitado — porque cada
  // `setWebhook` é uma nova credencial de entrada, e não há motivo para
  // reaproveitar a antiga.
  const segredoWebhook = randomBytes(32).toString("hex");
  const segredoCifrado = await encryptWebhookSecret(admin, segredoWebhook);
  if (!segredoCifrado) {
    return fail(
      "internal_error",
      t("Cifra indisponível nesta instalação — o token não foi gravado."),
      422,
      { requestId },
    );
  }

  const webhookUrl = urlDoWebhook(req, pathToken);

  // Registra DIRETO na Bot API — diferente do canal parceiro, aqui não há
  // painel de terceiro para o operador colar a URL: o Telegram tem API
  // própria para isso, e é o CRM quem a chama.
  const reg = await registerTelegramWebhook({
    token: parsed.data.token,
    webhookUrl,
    secretToken: segredoWebhook,
  });
  if (!reg.ok) {
    // Sessão inútil sem webhook registrado: não vale persistir estado
    // quebrado. O operador vê o motivo e tenta de novo.
    return fail("invalid_request", reg.reason, 422, { requestId });
  }

  const { error } = await saveTelegramSession(admin, {
    organizationId: orgId,
    existingId: existente?.id ?? null,
    botId: v.botId,
    tokenEncrypted: tokenCifrado,
    webhookPathToken: pathToken,
    webhookSecretEncrypted: segredoCifrado,
    displayName: v.displayName,
  });
  if (error) return fail("internal_error", error, 500, { requestId });

  return ok(
    {
      connected: true,
      bot_username: v.username,
      display_name: v.displayName,
      webhook_url: webhookUrl,
      // Sem `webhook_secret` aqui, diferente do parceiro: o CRM já registrou o
      // segredo direto no Telegram via `setWebhook`. Não há nada para o
      // operador colar em lugar nenhum.
    },
    { requestId },
  );
}
