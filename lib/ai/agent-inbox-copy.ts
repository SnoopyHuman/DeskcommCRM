/**
 * Tradução leiga (pt-br) dos itens da inbox do runtime do agente (Operação
 * Visível F1). `kind` é contrato do engine (agent_inbox_items.kind, migration
 * 0050) — a central de avisos mostra o que aconteceu sem jargão.
 */

import type { InboxKind } from "@/lib/agent-engine/db/repository";

export type AgentInboxSeverity = "info" | "warn" | "critical";

/**
 * `satisfies Record<InboxKind, string>` é o que faz o compilador cobrar: kind
 * novo no tipo sem rótulo aqui = erro de build. Antes isto era
 * `Record<string, string>`, que aceita qualquer chave e **não exige nenhuma** —
 * uma anotação que parecia tipagem e era o oposto dela. Foi assim que
 * `next_action_ambiguous` chegou à tela caindo no genérico "Aviso do
 * assistente": o item existia para pedir uma escolha e se anunciava sem dizer
 * de quê.
 */
export const KIND_LABEL = {
  qr_rescan: "Conexão do WhatsApp caiu — precisa escanear o QR de novo",
  job_dead: "Uma tarefa do assistente falhou e parou de tentar",
  event_dead: "Um evento recebido não pôde ser processado",
  budget_exceeded: "O orçamento de IA foi atingido",
  handoff: "O assistente passou um atendimento para um humano",
  promotion_review: "Proposta de melhoria do assistente aguardando sua revisão",
  judge_unaligned: "O avaliador de qualidade precisa de recalibragem",
  followup_dead: "Um fluxo de follow-up parou de tentar",
  snooze_expired: "O lead não respondeu no prazo que você definiu",
  next_action_ambiguous: "Próxima ação sem negócio definido — precisa da sua escolha",
  risk_backlog_seeded: "Negócios que já estavam parados — precisam de uma decisão",
  reactivation_expired: "A sugestão de retomar contato venceu — decida",
  other: "Aviso do assistente",
} as const satisfies Record<InboxKind, string>;

export const SEVERITY_LABEL: Record<AgentInboxSeverity, string> = {
  info: "informativo",
  warn: "atenção",
  critical: "crítico",
};

/**
 * O parâmetro segue `string` (não `InboxKind`) de propósito: o kind chega do
 * banco em runtime, e um clone com engine mais novo pode trazer um valor que
 * este build não conhece. O genérico é a defesa para ESSE caso — não para
 * cobrir esquecimento, que agora o compilador pega acima.
 */
export function kindLabel(kind: string): string {
  return (KIND_LABEL as Record<string, string>)[kind] ?? "Aviso do assistente";
}
