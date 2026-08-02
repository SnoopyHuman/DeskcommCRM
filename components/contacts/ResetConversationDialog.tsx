"use client";
import { useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api/types";
import { useHardResetContext } from "@/hooks/contacts/useHardResetContext";

interface Props {
  contactId: string;
  contactName: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const CONFIRM_TEXT = "APAGAR";

/** Spec 16 §9.3 — mensagem exata do erro de caso aberto. */
export const OPEN_CASE_BLOCKS_RESET_MESSAGE =
  "Existe um caso aberto para este contato. Resolva o caso antes de apagar o contexto — senão quem estiver cuidando dele perde a referência.";

export function ResetConversationDialog({
  contactId,
  contactName,
  open,
  onOpenChange,
}: Props) {
  const reset = useHardResetContext();
  const [confirm, setConfirm] = useState("");
  const [purgeKb, setPurgeKb] = useState(false);
  const [caseError, setCaseError] = useState<string | null>(null);

  function resetForm() {
    setConfirm("");
    setPurgeKb(false);
    setCaseError(null);
  }

  async function handleSubmit() {
    setCaseError(null);
    try {
      await reset.mutateAsync({
        contactId,
        confirmation: CONFIRM_TEXT,
        purge_knowledge_base: purgeKb,
      });
      toast.success("Contexto apagado.");
      resetForm();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === "open_case_blocks_reset") {
        setCaseError(OPEN_CASE_BLOCKS_RESET_MESSAGE);
        return;
      }
      // hook handles toast for demais erros
    }
  }

  function handleOpenChange(v: boolean) {
    if (!v) resetForm();
    onOpenChange(v);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Apagar o contexto deste contato</DialogTitle>
          <DialogDescription>
            Isso apaga as mensagens, o resumo, as notas e o estado do funil da
            IA para <strong>{contactName}</strong>. O contato e o negócio
            continuam existindo, com toda a ficha e o histórico de pedidos.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <p className="rounded-md border border-error-fg/30 bg-error-bg p-3 text-sm text-error-fg">
            Esta ação não pode ser desfeita.
          </p>

          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={purgeKb}
              onChange={(e) => setPurgeKb(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-border"
            />
            <span>
              Remover também o que a IA aprendeu dessas conversas na base de
              conhecimento
              <span className="mt-1 block text-xs text-muted-foreground">
                Marque se estas conversas foram testes e não devem servir de
                referência para outros atendimentos.
              </span>
            </span>
          </label>

          <div className="space-y-2">
            <Label htmlFor="reset-confirm">
              Digite <strong>{CONFIRM_TEXT}</strong> para confirmar
            </Label>
            <Input
              id="reset-confirm"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={CONFIRM_TEXT}
              autoComplete="off"
            />
          </div>

          {caseError && (
            <p role="alert" className="text-sm text-error-fg">
              {caseError}
            </p>
          )}

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => handleOpenChange(false)}
              disabled={reset.isPending}
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={handleSubmit}
              disabled={confirm !== CONFIRM_TEXT || reset.isPending}
            >
              {reset.isPending ? "Apagando…" : "Apagar contexto"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
