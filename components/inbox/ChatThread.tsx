"use client";
import { useEffect, useMemo, useRef } from "react";
import { format, isToday, isYesterday } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MessageBubble } from "./MessageBubble";
import { NoteCard } from "./NoteCard";
import { ContextCutoffDivider } from "./ContextCutoffDivider";
import { useMessagesRealtime } from "@/hooks/inbox/useMessagesRealtime";
import { useConversationNotes } from "@/hooks/inbox/useConversationNotes";
import { useDeleteNote } from "@/hooks/inbox/useDeleteNote";
import { useDebugToggle } from "@/hooks/ai/useDebugToggle";
import { useActiveOrg, useUser } from "@/hooks/auth/AuthProvider";
import { ROLE_RANK } from "@/lib/auth/types";
import type { Message, Note } from "@/lib/types/messaging";

interface Props {
  conversationId: string | null;
  /** Spec 16 §9.4 — marca de corte do contato (null = sem divisor). */
  contextResetAt?: string | null;
  contextResetReason?: string | null;
}

/** Onda 5.2: union de item do thread — mensagem real ou nota interna (nunca vai ao cliente). */
export type ThreadItem =
  | { kind: "message"; ts: string; data: Message }
  | { kind: "note"; ts: string; data: Note };

/** Intercala mensagens e notas por timestamp asc (puro, sem I/O — testado em thread-merge.test.ts). */
export function mergeThreadItems(messages: Message[], notes: Note[]): ThreadItem[] {
  const items: ThreadItem[] = [
    ...messages.map((data): ThreadItem => ({ kind: "message", ts: data.sent_at, data })),
    ...notes.map((data): ThreadItem => ({ kind: "note", ts: data.created_at, data })),
  ];
  // Sort estável (Array#sort é estável no V8/Node): empate mantém a ordem de
  // inserção acima — mensagens antes de notas no mesmo instante.
  items.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  return items;
}

/**
 * Índice onde o divisor de corte deve ser inserido: logo após o último item
 * com ts <= contextResetAt. -1 = sem divisor.
 */
export function indexDoDivisorDeCorte(
  items: ThreadItem[],
  contextResetAt: string | null | undefined,
): number {
  if (!contextResetAt) return -1;
  const cutoffMs = new Date(contextResetAt).getTime();
  if (Number.isNaN(cutoffMs)) return -1;
  let lastAtOrBefore = -1;
  for (let i = 0; i < items.length; i++) {
    if (new Date(items[i]!.ts).getTime() <= cutoffMs) lastAtOrBefore = i;
  }
  // Inserir DEPOIS do último item pré-corte (ou no início se todos forem pós-corte).
  return lastAtOrBefore + 1;
}

function dayLabel(d: Date): string {
  if (isToday(d)) return "Hoje";
  if (isYesterday(d)) return "Ontem";
  return format(d, "dd/MM/yyyy", { locale: ptBR });
}

export function ChatThread({
  conversationId,
  contextResetAt = null,
  contextResetReason = null,
}: Props) {
  const q = useMessagesRealtime(conversationId);
  const notes = useConversationNotes(conversationId);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const activeOrg = useActiveOrg();
  const currentUser = useUser();
  const deleteNote = useDeleteNote(conversationId ?? "");
  const canManage = activeOrg != null && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  const { enabled: debugCitations } = useDebugToggle(activeOrg?.role ?? null);

  const messages: Message[] = useMemo(
    () => q.data?.pages.flatMap((p) => p.data) ?? [],
    [q.data],
  );

  const items: ThreadItem[] = useMemo(
    () => mergeThreadItems(messages, notes),
    [messages, notes],
  );

  const divisorIndex = useMemo(
    () => indexDoDivisorDeCorte(items, contextResetAt),
    [items, contextResetAt],
  );

  // Scroll to bottom on first load + new message/note arrival.
  useEffect(() => {
    if (!bottomRef.current) return;
    bottomRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items.length, conversationId]);

  if (!conversationId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Selecione uma conversa
      </div>
    );
  }

  if (q.isLoading) {
    return (
      <div className="space-y-3 p-4">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-12 w-2/3" />
        ))}
      </div>
    );
  }

  if (q.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        <p>Erro ao carregar mensagens.</p>
        <Button size="sm" variant="outline" onClick={() => q.refetch()}>
          Tentar novamente
        </Button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Nenhuma mensagem nesta conversa.
      </div>
    );
  }

  // Group by day for separators (usa o timestamp do item — sent_at pra mensagem, created_at pra nota).
  // O divisor de corte é renderizado entre itens, cruzando dias se necessário.
  const groups: { key: string; date: Date; items: ThreadItem[]; startIndex: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const d = new Date(item.ts);
    const key = format(d, "yyyy-MM-dd");
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, date: d, items: [item], startIndex: i });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto py-2">
        {q.hasNextPage && (
          <div className="flex justify-center py-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => q.fetchNextPage()}
              disabled={q.isFetchingNextPage}
            >
              {q.isFetchingNextPage ? "Carregando…" : "Carregar mais antigas"}
            </Button>
          </div>
        )}

        {divisorIndex === 0 && contextResetAt && (
          <ContextCutoffDivider resetAt={contextResetAt} reason={contextResetReason} />
        )}

        {groups.map((g) => (
          <div key={g.key} className="space-y-1">
            <div className="sticky top-0 z-10 flex justify-center py-1">
              <span className="rounded-full bg-background/80 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur">
                {dayLabel(g.date)}
              </span>
            </div>
            {g.items.map((item, localIdx) => {
              const globalIdx = g.startIndex + localIdx;
              const showDividerAfter =
                contextResetAt != null && divisorIndex === globalIdx + 1;
              return (
                <div key={item.kind === "note" ? `note-${item.data.id}` : `msg-${item.data.id}`}>
                  {item.kind === "note" ? (
                    <NoteCard
                      note={item.data}
                      onDelete={
                        item.data.created_by_user_id === currentUser.id || canManage
                          ? () => deleteNote.mutate(item.data.id)
                          : undefined
                      }
                    />
                  ) : (
                    <MessageBubble
                      message={item.data}
                      debugCitations={debugCitations}
                    />
                  )}
                  {showDividerAfter && (
                    <ContextCutoffDivider
                      resetAt={contextResetAt}
                      reason={contextResetReason}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ))}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
