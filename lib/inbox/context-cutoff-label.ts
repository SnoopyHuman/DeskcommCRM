/**
 * Spec 16 §9.4 — rótulo do motivo no divisor da thread.
 * Pura: sem React, para poder ser testada sem montar o componente.
 */
export function motivoDoCorte(reason: string | null | undefined): string {
  if (!reason || reason === "stage_policy") return "fim de ciclo";
  // Formatos aceitos: "manual", "manual:Nome Sobrenome"
  if (reason === "manual" || reason.startsWith("manual:")) {
    const nome = reason.startsWith("manual:") ? reason.slice("manual:".length).trim() : "";
    return nome ? `reset manual por ${nome}` : "reset manual";
  }
  return reason;
}
