"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { InboundDebounceConfig } from "@/lib/schemas/inbound-debounce";

export type InboundDebounceStatus = InboundDebounceConfig & {
  env_default_ms: number;
  bounds: { window_ms_min: number; window_ms_max: number; max_window_ms_max: number };
};

interface SingleResponse {
  data: InboundDebounceStatus | InboundDebounceConfig;
}

export const inboundDebounceQueryKey = ["settings", "inbound-debounce"] as const;

export function useInboundDebounce() {
  return useQuery({
    queryKey: inboundDebounceQueryKey,
    queryFn: async () => {
      try {
        const res = await apiClient.get<SingleResponse>("/api/v1/settings/inbound-debounce");
        return res.data as InboundDebounceStatus;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    staleTime: 30_000,
  });
}

export function useUpdateInboundDebounce() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["settings", "inbound-debounce", "update"],
    mutationFn: async (patch: Partial<InboundDebounceConfig>) => {
      const res = await apiClient.patch<SingleResponse>("/api/v1/settings/inbound-debounce", patch);
      return res.data as InboundDebounceConfig;
    },
    onSuccess: (data) => {
      qc.setQueryData(inboundDebounceQueryKey, (prev: InboundDebounceStatus | undefined) =>
        prev ? { ...prev, ...data } : undefined,
      );
      toast.success("Agrupamento de mensagens atualizado");
    },
    onError: (err) => showApiError(err),
  });
}
