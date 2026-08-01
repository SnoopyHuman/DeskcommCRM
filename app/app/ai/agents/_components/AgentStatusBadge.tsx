"use client";
import { Badge } from "@/components/ui/badge";
import type { AgentRow } from "@/hooks/ai/useAgent";

export type AgentStatus = "published" | "draft" | "paused" | "archived" | "invalid";

/**
 * "Publicado" tem que significar "está no ar", e quem decide isso é o runtime:
 * tanto o dispatcher do CRM quanto o agent-engine só enxergam o agente pelo
 * `join ai_agent_versions on v.id = a.published_version_id`. Sem versão
 * publicada, o agente não responde a nada.
 *
 * Antes, para os agentes que não são `mcp_agent`, o badge saía apenas de
 * `is_active` — e o agente criado no onboarding (ativo, sem versão) aparecia
 * como "Publicado" enquanto era invisível para os dois runtimes. O dono do CRM
 * terminava a instalação achando que tinha um atendente de IA no ar.
 *
 * `is_active` não é a semântica de pausa do `mcp_agent`: `pauseAgentAction`
 * nunca escreve nesse campo para esse kind (só limpa `published_version_id` e
 * supersede a versão) — e `unpauseAgentAction` recusa mexer nele também
 * ("publique uma versão para reativar"). Um `mcp_agent` com versão publicada
 * e `is_active=false` (dado órfão de antes dessa separação existir) é um
 * agente NO AR mostrando "Pausado" — o inverso do achado 39 (agente pausado
 * que seguia gastando): aqui o agente gasta e responde de verdade, mas a tela
 * mente que está parado.
 */
export function deriveAgentStatus(agent: AgentRow): AgentStatus {
  if (agent.archived_at) return "archived";
  if (!agent.published_version_id) return "draft";
  if (agent.kind === "mcp_agent") return "published";
  return agent.is_active ? "published" : "paused";
}

const LABEL: Record<AgentStatus, string> = {
  published: "Publicado",
  draft: "Rascunho",
  paused: "Pausado",
  archived: "Arquivado",
  invalid: "Inválido",
};

const VARIANT: Record<AgentStatus, "default" | "secondary" | "outline" | "destructive"> = {
  published: "default",
  draft: "secondary",
  paused: "outline",
  archived: "outline",
  invalid: "destructive",
};

export function AgentStatusBadge({ status }: { status: AgentStatus }) {
  return (
    <Badge variant={VARIANT[status]} aria-label={`status: ${LABEL[status]}`}>
      {LABEL[status]}
    </Badge>
  );
}
