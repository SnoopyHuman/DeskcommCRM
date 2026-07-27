import type { RiskBucket } from "@/lib/leads/risk-radar";

/**
 * O funil do AGENTE movendo o card no funil do TENANT (wave 8, cenários 25/26).
 *
 * O agente pensa em sete passos fixos (`lead_state.stage`); o tenant nomeia os
 * dele — "Avaliação" numa clínica, "Aguardando pagamento" num e-commerce. A
 * ponte é `crm_stages.agent_stage_hint` (migration 0084).
 *
 * ⚠️ ESTE ARQUIVO NÃO ADIVINHA NADA. As três respostas possíveis são mover,
 * não mover, ou não ter para onde — e a terceira é um estado legítimo do
 * produto, não um erro a contornar.
 */

/** O que o resolvedor sabe de cada estágio do pipeline. */
export interface EstagioCandidato {
  id: string;
  name: string;
  agent_stage_hint: string | null;
  is_archived: boolean;
}

export type DestinoDoAgente =
  | { move: true; stageId: string; stageName: string }
  /**
   * `sem_mapeamento` — o pipeline não declarou nenhum estágio para este passo.
   *
   * NÃO é erro e NÃO tem fallback: mover para "o mais próximo por posição"
   * inventaria semântica que o tenant não declarou, e o negócio apareceria num
   * lugar que ninguém escolheu. O card fica onde está, e o rastro registra que
   * o agente quis mover.
   */
  | { move: false; motivo: "sem_mapeamento"; passo: string }
  /** O agente está no passo que o negócio já ocupa: nada a fazer, e não é falha. */
  | { move: false; motivo: "ja_esta_la"; passo: string };

/**
 * Para onde o negócio vai quando o agente avança para `passo`.
 *
 * ⚠️ NÃO TRATA AMBIGUIDADE, e isso é deliberado: `uniq_crm_stages_pipeline_hint`
 * (0084) torna dois estágios com o mesmo hint IMPOSSÍVEIS no banco. Tratar aqui
 * seria proteger contra um estado que não pode existir — e, pior, faria alguém
 * acreditar que pode. A recusa mora na CONFIGURAÇÃO, onde chega a quem
 * configurou e ensina; recusa no uso chegaria a um terceiro, meses depois, sem
 * contexto nenhum.
 *
 * Estágio ARQUIVADO não é destino: ele é histórico, e mandar um negócio vivo
 * para lá o esconderia do board.
 */
export function resolveDestinoDoAgente(
  estagios: EstagioCandidato[],
  passo: string,
  estagioAtualId: string,
): DestinoDoAgente {
  const alvo = estagios.find((e) => !e.is_archived && e.agent_stage_hint === passo);
  if (!alvo) return { move: false, motivo: "sem_mapeamento", passo };
  if (alvo.id === estagioAtualId) return { move: false, motivo: "ja_esta_la", passo };
  return { move: true, stageId: alvo.id, stageName: alvo.name };
}

/**
 * O texto que vai para a timeline quando o agente move o negócio.
 *
 * Nomeia os DOIS lados da tradução — o passo do agente e o estágio do tenant —
 * porque quem lê a timeline conhece só o segundo, e quem depura conhece só o
 * primeiro. "Movido para Avaliação" esconde que foi o agente; "avançou para
 * qualifying" é vocabulário que o usuário nunca viu.
 */
export function razaoDaMudancaPeloAgente(stageName: string, passo: string): string {
  return `Movido para ${stageName} pelo assistente (passo "${passo}" do atendimento)`;
}

export type { RiskBucket };

/* ────────────────────────────────────────────────────────────────────────── */

import type { SupabaseClient } from "@supabase/supabase-js";

import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import { resolveActiveLeadForContact } from "@/lib/leads/active-lead";
import { stageChangeReason } from "@/lib/leads/activity-emitter";

export interface ResultadoDaSincronizacao {
  moveu: boolean;
  motivo: "movido" | "sem_mapeamento" | "ja_esta_la" | "sem_negocio" | "ambiguo";
  leadId?: string;
  stageName?: string;
}

/**
 * O agente avançou o próprio funil — o card acompanha, se houver para onde.
 *
 * ⚠️ REUSA `resolveActiveLeadForContact`, e isso não é economia de código: o
 * funil do agente é por CONTATO e o card é por NEGÓCIO, então um contato com
 * dois negócios abertos exige decidir qual se move. A wave 4 já decidiu isso
 * para a próxima ação, e um SEGUNDO resolvedor de "qual negócio deste contato"
 * seria a doença desta entrega inteira criada de propósito — duas fontes que
 * começam iguais e divergem no primeiro ajuste.
 *
 * Ambíguo NÃO move nenhum, pela mesma razão da wave 4: mover o negócio errado é
 * pior que não mover, porque o usuário vê um card se mexendo sozinho e não tem
 * como saber por quê.
 */
export async function sincronizaEstagioDoAgente(
  admin: SupabaseClient,
  input: { organizationId: string; contactId: string; passo: string },
): Promise<ResultadoDaSincronizacao> {
  const { data: leadRows } = await admin
    .from("crm_leads")
    .select("id, organization_id, pipeline_id, stage_id, status, created_at, last_activity_at")
    .eq("organization_id", input.organizationId)
    .eq("contact_id", input.contactId);
  const candidatos = (leadRows ?? []) as Array<{
    id: string;
    organization_id: string;
    pipeline_id: string;
    stage_id: string;
    status: string;
    created_at: string;
    last_activity_at: string | null;
  }>;

  const rota = resolveActiveLeadForContact(
    candidatos.map((c) => ({
      id: c.id,
      organization_id: c.organization_id,
      pipeline_id: c.pipeline_id,
      status: c.status as "open" | "won" | "lost",
      created_at: c.created_at,
      last_activity_at: c.last_activity_at,
    })),
  );
  if (!rota.routed) {
    return { moveu: false, motivo: rota.reason === "no_open_lead" ? "sem_negocio" : "ambiguo" };
  }
  const lead = candidatos.find((c) => c.id === rota.leadId)!;

  const { data: stageRows } = await admin
    .from("crm_stages")
    .select("id, name, agent_stage_hint, is_archived")
    .eq("pipeline_id", lead.pipeline_id);

  const destino = resolveDestinoDoAgente(
    (stageRows ?? []) as EstagioCandidato[],
    input.passo,
    lead.stage_id,
  );
  if (!destino.move) return { moveu: false, motivo: destino.motivo, leadId: lead.id };

  const { data: origem } = await admin
    .from("crm_stages")
    .select("name")
    .eq("id", lead.stage_id)
    .maybeSingle();

  const { error } = await admin
    .from("crm_leads")
    .update({ stage_id: destino.stageId })
    .eq("id", lead.id)
    // Trava otimista pelo estágio de ORIGEM: se um humano arrastou o card entre
    // a leitura e a escrita, o agente não atropela a decisão dele.
    .eq("stage_id", lead.stage_id);
  if (error) return { moveu: false, motivo: "ja_esta_la", leadId: lead.id };

  // A atividade usa o MESMO `stageChangeReason` do arrasto humano — a timeline
  // não deve ter duas gramáticas para o mesmo acontecimento. Quem moveu está no
  // ATOR, que é onde essa informação pertence.
  const atividade = await emitLeadActivity(admin, {
    organizationId: input.organizationId,
    leadId: lead.id,
    contactId: input.contactId,
    type: "stage_changed",
    sourceModule: "crm",
    sourceId: lead.id,
    actor: { type: "webhook_source", id: "agent-stage-sync" },
    reason: stageChangeReason(
      (origem as { name: string } | null)?.name ?? null,
      destino.stageName,
    ),
    payload: { passo_do_agente: input.passo, de: lead.stage_id, para: destino.stageId },
  });
  if (!atividade.ok) {
    await registraFalhaDeAtividade(admin, {
      organizationId: input.organizationId,
      leadId: lead.id,
      tipo: "stage_changed",
      origem: "lib/leads/agent-stage-sync",
      erro: atividade.error,
    });
  }

  return { moveu: true, motivo: "movido", leadId: lead.id, stageName: destino.stageName };
}
