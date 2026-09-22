/**
 * Entrada do canal Telegram — leitura do payload e verificação do segredo do
 * webhook.
 *
 * PURO de propósito, como `../zernio/webhook.ts`: nada aqui toca banco, rede
 * ou relógio. É o que permite provar o caso difícil (corpo malformado,
 * segredo errado, campo ausente) sem subir infraestrutura.
 *
 * ─── Por que o mecanismo de autenticação é DIFERENTE do zernio ─────────────
 *
 * O zernio assina o CORPO com HMAC-SHA256: o segredo nunca trafega, só a
 * assinatura derivada dele, e por isso a verificação recalcula o hash sobre
 * `rawBody` e compara.
 *
 * O Telegram não assina nada. Quando a sessão é conectada, o CRM chama
 * `setWebhook` (core.telegram.org/bots/api#setwebhook) passando um parâmetro
 * `secret_token` de até 256 caracteres. A partir daí, TODA chamada que o
 * Telegram faz para o nosso endpoint inclui esse mesmo valor, sem alteração,
 * no header `X-Telegram-Bot-Api-Secret-Token` — é o próprio segredo voltando
 * no header, não uma assinatura derivada dele. Por isso não faz sentido
 * comparar contra `rawBody` aqui: não há "corpo assinado", só dois valores
 * que precisam ser byte a byte iguais.
 */
import { timingSafeEqual } from "node:crypto";

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  first_name?: string;
  last_name?: string;
  username?: string;
  title?: string;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number; // unix seconds
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
  video?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  audio?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

/**
 * Lê o corpo cru como um `TelegramUpdate`. `null` quando o corpo não é JSON
 * válido, OU quando é JSON mas não tem `update_id` numérico — nunca lança.
 *
 * Nunca lançar é deliberado: `abrirArquivoDoWebhook` já arquiva o corpo cru
 * ANTES desta chamada, exatamente para o caso de o corpo não ser o que se
 * espera. Um `null` aqui é sinal para a rota responder 200 (o Telegram para de
 * reentregar um corpo que nunca vai virar `TelegramUpdate`), não uma exceção
 * que derrubaria a resposta.
 */
export function parseTelegramUpdate(rawBody: string): TelegramUpdate | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const update_id = (parsed as Record<string, unknown>).update_id;
  if (typeof update_id !== "number") return null;

  return parsed as TelegramUpdate;
}

/**
 * Compara o header `X-Telegram-Bot-Api-Secret-Token` recebido com o segredo
 * configurado no `setWebhook` desta sessão — comparação de tempo constante,
 * não HMAC (ver o cabeçalho do arquivo).
 */
export function verifyTelegramSecretToken(received: string | null, expected: string): boolean {
  // Sem header não há o que comparar — mesmo raciocínio de `verifyZernioSignature`:
  // "não dá para verificar" nunca é "passa".
  if (received === null) return false;
  if (!expected) return false;

  const a = Buffer.from(received, "utf8");
  const b = Buffer.from(expected, "utf8");

  // `timingSafeEqual` LANÇA quando os buffers têm tamanhos diferentes — um
  // throw aqui viraria 500 em vez de 401, e o chamador aprenderia pelo status
  // o que não deveria. Conferir o comprimento ANTES evita o throw.
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
