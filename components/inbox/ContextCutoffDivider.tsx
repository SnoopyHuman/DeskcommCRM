"use client";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { motivoDoCorte } from "@/lib/inbox/context-cutoff-label";

/**
 * Spec 16 §9.4 — divisor visual do corte de contexto na thread do inbox.
 * Não esconde nem colapsa mensagens; só marca onde a IA deixou de ler.
 */

export const CONTEXT_CUTOFF_TOOLTIP =
  "A IA não lê as mensagens acima. Você continua vendo tudo.";

interface Props {
  resetAt: string;
  reason?: string | null;
}

export function ContextCutoffDivider({ resetAt, reason }: Props) {
  const data = format(new Date(resetAt), "dd/MM/yyyy", { locale: ptBR });
  const motivo = motivoDoCorte(reason);
  const label = `Contexto reiniciado em ${data} · ${motivo}`;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            role="separator"
            aria-label={label}
            className="flex items-center gap-2 px-4 py-3"
          >
            <div className="h-px flex-1 bg-border" />
            <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
            <div className="h-px flex-1 bg-border" />
          </div>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>{CONTEXT_CUTOFF_TOOLTIP}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
