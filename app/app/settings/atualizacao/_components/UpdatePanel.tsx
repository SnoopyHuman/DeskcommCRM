"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { useSystemVersion } from "@/hooks/system/useSystemVersion";
import { markdownParaTextoSimples } from "@/lib/system/changelog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const COMANDO_MANUAL = "cd DeskcommCRM && bash hostgator-setup-kit/update.sh";

const PASSOS = [
  { chave: "backup", texto: "Guardando uma cópia de segurança dos seus dados" },
  { chave: "codigo", texto: "Baixando a versão nova" },
  { chave: "banco", texto: "Atualizando o banco de dados" },
  { chave: "app", texto: "Reiniciando o sistema" },
] as const;

export function UpdatePanel() {
  const { data, isError } = useSystemVersion({ refetchInterval: 5_000 });
  const queryClient = useQueryClient();
  const [erro, setErro] = useState<string | null>(null);

  const atualizar = useMutation({
    mutationFn: async () => apiClient.post("/api/v1/system/update", {}),
    onSuccess: () => {
      setErro(null);
      queryClient.invalidateQueries({ queryKey: ["system-version"] });
    },
    onError: (err) => {
      // 409 é estado de negócio ("já tem um run rodando" / "já está em dia"),
      // não falha técnica — mostra a mensagem que a API já escreveu em
      // português em vez de um genérico "tente de novo".
      const mensagem =
        err instanceof ApiError && err.status === 409
          ? err.message
          : "Não consegui iniciar a atualização. Tente de novo em instantes.";
      setErro(mensagem);
    },
  });

  // O app reinicia no meio da atualização: a requisição falhar aqui é
  // ESPERADA, não é erro. Só é erro de verdade se nunca houve run em curso.
  const rodando = data?.run?.status === "dispatched";
  if (isError && rodando) return <Reiniciando />;
  if (!data) {
    return (
      <Layout>
        <p className="text-sm text-muted-foreground">Carregando…</p>
      </Layout>
    );
  }

  const versao = data.current_version.replace(/^v/i, "");
  const nova = data.latest_version?.replace(/^v/i, "") ?? "";

  if (rodando) {
    return (
      <Layout titulo={`Atualizando para a versão ${nova}`}>
        <ol className="space-y-2 text-sm">
          {PASSOS.map((passo) => {
            const indice = PASSOS.findIndex((p) => p.chave === data.run?.last_step);
            const atual = PASSOS.findIndex((p) => p.chave === passo.chave);
            const feito = indice >= 0 && atual <= indice;
            return (
              <li key={passo.chave} className={feito ? "text-foreground" : "text-muted-foreground"}>
                {feito ? "✓" : "○"} {passo.texto}
              </li>
            );
          })}
        </ol>
        <p className="mt-4 text-sm text-muted-foreground">
          O sistema sai do ar por alguns instantes e volta sozinho. Pode deixar esta página aberta.
        </p>
      </Layout>
    );
  }

  if (data.run?.status === "failed" || data.run?.status === "failed_rolled_back") {
    return (
      <Layout titulo="A atualização não deu certo">
        <p className="text-sm">
          Voltei para a versão anterior ({versao}) e os seus dados estão intactos. O banco de dados
          já tinha sido atualizado e permanece assim — isso é seguro, a versão anterior funciona com
          ele. Se quiser desfazer também o banco, use a cópia de segurança feita antes da tentativa
          (<code>bash hostgator-setup-kit/restore.sh</code>).
        </p>
        {/* Sem isto a pessoa fica presa nesta tela pra sempre, mesmo com uma
            versão nova esperando — um beco sem saída. */}
        {data.update_available && (
          <div className="mt-4">
            <BotaoAtualizar mutate={() => atualizar.mutate()} isPending={atualizar.isPending} erro={erro} />
          </div>
        )}
      </Layout>
    );
  }

  if (data.run?.status === "unknown") {
    return (
      <Layout titulo="Não sei dizer como terminou">
        <p className="text-sm">
          Comecei a atualização mas perdi contato com o servidor antes do fim. Confira se o sistema
          está funcionando normalmente. Se estiver, provavelmente deu certo — a versão instalada
          aparece aqui: <strong>{versao}</strong>.
        </p>
        {data.update_available && (
          <div className="mt-4">
            <BotaoAtualizar mutate={() => atualizar.mutate()} isPending={atualizar.isPending} erro={erro} />
          </div>
        )}
      </Layout>
    );
  }

  if (!data.agent_online) {
    return (
      <Layout titulo="Atualização automática indisponível">
        <p className="text-sm">
          Não estou conseguindo falar com o servidor onde o sistema está instalado, então não posso
          atualizar sozinho. Quem tem acesso ao servidor pode rodar este comando uma vez — depois
          disso o botão passa a funcionar:
        </p>
        <Comando />
        <p className="mt-3 text-sm text-muted-foreground">Versão instalada: {versao}.</p>
      </Layout>
    );
  }

  if (!data.update_available && !data.off_release) {
    return (
      <Layout titulo={`Você está na versão ${versao}`}>
        <p className="text-sm text-muted-foreground">É a mais recente. Não há nada a fazer.</p>
      </Layout>
    );
  }

  return (
    <Layout titulo={`Versão ${nova} disponível`}>
      {data.off_release && (
        <p className="mb-4 rounded-md border border-warning bg-warning-bg p-3 text-sm text-warning-fg">
          Sua instalação está numa versão de desenvolvimento. Atualizar vai levá-la para a versão
          publicada {nova}.
        </p>
      )}

      {data.notes?.requires_attention && (
        <div className="mb-4 rounded-md border border-warning bg-warning-bg p-3 text-sm text-warning-fg">
          <p className="mb-1 font-medium">⚠️ Requer atenção</p>
          <p className="whitespace-pre-line">
            {markdownParaTextoSimples(data.notes.requires_attention)}
          </p>
        </div>
      )}

      {data.notes?.body && (
        <div className="mb-6">
          <p className="mb-2 text-sm font-medium">O que muda</p>
          <pre className="whitespace-pre-wrap font-sans text-sm text-muted-foreground">
            {markdownParaTextoSimples(data.notes.body)}
          </pre>
        </div>
      )}

      <BotaoAtualizar mutate={() => atualizar.mutate()} isPending={atualizar.isPending} erro={erro} />
    </Layout>
  );
}

function BotaoAtualizar({
  mutate,
  isPending,
  erro,
}: {
  mutate: () => void;
  isPending: boolean;
  erro: string | null;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={mutate} disabled={isPending}>
          {isPending ? "Iniciando…" : "Atualizar agora"}
        </Button>
        <span className="text-sm text-muted-foreground">
          O sistema sai do ar por cerca de 2 minutos e volta sozinho. Faço uma cópia de segurança
          dos seus dados antes.
        </span>
      </div>
      {erro && <p className="mt-3 text-sm text-error-fg">{erro}</p>}
    </>
  );
}

function Layout({ titulo, children }: { titulo?: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {titulo ?? "Atualização do sistema"}
        </h1>
      </header>
      <Card className="p-6">{children}</Card>
    </div>
  );
}

function Reiniciando() {
  return (
    <Layout titulo="Reiniciando…">
      <p className="text-sm text-muted-foreground">
        O sistema está voltando. Esta página se atualiza sozinha em alguns instantes.
      </p>
    </Layout>
  );
}

function Comando() {
  const [copiado, setCopiado] = useState(false);
  return (
    <div className="mt-3 flex items-center gap-2">
      <code className="flex-1 overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">
        {COMANDO_MANUAL}
      </code>
      <Button
        variant="outline"
        size="sm"
        onClick={async () => {
          await navigator.clipboard.writeText(COMANDO_MANUAL);
          setCopiado(true);
          setTimeout(() => setCopiado(false), 2000);
        }}
      >
        {copiado ? "Copiado" : "Copiar"}
      </Button>
    </div>
  );
}
