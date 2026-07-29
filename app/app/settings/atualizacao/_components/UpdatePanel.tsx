"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { copyToClipboard } from "@/lib/clipboard";
import { useSystemVersion } from "@/hooks/system/useSystemVersion";
import { markdownParaTextoSimples } from "@/lib/system/changelog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

// Sem `cd <pasta>`: o instalador não fixa o nome da pasta do clone
// (REPO_DIR é configurável, default "deskcommcrm" minúsculo) — quem tem
// acesso ao servidor já sabe entrar na pasta onde instalou.
const COMANDO_MANUAL = "bash hostgator-setup-kit/update.sh";
// Depois de uma tentativa que falhou, o código do servidor JÁ está na versão
// nova (a troca acontece antes de o app subir) — sem `--force`, o script
// responde "você já está na versão mais recente" e não faz nada, deixando o
// sistema parado no que quebrou.
const COMANDO_APOS_FALHA = "bash hostgator-setup-kit/update.sh --force";

/** Tira o "v" das versões: a tela fala "1.1.0", não "v1.1.0". */
function semV(versao: string | undefined): string {
  return (versao ?? "").replace(/^v/i, "");
}

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

  const versao = semV(data.current_version);
  const nova = semV(data.latest_version);

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

  // As versões de uma falha vêm do RUN, nunca de `current_version`: essa
  // última é o `git describe` do host, e a troca de código já tinha
  // acontecido quando o app quebrou — ela nomeia a versão que FALHOU. O run
  // sabe de onde saiu e para onde tentou ir.
  const alvo = semV(data.run?.to_version);
  const anterior = semV(data.run?.from_version);

  if (data.run?.status === "failed_rolled_back") {
    return (
      <Layout titulo={`A atualização para a versão ${alvo} não deu certo`}>
        <p className="text-sm">
          Voltei o sistema para a versão {anterior}, que é a que está no ar agora, e os seus dados
          estão intactos. O banco de dados já tinha sido atualizado e permanece assim — isso é
          seguro, a versão {anterior} funciona com ele. Se quiser desfazer também o banco, use a
          cópia de segurança feita antes da tentativa (
          <code>bash hostgator-setup-kit/restore.sh</code>).
        </p>
        <DetalhesTecnicos texto={data.run.log_tail} />
        <Saida
          botao={false}
          mutate={() => atualizar.mutate()}
          isPending={atualizar.isPending}
          erro={erro}
          texto="Se quiser tentar de novo, quem tem acesso ao servidor pode rodar:"
          comando={COMANDO_APOS_FALHA}
        />
      </Layout>
    );
  }

  if (data.run?.status === "failed") {
    return (
      <Layout titulo={`A atualização para a versão ${alvo} não deu certo`}>
        <p className="text-sm">
          E eu <strong>não consegui</strong> voltar sozinho para a versão {anterior}: o sistema pode
          estar rodando a versão {alvo} com defeito, ou fora do ar. Seus dados estão intactos e a
          cópia de segurança feita antes da tentativa continua guardada no servidor.
        </p>
        <DetalhesTecnicos texto={data.run.log_tail} />
        <Saida
          botao={false}
          mutate={() => atualizar.mutate()}
          isPending={atualizar.isPending}
          erro={erro}
          texto="Para colocar o sistema de volta no ar, quem tem acesso ao servidor precisa rodar:"
          comando={COMANDO_APOS_FALHA}
        />
      </Layout>
    );
  }

  if (data.run?.status === "unknown") {
    return (
      <Layout titulo="Não sei dizer como terminou">
        <p className="text-sm">
          Comecei a atualização para a versão {alvo} mas perdi contato com o servidor antes do fim.
          Confira se o sistema está funcionando normalmente — se estiver, provavelmente deu certo.
        </p>
        <DetalhesTecnicos texto={data.run.log_tail} />
        <Saida
          botao={Boolean(data.update_available)}
          mutate={() => atualizar.mutate()}
          isPending={atualizar.isPending}
          erro={erro}
          texto="Para conferir pelo servidor, quem tem acesso pode rodar:"
          comando={COMANDO_MANUAL}
        />
      </Layout>
    );
  }

  if (!data.agent_online) {
    return (
      <Layout titulo="Atualização automática indisponível">
        <p className="text-sm">
          Não estou conseguindo falar com o servidor onde o sistema está instalado, então não posso
          atualizar sozinho. Quem tem acesso ao servidor pode entrar na pasta onde o sistema foi
          instalado e rodar este comando — se for a primeira vez, rode duas vezes: a primeira baixa
          o programa novo e a segunda liga o botão desta tela.
        </p>
        <Comando comando={COMANDO_MANUAL} />
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

  // Fora de uma versão publicada e sem nenhuma versão nova para oferecer: ou o
  // servidor está com código à frente da última publicada, ou o clone veio sem
  // as marcas de versão (o instalador clona raso e a busca por marcas pode
  // falhar em silêncio). Nos dois casos não existe "atualizar para" — sem esta
  // tela, a de baixo renderizava "Versão  disponível", com o número vazio, e um
  // botão que a API recusa.
  if (!nova) {
    return (
      <Layout titulo="Instalação fora de uma versão publicada">
        <p className="text-sm">
          O código deste servidor não corresponde a nenhuma versão publicada — ele veio direto do
          desenvolvimento (marca <strong>{versao}</strong>). Como não há uma versão publicada mais
          nova para comparar, não posso atualizar sozinho, e nada aqui está quebrado por causa
          disso.
        </p>
        <p className="mt-3 text-sm">
          Quem tem acesso ao servidor pode conferir com o comando abaixo — ele explica o que dá para
          fazer e não muda nada sem avisar:
        </p>
        <Comando comando={COMANDO_MANUAL} />
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

/**
 * A saída de um estado ruim — e ela nunca é só o botão.
 *
 * Depois de uma tentativa que falhou, o código do servidor já está na versão
 * nova (o `git checkout` deu certo; quem não subiu foi o container). Um novo
 * pedido pelo botão faria o agente rodar `update.sh --to <mesma tag>`, que
 * responde "você já está na versão mais recente", sai com sucesso e reportaria
 * um desfecho BOM sem ter trocado imagem nenhuma. Por isso o botão fica
 * desligado nos estados de falha: o que resolve ali é `--force`, e é o comando
 * — sempre presente — que leva a pessoa a ele.
 */
function Saida({
  botao,
  mutate,
  isPending,
  erro,
  texto,
  comando,
}: {
  botao: boolean;
  mutate: () => void;
  isPending: boolean;
  erro: string | null;
  texto: string;
  comando: string;
}) {
  return (
    <div className="mt-6 border-t pt-4">
      {botao && (
        <div className="mb-4">
          <BotaoAtualizar mutate={mutate} isPending={isPending} erro={erro} />
        </div>
      )}
      <p className="text-sm text-muted-foreground">{texto}</p>
      <Comando comando={comando} />
    </div>
  );
}

/**
 * O log do update.sh, recolhido. Sem isto o dono de uma instalação que falhou
 * precisa de `psql`/SSH para saber o que houve — o terminal que esta tela
 * existe para eliminar.
 */
function DetalhesTecnicos({ texto }: { texto: string | undefined }) {
  if (!texto?.trim()) return null;
  return (
    <details className="mt-4 rounded-md border">
      <summary className="cursor-pointer px-3 py-2 text-sm text-muted-foreground">
        Detalhes técnicos (útil se for pedir ajuda)
      </summary>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap px-3 pb-3 font-mono text-xs text-muted-foreground">
        {texto}
      </pre>
    </details>
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

function Comando({ comando }: { comando: string }) {
  const [copiado, setCopiado] = useState(false);
  return (
    <div className="mt-3 flex items-center gap-2">
      <code className="flex-1 overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">{comando}</code>
      <Button
        variant="outline"
        size="sm"
        onClick={async () => {
          await copyToClipboard(comando);
          setCopiado(true);
          setTimeout(() => setCopiado(false), 2000);
        }}
      >
        {copiado ? "Copiado" : "Copiar"}
      </Button>
    </div>
  );
}
