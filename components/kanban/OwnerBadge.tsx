import { Badge } from "@/components/ui/badge";
import type { OwnerKind } from "@/lib/types/leads";

/** Iniciais a partir do nome (primeira + última palavra). */
export function ownerInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * Exibe o responsável (owner) de um lead — humano ou agente de IA (0070).
 * Presentacional e sem dnd, testável em isolamento.
 *
 * O agente é PAR do humano, não um enfeite: mesmo diâmetro, mesmo peso, mesma
 * posição. A única diferença é a forma — humano = disco preenchido; agente =
 * círculo vazado com anel e inicial em mono. Nada de emoji, badge "AI"
 * colorido ou gradiente: a distinção é geométrica, não decorativa, e por isso
 * sobrevive ao daltonismo e ao teste do metro.
 */
export function OwnerBadge({
  ownerKind,
  ownerName,
  agentVersion,
}: {
  ownerKind: OwnerKind;
  ownerName: string | null;
  /** Versão publicada do agente no momento da exibição (nunca congelada no lead). */
  agentVersion?: number | null;
}) {
  if (!ownerKind) {
    // Mesma geometria dos outros dois estados (disco de 24px + rótulo), para o
    // rodapé do card não mudar de altura conforme o lead tem dono ou não.
    return (
      <div className="flex items-center gap-1.5" aria-label="Sem responsável">
        <span
          className="h-6 w-6 shrink-0 rounded-full border border-dashed border-border-strong"
          aria-hidden
        />
        <span className="truncate text-xs text-text-muted">Sem responsável</span>
      </div>
    );
  }

  const isAgent = ownerKind === "ai";
  const label = ownerName ?? (isAgent ? "Agente" : "Responsável");
  const versionSuffix = isAgent && agentVersion != null ? ` · v${agentVersion}` : "";
  const fullLabel = `${label}${versionSuffix}`;

  return (
    <div
      className="flex items-center gap-1.5"
      aria-label={`Responsável: ${fullLabel}`}
      title={fullLabel}
    >
      <span
        className={
          isAgent
            ? // Vazado com anel: o fundo do card atravessa o disco.
              "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-accent bg-surface font-mono text-[10px] font-semibold text-accent ring-1 ring-inset ring-accent/40"
            : // Preenchido SÓLIDO: a um metro, o humano é uma mancha escura e o
              // agente é um anel claro. Contraste que não depende da borda —
              // fundo suave fazia os dois lerem como "círculo claro".
              "flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-[10px] font-semibold text-accent-foreground"
        }
        aria-hidden
      >
        {ownerName ? ownerInitials(ownerName) : "?"}
      </span>
      <span className="max-w-[9rem] truncate text-xs text-text-muted">{label}</span>
    </div>
  );
}
