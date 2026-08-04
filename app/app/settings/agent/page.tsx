import { InboundDebounceCard } from "./_components/InboundDebounceCard";

export const metadata = { title: "Comportamento do agente" };
export const dynamic = "force-dynamic";

/**
 * Settings de comportamento do agente ao nível da organização (Onda 5).
 * Debounce de rajada é org-level — o drain resolve antes do agente publicado.
 */
export default function AgentSettingsPage() {
  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Comportamento do agente</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Como o agente agrupa e responde mensagens nesta organização.
        </p>
      </div>
      <InboundDebounceCard />
    </div>
  );
}
