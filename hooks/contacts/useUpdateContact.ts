"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Contact } from "@/lib/types/contacts";
import type { ContactPatch } from "@/lib/schemas/contacts";

export function useUpdateContact(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: ContactPatch) =>
      apiClient.patch<{ data: Contact }>(`/api/v1/contacts/${id}`, patch),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contact", id] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      // O Inbox (CRMSidePanel) lê o contato via conversation.contacts, não via
      // ["contact", id] — sem isto, editar tags/nome do contato por aqui não
      // refletia na tela até trocar de conversa (parecia "não fez nada").
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}
