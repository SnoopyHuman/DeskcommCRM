/**
 * Credenciais do canal Telegram — **por sessão**, com env como fallback.
 *
 * Mesmo desenho de `../zernio/credentials.ts`: duas organizações com bots
 * diferentes na mesma instalação é o multi-tenant que o `CLAUDE.md` estabelece
 * desde o dia 1, e um segundo formato de credencial só faria o self-hoster ter
 * que aprender duas coisas.
 *
 * ─── O que muda em relação ao canal intermediado (zernio) ───────────────────
 *
 * Lá existe um INTERMEDIÁRIO entre nós e a Meta: o `accountId` é do provedor,
 * e o `apiKey` autentica contra o servidor DELE. Aqui não há intermediário
 * nenhum — o `token` FALA DIRETO com `api.telegram.org`. E o Telegram não
 * separa "id da conta" de "segredo": o próprio token, no formato
 * `<bot_id>:<segredo>`, já carrega os dois. Não existe uma segunda env var
 * para o bot id porque não há nada para ela guardar — ver `telegramCredsFromEnv`.
 *
 * A cifra usa as MESMAS RPCs do resto do repo (`fn_encrypt_oauth` /
 * `fn_decrypt_oauth`, ver `lib/webhooks/secrets.ts`). Escrever um terceiro
 * caminho de cifra seria mais um lugar por onde a chave vaza.
 *
 * ─── Por que a busca leva a ORGANIZAÇÃO junto (issue #236) ──────────────────
 * Mesma razão do zernio, e o mesmo desfecho medido: `telegram_bot_id` é
 * identificador do PROVIDER, duas organizações podiam ter o mesmo por
 * configuração legítima (agência, migração entre organizações), e
 * `maybeSingle()` com duas linhas devolve `data: null` + `PGRST116`. Com o
 * `error` descartado, as duas organizações passavam a enviar pelo bot do
 * `.env`. Filtro aqui, índice único parcial na migration 0381
 * (`channel_sessions_telegram_bot_id_ativo_unique`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export interface TelegramCredentials {
  botId: string;
  token: string;
  baseUrl: string;
  /** De onde veio — aparece no log de diagnóstico, nunca no payload. */
  source: "session" | "env";
}

/** A chave da busca. `organizationId` NÃO é decoração: ver o cabeçalho. */
export interface TelegramCredsLookup {
  /** Resolvido de fonte confiável (sessão, linha já escopada, token do webhook). */
  organizationId: string;
  /** `channel_sessions.telegram_bot_id` — o `sessionRef` deste canal. */
  botId: string;
}

/**
 * Base da API. Explícita e sobrescrevível: existe ambiente de homologação do
 * Telegram (Bot API local server) e um teste de integração precisa apontar
 * para outro lugar sem editar código.
 *
 * `||` e não `??`, e o `trim()` junto — a diferença é o bug inteiro.
 *
 * O `.env.example` entrega esta chave VAZIA, e o comentário ao lado dela
 * promete: "Vazio usa a API oficial do Telegram." O `??` não cumpria essa
 * promessa, porque ele só cai no padrão em `null`/`undefined` — string vazia
 * é valor, e passa. Quem fizesse `cp .env.example .env`, preenchesse o token
 * e deixasse este override como veio — que é o caminho NORMAL, já que o
 * override existe só para homologação — resolvia `baseUrl` para `""`,
 * montava `/bot<token>/sendMessage` sem host, e o `fetch` do Node recusava
 * com `TypeError: Failed to parse URL`. Todo envio pelo canal quebrava, nos
 * DOIS caminhos de credencial (env e sessão cifrada), que chamam esta mesma
 * função.
 *
 * Ausente funcionava e vazia não: por isso a doutrina de QA — que manda testar
 * com os envs opcionais AUSENTES — passava por cima. Quem copia o exemplo não
 * tem a var ausente, tem ela presente e vazia.
 */
export function telegramApiBaseUrl(): string {
  return process.env.TELEGRAM_API_BASE_URL?.trim() || "https://api.telegram.org";
}

/**
 * Credencial do ambiente. `null` quando não configurada — o chamador trata como
 * canal não conectado (noop), nunca como erro.
 *
 * Não existe `TELEGRAM_BOT_ID` separado: um token de bot do Telegram tem
 * SEMPRE o formato `<bot_id>:<segredo>` — é a própria API do Telegram que
 * exige essa forma, o id do bot é literalmente o primeiro segmento antes do
 * `:`. Uma env var redundante para o bot id só criaria uma segunda fonte de
 * verdade que podia divergir do token; extrair do próprio token elimina essa
 * possibilidade por construção.
 */
export function telegramCredsFromEnv(): TelegramCredentials | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return null;

  const botId = token.split(":")[0];
  if (!botId) return null;

  return { botId, token, baseUrl: telegramApiBaseUrl(), source: "env" };
}

/**
 * Credencial gravada na sessão DESTA ORGANIZAÇÃO que atende este bot.
 *
 * `null` significa "esta sessão não tem token gravado" — o chamador cai no env.
 * NÃO significa erro.
 *
 * **LANÇA quando a consulta falha.** Ver o cabeçalho: descartar o `error` era
 * metade do defeito da issue #236 — a colisão devolvia `data: null` com
 * `PGRST116`, e o `null` mandava as duas organizações para o bot do `.env`.
 */
export async function telegramCredsForBotId(
  admin: SupabaseClient,
  lookup: TelegramCredsLookup,
): Promise<TelegramCredentials | null> {
  const { organizationId, botId } = lookup;
  if (!organizationId || !botId) return null;

  // `organization_id` À MÃO (service role bypassa RLS) e `archived_at is null`
  // pelo MESMO recorte do índice único `channel_sessions_telegram_bot_id_ativo_unique`
  // (migration 0381): fora do recorte a trava do banco não alcança, e a busca
  // deixaria de ser exata exatamente onde ninguém a garante.
  const base = () =>
    admin
      .from("channel_sessions")
      .select("telegram_bot_id, telegram_bot_token_encrypted")
      .eq("organization_id", organizationId)
      .eq("telegram_bot_id", botId);
  const { data, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );
  if (error) {
    throw new Error(
      `telegram_creds_lookup_failed: ${error.code ?? "sem_codigo"} ${error.message ?? ""}`.trim(),
    );
  }

  const cifrado = data?.telegram_bot_token_encrypted;
  if (!data || !cifrado) return null;

  const token = await decryptWebhookSecret(admin, cifrado as unknown as string);
  // Decifra que falha devolve null: a chave (GUC) pode não estar configurada
  // nesta instalação. Cair no env é melhor que derrubar o envio — e o `source`
  // no retorno deixa a diferença visível para quem depura.
  if (!token) return null;

  return {
    botId: data.telegram_bot_id as string,
    token,
    baseUrl: telegramApiBaseUrl(),
    source: "session",
  };
}

/**
 * A credencial em vigor para este bot: **sessão primeiro, env como fallback**.
 *
 * A ordem é sessão-primeiro de propósito: com o token gravado, o env deixa de
 * ter efeito. Se fosse o contrário, um env esquecido silenciaria a configuração
 * da tela e o operador não entenderia por que nada mudou.
 */
export async function resolveTelegramCreds(
  admin: SupabaseClient,
  lookup: TelegramCredsLookup,
): Promise<TelegramCredentials | null> {
  return (await telegramCredsForBotId(admin, lookup)) ?? telegramCredsFromEnv();
}
