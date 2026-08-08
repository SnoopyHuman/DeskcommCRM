/**
 * Credenciais do canal intermediado — **por sessão**, com env como fallback.
 *
 * Mesmo desenho de `../meta/credentials.ts`, e de propósito: duas organizações
 * com contas diferentes na mesma instalação é o multi-tenant que o `CLAUDE.md`
 * estabelece desde o dia 1, e um segundo formato de credencial só faria o
 * self-hoster ter que aprender duas coisas.
 *
 * ─── O que muda em relação ao canal oficial ─────────────────────────────────
 *
 * Lá a credencial é um par (`phone_number_id` + token da Meta) e o `sessionRef`
 * é o próprio `phone_number_id`. Aqui o `sessionRef` é o `accountId` que o
 * INTERMEDIÁRIO devolve ao conectar a WABA, e o token é a API key DELE — não a
 * da Meta. São chaves de sistemas diferentes: mandar o token da Meta aqui
 * autentica contra o servidor errado.
 *
 * A cifra usa as MESMAS RPCs do resto do repo (`fn_encrypt_oauth` /
 * `fn_decrypt_oauth`, ver `lib/webhooks/secrets.ts`). Escrever um terceiro
 * caminho de cifra seria mais um lugar por onde a chave vaza.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export interface ZernioCredentials {
  accountId: string;
  apiKey: string;
  baseUrl: string;
  /** De onde veio — aparece no log de diagnóstico, nunca no payload. */
  source: "session" | "env";
}

/**
 * Base da API. Explícita e sobrescrevível: o próprio provider publica um
 * servidor local no OpenAPI, e um teste de integração precisa apontar para
 * outro lugar sem editar código.
 */
export function zernioBaseUrl(): string {
  return process.env.ZERNIO_API_BASE_URL ?? "https://zernio.com/api";
}

/**
 * Credencial do ambiente. `null` quando não configurada — o chamador trata como
 * canal não conectado (noop), nunca como erro.
 */
export function zernioCredsFromEnv(): ZernioCredentials | null {
  const accountId = process.env.ZERNIO_ACCOUNT_ID;
  const apiKey = process.env.ZERNIO_API_KEY;
  if (!accountId || !apiKey) return null;
  return { accountId, apiKey, baseUrl: zernioBaseUrl(), source: "env" };
}

/**
 * Credencial gravada na sessão que atende esta conta.
 *
 * `null` significa "esta sessão não tem chave gravada" — o chamador cai no env.
 * NÃO significa erro.
 */
export async function zernioCredsForAccountId(
  admin: SupabaseClient,
  accountId: string,
): Promise<ZernioCredentials | null> {
  if (!accountId) return null;

  const { data } = await admin
    .from("channel_sessions")
    .select("zernio_account_id, zernio_token_encrypted")
    .eq("zernio_account_id", accountId)
    .maybeSingle();

  const cifrado = data?.zernio_token_encrypted;
  if (!data || !cifrado) return null;

  const apiKey = await decryptWebhookSecret(admin, cifrado as unknown as string);
  // Decifra que falha devolve null: a chave (GUC) pode não estar configurada
  // nesta instalação. Cair no env é melhor que derrubar o envio — e o `source`
  // no retorno deixa a diferença visível para quem depura.
  if (!apiKey) return null;

  return {
    accountId: data.zernio_account_id as string,
    apiKey,
    baseUrl: zernioBaseUrl(),
    source: "session",
  };
}

/**
 * A credencial em vigor para esta conta: **sessão primeiro, env como fallback**.
 *
 * A ordem é sessão-primeiro de propósito: com a chave gravada, o env deixa de
 * ter efeito. Se fosse o contrário, um env esquecido silenciaria a configuração
 * da tela e o operador não entenderia por que nada mudou.
 */
export async function resolveZernioCreds(
  admin: SupabaseClient,
  accountId: string,
): Promise<ZernioCredentials | null> {
  return (await zernioCredsForAccountId(admin, accountId)) ?? zernioCredsFromEnv();
}
