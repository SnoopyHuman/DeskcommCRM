"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { BulkLeadActionInput } from "@/lib/schemas/leads";
import { liberarEcoLocal, marcarEcoLocal } from "@/lib/kanban/local-echo";

export function useBulkAction(pipelineId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: BulkLeadActionInput) => {
      // O terceiro caminho de mutação — e o que eu tinha esquecido: sem marcar
      // aqui, a aba de quem executou a ação em massa pulsava junto com as
      // outras, como se a própria ação fosse novidade vinda de fora.
      for (const leadId of input.lead_ids) marcarEcoLocal(leadId);
      return apiClient.post<{ data: { updated_count: number } }>(
        "/api/v1/leads/bulk",
        input,
      );
    },
    onError: showApiError,
    onSettled: (_data, _err, input) => {
      for (const leadId of input.lead_ids) liberarEcoLocal(leadId);
      qc.invalidateQueries({ queryKey: ["board", pipelineId] });
    },
  });
}
