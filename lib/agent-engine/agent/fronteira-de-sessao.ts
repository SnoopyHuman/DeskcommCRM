/**
 * O corte é pelo SILÊNCIO, não pela idade da mensagem.
 *
 * "Últimas 6 horas" cortaria ao meio uma conversa contínua de dez horas — e
 * perder a primeira metade de um papo em andamento é pior que lembrar demais.
 * O que marca o fim de uma sessão é o intervalo entre duas mensagens
 * consecutivas: retomou depois de N horas, começou sessão nova.
 *
 * Pura e determinística de propósito (Spec 16 §4) — nunca lê relógio, só o
 * que já está no array. Desligar a fronteira é passar `gapHoras: null`.
 */
export function cortarNaFronteiraDeSessao<T extends { sent_at: string }>(
  /** Da mais ANTIGA para a mais nova (como sai de getLeadContext). */
  mensagens: T[],
  gapHoras: number | null,
): T[] {
  if (gapHoras === null || gapHoras <= 0 || mensagens.length < 2) return mensagens;
  const gapMs = gapHoras * 3_600_000;

  // Varre do fim para o começo: o primeiro silêncio encontrado é o mais
  // recente, e é ele que abre a sessão atual.
  for (let i = mensagens.length - 1; i > 0; i--) {
    const atual = Date.parse(mensagens[i]!.sent_at);
    const anterior = Date.parse(mensagens[i - 1]!.sent_at);
    if (Number.isNaN(atual) || Number.isNaN(anterior)) continue;
    if (atual - anterior >= gapMs) return mensagens.slice(i);
  }
  return mensagens;
}
