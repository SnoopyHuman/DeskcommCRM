/**
 * Credenciais do canal oficial — **por sessão**, não por instalação.
 *
 * ─── O limite que isto remove ───────────────────────────────────────────────
 * Até aqui `getMetaCreds()` lia `META_PHONE_NUMBER_ID` e `META_SYSTEM_USER_TOKEN`
 * do ambiente. Funciona para quem tem UM número — e torna impossível duas
 * organizações com números oficiais diferentes na mesma instalação, o que contradiz
 * o multi-tenant que o `CLAUDE.md` estabelece desde o dia 1.
 *
 * A credencial passa a viver na linha de `channel_sessions` (colunas criadas pela
 * migration 0087), cifrada pelas MESMAS RPCs que o resto do repo usa
 * (`fn_encrypt_oauth`/`fn_decrypt_oauth`, ver `lib/webhooks/secrets.ts`). Escrever um
 * terceiro caminho de cifra seria criar mais um lugar para a chave vazar.
 *
 * ─── Por que o env continua existindo ───────────────────────────────────────
 * Como **fallback explícito de instalação de número único**, não como padrão. Um
 * self-hoster que ainda não passou pela tela de conexão continua funcionando, e o
 * caminho fica nomeado (`source: 'env'`) em vez de virar comportamento oculto — quem
 * depura vê de onde a credencial veio.
 *
 * A ordem é sessão-primeiro de propósito: com a credencial gravada, o env deixa de
 * ter efeito. Se fosse o contrário, um env esquecido silenciaria a configuração da
 * tela e o operador não entenderia por que mudou nada.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export interface MetaCredentials {
  phoneNumberId: string;
  token: string;
  graphVersion: string;
  /** De onde veio — aparece no log de diagnóstico, nunca no payload. */
  source: "session" | "env";
}

/** Versão da Graph API. Explícita de propósito: bump é decisão, não deriva. */
function graphVersion(): string {
  return process.env.META_GRAPH_VERSION ?? "v22.0";
}

/**
 * Credencial do ambiente. `null` quando não configurada — o chamador trata como
 * canal não conectado (noop), nunca como erro.
 */
export function metaCredsFromEnv(): MetaCredentials | null {
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!phoneNumberId || !token) return null;
  return { phoneNumberId, token, graphVersion: graphVersion(), source: "env" };
}

/**
 * Credencial da sessão que atende este `phone_number_id`.
 *
 * `null` significa "esta sessão não tem token gravado" — o chamador cai no env. NÃO
 * significa erro: durante a transição a maioria das instalações ainda usa env.
 */
export async function metaCredsForPhoneNumberId(
  admin: SupabaseClient,
  phoneNumberId: string,
): Promise<MetaCredentials | null> {
  if (!phoneNumberId) return null;

  const { data } = await admin
    .from("channel_sessions")
    .select("meta_phone_number_id, meta_token_encrypted")
    .eq("meta_phone_number_id", phoneNumberId)
    .maybeSingle();

  const cifrado = data?.meta_token_encrypted;
  if (!data || !cifrado) return null;

  const token = await decryptWebhookSecret(admin, cifrado as unknown as string);
  // Decifra que falha devolve null: a chave (GUC) pode não estar configurada nesta
  // instalação. Cair no env é melhor que derrubar o envio — e o `source` no retorno
  // deixa a diferença visível para quem depura.
  if (!token) return null;

  return {
    phoneNumberId: data.meta_phone_number_id as string,
    token,
    graphVersion: graphVersion(),
    source: "session",
  };
}

/**
 * A credencial em vigor para este número: **sessão primeiro, env como fallback**.
 *
 * Uma instalação com várias organizações grava um token por sessão e cada uma envia
 * pelo seu; uma instalação de número único pode continuar no env sem tocar em nada.
 */
export async function resolveMetaCreds(
  admin: SupabaseClient,
  phoneNumberId: string,
): Promise<MetaCredentials | null> {
  return (await metaCredsForPhoneNumberId(admin, phoneNumberId)) ?? metaCredsFromEnv();
}
