"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { liberarEcoLocal, marcarEcoLocal } from "@/lib/kanban/local-echo";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Lead } from "@/lib/types/leads";
import type { UpdateLeadInput } from "@/lib/schemas/leads";

interface WinArgs {
  leadId: string;
}
interface LoseArgs {
  leadId: string;
  lostReason: string;
}

export function useWinLead(pipelineId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ leadId }: WinArgs) => {
      marcarEcoLocal(leadId);
      return apiClient.post<{ data: Lead }>(`/api/v1/leads/${leadId}/win`, {});
    },
    onError: showApiError,
    onSettled: (_data, _err, { leadId }) => {
      liberarEcoLocal(leadId);
      qc.invalidateQueries({ queryKey: ["board", pipelineId] });
    },
  });
}

export function useLoseLead(pipelineId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ leadId, lostReason }: LoseArgs) => {
      marcarEcoLocal(leadId);
      return apiClient.post<{ data: Lead }>(`/api/v1/leads/${leadId}/lose`, {
        lost_reason: lostReason,
      });
    },
    onError: showApiError,
    onSettled: (_data, _err, { leadId }) => {
      liberarEcoLocal(leadId);
      qc.invalidateQueries({ queryKey: ["board", pipelineId] });
    },
  });
}

interface EditArgs {
  leadId: string;
  patch: UpdateLeadInput;
}

export function useEditLead(pipelineId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ leadId, patch }: EditArgs) => {
      // Minha própria ação não pulsa: o feedback dela já é a mudança na tela.
      marcarEcoLocal(leadId);
      return apiClient.patch<{ data: Lead }>(`/api/v1/leads/${leadId}`, patch);
    },
    onError: showApiError,
    onSettled: (_data, _err, { leadId }) => {
      liberarEcoLocal(leadId);
      qc.invalidateQueries({ queryKey: ["board", pipelineId] });
    },
  });
}
