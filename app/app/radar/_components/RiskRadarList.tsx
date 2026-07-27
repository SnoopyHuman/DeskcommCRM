"use client";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useClaimConversation } from "@/hooks/inbox/useClaimConversation";
import { useAtRiskLeads, type AtRiskLead } from "@/hooks/leads/useAtRiskLeads";
import type { RiskBucket } from "@/lib/leads/risk-radar";
import {
  ArrowRight,
  CheckCircle,
  ClockCountdown,
  PaperPlaneTilt,
  Warning,
} from "@/lib/ui/icons";

const RISK_META: Record<
  Exclude<RiskBucket, "em_dia">,
  { label: string; variant: "error" | "warning" | "info" }
> = {
  critico: { label: "Crítico", variant: "error" },
  em_risco: { label: "Em risco", variant: "warning" },
  em_voo: { label: "Em voo", variant: "info" },
};

function coldFor(hours: number): string {
  if (hours < 48) return `parado há ${hours}h`;
  return `parado há ${Math.round(hours / 24)}d`;
}

function followupWhen(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return "agora";
  const hours = Math.round(diffMs / 3_600_000);
  if (hours < 48) return `em ${Math.max(1, hours)}h`;
  return `em ${Math.round(hours / 24)}d`;
}

export function RiskRadarList() {
  const { data, isLoading } = useAtRiskLeads();

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (!data || data.total === 0) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center"
        data-testid="radar-empty"
      >
        <CheckCircle size={28} className="text-success-fg/70" aria-hidden />
        <p className="text-sm font-medium">Nenhuma demanda em risco</p>
        <p className="text-xs text-muted-foreground">
          Toda demanda aberta teve atividade recente ou já tem um retorno agendado.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap gap-2" data-testid="radar-counts">
        <Badge variant="error">{data.counts.critico} crítico</Badge>
        <Badge variant="warning">{data.counts.em_risco} em risco</Badge>
        <Badge variant="info">{data.counts.em_voo} em voo</Badge>
      </div>

      <ul className="divide-y divide-border rounded-lg border border-border">
        {data.items.map((lead) => (
          <RadarRow key={lead.id} lead={lead} />
        ))}
      </ul>
    </div>
  );
}

function RadarRow({ lead }: { lead: AtRiskLead }) {
  const meta = RISK_META[lead.risk as Exclude<RiskBucket, "em_dia">] ?? RISK_META.em_risco;
  const href = lead.conversation_id
    ? `/app/inbox?id=${lead.conversation_id}`
    : `/app/pipelines/${lead.pipeline_id}`;

  const claim = useClaimConversation();
  const qc = useQueryClient();

  // Dono do NEGÓCIO — humano OU agente (0070). Antes desta linha o radar lia só
  // `owner_user_id`, então um lead que a IA trabalha há dezenas de turnos aparecia
  // como "Sem dono" e mandava um humano resgatar o que já estava sendo tocado.
  // A distinção é a MESMA do card (OwnerBadge): geométrica, nunca ícone de robô —
  // uma fonte de verdade para "quem é o dono", em todas as telas.
  const dono =
    lead.owner_kind === "ai"
      ? `Agente: ${lead.owner_agent_name ?? "sem nome"}`
      : lead.owner_user_id || lead.assignee_kind === "user"
        ? "Com atendente"
        : lead.assignee_kind === "ai"
          ? "Assistente na conversa"
          : "Sem dono";

  // "Assumir" é tirar da IA e trazer para si: continua valendo enquanto não há
  // dono HUMANO — dono agente não bloqueia o handoff, é justamente o caso dele.
  const ownedByHuman = Boolean(lead.owner_user_id) || lead.assignee_kind === "user";
  const canClaim = Boolean(lead.conversation_id) && !ownedByHuman;

  function handleClaim() {
    if (!lead.conversation_id) return;
    claim.mutate(
      { conversation_id: lead.conversation_id },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: ["leads-at-risk"] });
          toast.success("Você assumiu a demanda");
        },
      },
    );
  }

  return (
    <li
      data-testid="radar-item"
      data-risk={lead.risk}
      className="flex items-start gap-2 pr-3 transition-colors hover:bg-accent/50"
    >
      <Link href={href} className="flex min-w-0 flex-1 items-start gap-3 px-4 py-3">
        <Badge variant={meta.variant} className="mt-0.5 shrink-0">
          {meta.label}
        </Badge>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{lead.title}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {lead.contact_name ? <span className="truncate">{lead.contact_name}</span> : null}
            <span className="inline-flex items-center gap-1">
              <ClockCountdown size={13} aria-hidden />
              {coldFor(lead.hours_since_activity)}
            </span>
            <span className="inline-flex items-center gap-1" data-testid="radar-assignee">
              {dono}
            </span>
          </p>
          {lead.in_flight && lead.next_followup_at ? (
            <p className="mt-1 inline-flex items-center gap-1 text-xs text-info-fg">
              <PaperPlaneTilt size={13} aria-hidden />
              Assistente retorna {followupWhen(lead.next_followup_at)}
            </p>
          ) : (
            <p className="mt-1 inline-flex items-center gap-1 text-xs text-warning-fg">
              <Warning size={13} aria-hidden />
              Sem próximo passo agendado
            </p>
          )}
        </div>
      </Link>
      <div className="flex shrink-0 items-center gap-2 self-center">
        {canClaim ? (
          <Button
            size="sm"
            variant="outline"
            disabled={claim.isPending}
            onClick={handleClaim}
            data-testid="radar-claim"
          >
            Assumir
          </Button>
        ) : null}
        <ArrowRight size={16} className="text-muted-foreground" aria-hidden />
      </div>
    </li>
  );
}
