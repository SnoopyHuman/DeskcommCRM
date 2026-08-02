"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";

interface HardResetBody {
  contactId: string;
  confirmation: "APAGAR";
  purge_knowledge_base?: boolean;
  reason?: string;
}

interface HardResetResponse {
  data: {
    contact_id: string;
    deleted: {
      conversations: number;
      lead_checkpoints: number;
      lead_state: number;
      jobs_canceled: number;
      ai_chunks: number;
    };
    notes_reparented: number;
  };
}

export function useHardResetContext() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ contactId, ...body }: HardResetBody) =>
      apiClient.post<HardResetResponse>(
        `/api/v1/contacts/${contactId}/context/hard-reset`,
        body,
      ),
    onError: showApiError,
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["contact", vars.contactId] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["timeline", vars.contactId] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}
