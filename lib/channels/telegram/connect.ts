/**
 * Conexão do canal Telegram — do lado de dentro do seam.
 *
 * Mesmo desenho de `../connect.ts` (parceiro/zernio): a tela e a rota não
 * podem nomear o provider (invariante 1 da doutrina), mas precisam de como se
 * chama o canal, quais campos pedir e se o que o operador colou presta. As
 * três moram aqui.
 *
 * ─── O que muda em relação ao canal parceiro (zernio) ───────────────────────
 *
 * Lá o operador cola a URL do webhook manualmente num painel de terceiro —
 * é o provedor intermediário que expõe essa tela, não a Meta. Aqui não há
 * intermediário: o Telegram tem API PRÓPRIA para registrar webhook
 * (`setWebhook`), então depois de validar o token o CRM se anuncia sozinho ao
 * Telegram. O operador só cola o token; nenhum passo manual depois disso.
 *
 * ─── Validar ANTES de gravar ────────────────────────────────────────────────
 *
 * Mesma decisão da conexão oficial e do parceiro, pelo mesmo motivo: gravar
 * primeiro e descobrir depois é o que faz o operador achar que conectou e só
 * entender que não na primeira mensagem que não sai — com o lead esperando.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";
import { CHANNEL_PROVIDER_TELEGRAM } from "../capabilities";
import { telegramApiBaseUrl } from "./credentials";

export const TELEGRAM_CHANNEL_LABEL = "Telegram";

export type TelegramValidation =
  | {
      ok: true;
      botId: string;
      username: string | null;
      displayName: string;
    }
  | { ok: false; reason: string };

/**
 * A credencial presta, e é mesmo o token de um bot?
 *
 * `getMe` é a chamada mais barata da Bot API para as duas perguntas: se o
 * Telegram aceitou o token (autenticação) e o que ele devolve como identidade
 * do bot (para preencher a tela sem o operador digitar nome/usuário de novo).
 */
export async function validateTelegramBotToken(token: string): Promise<TelegramValidation> {
  const tokenLimpo = token.trim();
  if (!tokenLimpo) return { ok: false, reason: "Informe o token do bot." };

  let res: Response;
  try {
    res = await fetch(`${telegramApiBaseUrl()}/bot${tokenLimpo}/getMe`);
  } catch {
    // Rede caída não é token errado, e dizer "token recusado" mandaria o
    // operador trocar um token que estava certo.
    return { ok: false, reason: "Não foi possível falar com o Telegram." };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "Token recusado pelo Telegram." };
  }
  if (!res.ok) {
    return { ok: false, reason: `O Telegram respondeu ${res.status}.` };
  }

  const json = (await res.json().catch(() => null)) as {
    ok?: boolean;
    result?: {
      id: number;
      is_bot: boolean;
      first_name: string;
      last_name?: string;
      username?: string;
    };
    description?: string;
  } | null;

  if (json?.ok !== true || !json.result) {
    return { ok: false, reason: json?.description ?? "Resposta inesperada do Telegram." };
  }

  // Defensivo: um token de bot pertence CATEGORICAMENTE a um bot. Se o
  // Telegram devolver `is_bot: false` para ele, algo está errado antes de
  // gravar qualquer coisa.
  if (json.result.is_bot !== true) {
    return { ok: false, reason: "Este token não é de um bot." };
  }

  const displayName = json.result.last_name
    ? `${json.result.first_name} ${json.result.last_name}`
    : json.result.first_name;

  return {
    ok: true,
    botId: String(json.result.id),
    username: json.result.username ?? null,
    displayName,
  };
}

export type TelegramWebhookRegistration = { ok: true } | { ok: false; reason: string };

/**
 * Registra o webhook DIRETO na Bot API.
 *
 * Este passo não existe no canal parceiro (zernio): lá o operador cola a URL
 * manualmente num painel de terceiro, porque quem intermedia é o provedor, não
 * a Meta. Aqui o Telegram expõe API própria para isso (`setWebhook`), então o
 * CRM se registra sozinho — nenhum passo manual do operador além de colar o
 * token. O `secret_token` enviado aqui é o mesmo que o Telegram devolve depois
 * no header `X-Telegram-Bot-Api-Secret-Token`, que `./webhook` (Fase 4) já
 * sabe conferir.
 *
 * Ver https://core.telegram.org/bots/api#setwebhook.
 */
export async function registerTelegramWebhook(input: {
  token: string;
  webhookUrl: string;
  secretToken: string;
}): Promise<TelegramWebhookRegistration> {
  let res: Response;
  let json: { ok?: boolean; description?: string } | null;
  try {
    res = await fetch(`${telegramApiBaseUrl()}/bot${input.token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: input.webhookUrl, secret_token: input.secretToken }),
    });
    json = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
  } catch {
    return { ok: false, reason: "Não foi possível registrar o webhook no Telegram." };
  }

  if (!res.ok || json?.ok !== true) {
    return {
      ok: false,
      reason: json?.description ?? `O Telegram recusou o webhook (${res.status}).`,
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Persistência
// ---------------------------------------------------------------------------

/**
 * `username` NÃO é lido do banco: a migration da Fase 1 criou só
 * `telegram_bot_id` e `telegram_bot_token_encrypted`, sem coluna para o
 * usuário do bot. Ele existe aqui só para o formato da resposta de leitura ser
 * uniforme com `TelegramValidation` — ao vir de `findTelegramSession`, fica
 * sempre `null`. Quem precisa do username de verdade (a tela, logo após
 * conectar) o recebe direto da resposta do POST, que carrega o valor fresco
 * de `validateTelegramBotToken`.
 */
export interface TelegramSession {
  id: string;
  botId: string | null;
  username: string | null;
  displayName: string | null;
  status: string | null;
  webhookPathToken: string | null;
  hasToken: boolean;
  archivedAt: string | null;
}

const COLUNAS =
  "id, telegram_bot_id, display_name, status, webhook_path_token, telegram_bot_token_encrypted";

function toTelegramSession(row: Record<string, unknown> | null): TelegramSession | null {
  if (!row) return null;
  return {
    id: row.id as string,
    botId: (row.telegram_bot_id as string) ?? null,
    // Ver o comentário da interface: não há coluna para isto ainda.
    username: null,
    displayName: (row.display_name as string) ?? null,
    status: (row.status as string) ?? null,
    webhookPathToken: (row.webhook_path_token as string) ?? null,
    hasToken: !!row.telegram_bot_token_encrypted,
    archivedAt: (row.archived_at as string) ?? null,
  };
}

export async function findTelegramSession(
  admin: SupabaseClient,
  organizationId: string,
): Promise<TelegramSession | null> {
  const buscar = (colunas: string) =>
    admin
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", organizationId)
      .eq("provider", CHANNEL_PROVIDER_TELEGRAM)
      .maybeSingle();

  const { data } = await queryTolerantToMissingArchived(
    () => buscar(`${COLUNAS}, ${ARCHIVED_AT}`),
    () => buscar(COLUNAS),
  );
  return toTelegramSession(data as Record<string, unknown> | null);
}

/**
 * Grava (ou ressuscita) a sessão.
 *
 * `archived_at: null` sempre: reconectar por cima de um canal excluído
 * precisa trazê-lo de volta. Sem isso o update deixaria a coluna no lugar e o
 * canal "conectado" ficaria invisível para o webhook e o envio, ambos
 * filtrados por ela.
 */
export async function saveTelegramSession(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    existingId?: string | null;
    botId: string;
    tokenEncrypted: string;
    webhookPathToken: string;
    webhookSecretEncrypted: string;
    displayName: string | null;
  },
): Promise<{ error: string | null }> {
  const linha = {
    organization_id: input.organizationId,
    provider: CHANNEL_PROVIDER_TELEGRAM,
    telegram_bot_id: input.botId,
    telegram_bot_token_encrypted: input.tokenEncrypted,
    webhook_path_token: input.webhookPathToken,
    webhook_secret_encrypted: input.webhookSecretEncrypted,
    display_name: input.displayName,
    status: "WORKING",
    archived_at: null,
  };

  const { error } = input.existingId
    ? await admin.from("channel_sessions").update(linha).eq("id", input.existingId)
    : await admin
        .from("channel_sessions")
        .insert({ ...linha, metadata: metadataInicialDoCanal() });

  return { error: error?.message ?? null };
}
