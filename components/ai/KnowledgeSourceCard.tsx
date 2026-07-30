"use client";
import { HelpCircle, ShieldCheck, MessageSquare, Package, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SourceStatusBadge, deriveBadgeStatus } from "@/components/ai/SourceStatusBadge";
import type { SourceRow } from "@/hooks/ai/useKnowledgeSources";

export type KnowledgeSourceType = "faq" | "policy" | "conversations" | "catalog";

interface Props {
  source?: SourceRow | null;
  type: KnowledgeSourceType;
  onReindex?: () => void;
  isReindexing?: boolean;
}

const TYPE_META: Record<
  KnowledgeSourceType,
  { label: string; Icon: typeof HelpCircle; description: string }
> = {
  faq: {
    label: "FAQ",
    Icon: HelpCircle,
    description: "Perguntas frequentes do tenant.",
  },
  policy: {
    label: "Política",
    Icon: ShieldCheck,
    description: "Documento PDF de políticas (troca, devolução, privacidade).",
  },
  conversations: {
    label: "Conversas opt-in",
    Icon: MessageSquare,
    description: "Conversas anonimizadas para aprendizado.",
  },
  catalog: {
    label: "Catálogo",
    Icon: Package,
    description: "Produtos sincronizados do e-commerce.",
  },
};

function formatRelative(iso: string | null): string {
  if (!iso) return "Nunca indexado";
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 60) return "agora há pouco";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `há ${diffMin} min`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `há ${diffHr} h`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `há ${diffDay} d`;
  return new Date(iso).toLocaleDateString("pt-BR");
}

export function KnowledgeSourceCard({ source, type, onReindex, isReindexing }: Props) {
  const meta = TYPE_META[type];
  const Icon = meta.Icon;

  // Empty state.
  if (!source) {
    return (
      <Card className="flex h-full flex-col">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Icon className="h-5 w-5 text-text-muted" aria-hidden />
            <CardTitle className="text-base">{meta.label}</CardTitle>
          </div>
          <p className="text-sm text-text-muted">{meta.description}</p>
        </CardHeader>
        {/* O botão "Configurar" era um stub: `disabled` fixo com um
            onClick de toast "Em breve." que, por estar desabilitado, NUNCA
            aparecia. O usuário via um botão morto e nenhuma explicação — e
            saía achando que a base de conhecimento existia e estava vazia por
            culpa dele. Enquanto a criação por aqui não existe, a tela diz o
            que é verdade. */}
        <CardContent className="flex-1 space-y-2">
          <p className="text-sm text-text-muted">Nenhuma fonte configurada.</p>
          <p className="text-xs text-text-muted">
            Cadastrar {meta.label.toLowerCase()} por esta tela ainda não está
            disponível. Enquanto isso, dá para criar pela API
            (<code>POST /api/v1/ai/knowledge/sources</code>) — e o agente segue
            atendendo normalmente, só sem consultar esta base.
          </p>
        </CardContent>
        <CardFooter>
          <span className="rounded-sm border border-border px-2 py-1 text-xs text-text-muted">
            Em breve
          </span>
        </CardFooter>
      </Card>
    );
  }

  const derived = deriveBadgeStatus(source);
  const reindexBlocked = derived === "archived" || isReindexing;
  const showError = derived === "failed" && source.last_index_error;

  const extraButton = (() => {
    if (type === "faq") {
      return (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => toast.info("Editor de FAQ em breve.")}
        >
          Editar conteúdo
        </Button>
      );
    }
    if (type === "policy") {
      return (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => toast.info("Upload de política em breve.")}
        >
          Upload novo arquivo
        </Button>
      );
    }
    return null;
  })();

  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Icon className="h-5 w-5 text-accent" aria-hidden />
            <CardTitle className="text-base">{source.name || meta.label}</CardTitle>
          </div>
          <SourceStatusBadge source={source} />
        </div>
        <p className="text-sm text-text-muted">{meta.description}</p>
      </CardHeader>
      <CardContent className="flex-1 space-y-2 text-sm">
        <div className="flex items-baseline justify-between">
          <span className="text-text-muted">Última indexação</span>
          <span>{formatRelative(source.last_indexed_at)}</span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-text-muted">Chunks indexados</span>
          <span>{source.chunks_count}</span>
        </div>
        {showError ? (
          <details className="rounded-md border border-error-bg bg-error-bg/30 p-2 text-xs text-error-fg">
            <summary className="cursor-pointer font-medium">Detalhes do erro</summary>
            <p className="mt-1 whitespace-pre-wrap break-words">{source.last_index_error}</p>
          </details>
        ) : null}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={reindexBlocked}
          onClick={onReindex}
        >
          <RefreshCw className={`mr-2 h-3.5 w-3.5 ${isReindexing ? "animate-spin" : ""}`} aria-hidden />
          {isReindexing ? "Reindexando..." : "Re-indexar"}
        </Button>
        {extraButton}
      </CardFooter>
    </Card>
  );
}
