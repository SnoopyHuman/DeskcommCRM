/**
 * Sinais de vida no WhatsApp: ✓✓ azul (sendSeen) e "digitando…" (presence).
 *
 * Existem porque o WAHA não emite nenhum dos dois sozinho. Sem eles a conversa
 * fica visivelmente morta entre a mensagem do cliente e a resposta do agente —
 * e latência percebida é latência. O indicador de digitação do WhatsApp expira
 * em ~25s por conta própria, o que cobre o orçamento inteiro de um turno normal
 * sem precisarmos apagá-lo à mão (a chegada da resposta também o limpa).
 *
 * Duas peças chamam daqui — o webhook (Next.js, via WahaClient) e o drain do
 * worker (pg puro, sem o client) — então a implementação vive solta, recebendo
 * baseUrl/apiKey, em vez de presa a uma classe.
 *
 * TUDO aqui é best-effort e NUNCA lança: presença é cosmética. Deixar uma falha
 * de "digitando…" derrubar a ingestão da mensagem ou o enfileiramento do turno
 * seria trocar um enfeite pelo produto.
 */
export interface WahaConexao {
  baseUrl: string;
  apiKey: string;
}

export type PresencaChat = "typing" | "paused" | "recording";

const TIMEOUT_MS = 4_000;

async function postar(
  conn: WahaConexao,
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    await fetch(`${conn.baseUrl.replace(/\/$/, "")}/api/${path}`, {
      method: "POST",
      headers: { "X-Api-Key": conn.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Acende/apaga o "digitando…". Silencioso em qualquer falha. */
export async function definirPresenca(
  conn: WahaConexao,
  sessionName: string,
  chatId: string,
  presence: PresencaChat,
): Promise<void> {
  try {
    await postar(conn, `${encodeURIComponent(sessionName)}/presence`, { chatId, presence });
  } catch {
    // best-effort por contrato — ver cabeçalho.
  }
}

/**
 * Normaliza o id do webhook pro formato que o `sendSeen` do NOWEB/GOWS
 * espera: `{fromMe}_{chatId}_{bareId}` (ex.: `false_5511…@c.us_3EB0…`).
 * Id já completo passa intacto; bare vira `false_${chatId}_${bare}`.
 */
export function idsParaSendSeen(
  chatId: string,
  messageId: string | undefined | null,
): string[] | undefined {
  if (!messageId) return undefined;
  if (messageId.includes("_")) return [messageId];
  return [`false_${chatId}_${messageId}`];
}

/**
 * Marca a conversa como lida (✓✓ azul).
 *
 * No engine NOWEB (default deste projeto) o `POST /api/sendSeen` com só
 * `chatId` costuma devolver 201 e NÃO pintar o ✓✓ — precisa de `messageIds`
 * (issue WAHA #1725 / docs). Sem ids, caímos no endpoint de "ler todas as
 * unread" (`…/chats/{chatId}/messages/read`), que não exige id.
 */
export async function marcarComoLida(
  conn: WahaConexao,
  sessionName: string,
  chatId: string,
  messageId?: string | null,
): Promise<void> {
  try {
    const messageIds = idsParaSendSeen(chatId, messageId);
    if (messageIds) {
      await postar(conn, "sendSeen", {
        session: sessionName,
        chatId,
        messageIds,
      });
      return;
    }
    // Sem id da mensagem (chamada genérica): lê as unread do chat.
    const sess = encodeURIComponent(sessionName);
    const chat = encodeURIComponent(chatId);
    await postar(conn, `${sess}/chats/${chat}/messages/read`, {});
  } catch {
    // best-effort por contrato — ver cabeçalho.
  }
}

/**
 * Conexão a partir do env do processo, ou `null` quando o WAHA não está
 * configurado (dev sem container, self-host antes do onboarding). `null` faz o
 * chamador simplesmente pular — nunca quebrar.
 */
export function conexaoWahaDoEnv(): WahaConexao | null {
  const baseUrl = process.env.WAHA_API_BASE_URL;
  const apiKey = process.env.WAHA_API_KEY;
  if (!baseUrl || !apiKey || apiKey === "dev_plaintext_change_me") return null;
  return { baseUrl, apiKey };
}
