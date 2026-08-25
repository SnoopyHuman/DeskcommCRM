/**
 * Acrescenta `assigned_to_user_name` às conversas que saem pela borda HTTP.
 *
 * Fica FORA de `_handler.ts` de propósito: aquele handler é compartilhado com as
 * tools MCP, que já resolvem o nome por conta própria — enriquecer lá faria a
 * mesma leitura duas vezes em toda chamada do agente.
 *
 * O campo é opcional no tipo (`?`) porque quem consome pode estar lendo uma
 * resposta de antes deste campo existir, e porque `null` aqui é um estado
 * DECLARADO (sem service role, ou lookup que falhou) — ver
 * `lib/users/nome-do-atendente.ts`. A tela nunca deve traduzir esse `null` para
 * "sem responsável": o dono é o `assigned_to_user_id`.
 */
import type { Conversation } from "@/lib/types/messaging";

import { nomesDosAtendentes } from "./nome-do-atendente";

export type ConversationComAtendente = Conversation & {
  assigned_to_user_name?: string | null;
};

export async function comNomeDoAtendente<T extends { assigned_to_user_id: string | null }>(
  conversas: T[],
): Promise<Array<T & { assigned_to_user_name: string | null }>> {
  const nomes = await nomesDosAtendentes(conversas.map((c) => c.assigned_to_user_id));
  return conversas.map((c) => ({
    ...c,
    assigned_to_user_name: c.assigned_to_user_id
      ? (nomes.get(c.assigned_to_user_id) ?? null)
      : null,
  }));
}
