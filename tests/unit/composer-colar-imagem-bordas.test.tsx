import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Colar imagem no composer — as BORDAS que a suíte do PR #198 não alcança.
 *
 * O que este arquivo protege, e por que cada caso merece catraca:
 *
 * 1) `e.preventDefault()` na colagem de IMAGEM. Medido na triagem: removendo
 *    essa linha, os 14 casos de `composer-colar-imagem.test.tsx` continuam
 *    VERDES. E ela não é decoração: copiar uma imagem de uma página web põe no
 *    clipboard o arquivo **e** um `text/html`/`text/plain`. Sem o
 *    preventDefault, o operador ganha o preview da imagem E o texto/URL
 *    despejado dentro do campo de mensagem — que é o defeito que ninguém
 *    reproduz porque só aparece com clipboard de origem real, nunca com um
 *    print de tela.
 *
 * 2) O caminho de ERRO do envio (falha-em-verde). Colar imagem termina em
 *    upload + send pela rede. A pergunta que decide se isto pode ir para um
 *    produto self-host é: quando o upload ou o envio falha, o preview FECHA
 *    (e a pessoa conclui que enviou) ou fica aberto? Fechar em cima de uma
 *    falha é a classe mais cara: o operador acha que respondeu o cliente e não
 *    respondeu. Nenhum caso do PR exercita rejeição.
 *
 * 3) Paridade com o menu "+". O comentário do handler afirma que a colagem
 *    "cai no MESMO caminho do menu +". Se um dia alguém puser validação (teto
 *    de tamanho, allowlist de mime) em só um dos dois caminhos, a afirmação
 *    passa a ser falsa em silêncio — e o caminho sem validação é o novo. Este
 *    caso trava os dois juntos: o que um aceita, o outro aceita.
 *
 * Os hooks de rede são dublados; o Composer e o dialog de preview rodam de
 * verdade — é o comportamento deles que está em disputa.
 */

const uploadResult = {
  storage_path: "org/conv/out-1.png",
  media_mime: "image/png",
  media_size_bytes: 3,
  kind: "image" as const,
};

let uploadFalha: Error | null = null;
const uploadMock = vi.fn(async () => {
  if (uploadFalha) throw uploadFalha;
  return uploadResult;
});
/** `send` que NÃO chama onSuccess — imita envio que falhou depois do upload. */
const sendMock = vi.fn();

vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: uploadMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: sendMock, isPending: false }),
}));

import { Composer } from "@/components/inbox/Composer";

function png(nome = "image.png", bytes = 3, tipo = "image/png") {
  return new File([new Uint8Array(bytes)], nome, { type: tipo });
}

/**
 * Clipboard falso. `html`/`texto` existem para reproduzir o clipboard REAL de
 * "copiar imagem de uma página web", que carrega arquivo E texto juntos.
 */
function clipboard(opts: { files?: File[]; texto?: string; html?: string }) {
  const itens: unknown[] = [];
  if (opts.texto !== undefined)
    itens.push({ kind: "string", type: "text/plain", getAsFile: () => null });
  if (opts.html !== undefined)
    itens.push({ kind: "string", type: "text/html", getAsFile: () => null });
  for (const f of opts.files ?? [])
    itens.push({ kind: "file", type: f.type, getAsFile: () => f });

  return {
    files: opts.files ?? [],
    items: itens,
    getData: (tipo: string) => (tipo === "text/html" ? (opts.html ?? "") : (opts.texto ?? "")),
  } as unknown as DataTransfer;
}

function renderComposer() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Composer conversationId="conv-1" />
    </QueryClientProvider>,
  );
}

const campo = () => screen.getByLabelText("Mensagem");

/** Abre o preview colando `arquivo` e devolve o botão Enviar do dialog. */
async function colarEAbrirPreview(arquivo: File) {
  fireEvent.paste(campo(), { clipboardData: clipboard({ files: [arquivo] }) });
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  return screen.getByRole("button", { name: /^enviar$/i });
}

beforeEach(() => {
  uploadMock.mockClear();
  sendMock.mockClear();
  uploadFalha = null;
});

describe("colagem de imagem — cancelar o paste do browser", () => {
  it("cancela o default do browser ao colar imagem (senão o texto do clipboard entra no campo)", () => {
    renderComposer();
    // fireEvent devolve false quando preventDefault() foi chamado.
    const seguiu = fireEvent.paste(campo(), { clipboardData: clipboard({ files: [png()] }) });

    expect(
      seguiu,
      "sem preventDefault o browser também executa a colagem padrão no textarea",
    ).toBe(false);
  });

  it("imagem copiada de uma página (arquivo + text/html no mesmo clipboard) não despeja o texto no campo", async () => {
    renderComposer();
    const seguiu = fireEvent.paste(campo(), {
      clipboardData: clipboard({
        files: [png()],
        html: '<img src="https://exemplo.test/foto.png">',
        texto: "https://exemplo.test/foto.png",
      }),
    });

    expect(seguiu, "o clipboard real de 'copiar imagem da web' traz arquivo E texto").toBe(false);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(campo()).toHaveValue("");
  });
});

describe("colagem de imagem — caminho de erro (não pode declarar sucesso)", () => {
  it("upload falhou: o preview FICA ABERTO e nada é enviado", async () => {
    uploadFalha = new Error("storage fora do ar");
    renderComposer();
    const enviar = await colarEAbrirPreview(png());

    fireEvent.click(enviar);

    await waitFor(() => expect(uploadMock).toHaveBeenCalled());
    expect(sendMock, "upload falhou — nada pode sair").not.toHaveBeenCalled();
    // A prova de que não houve falso sucesso: o anexo continua na tela.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("upload ok mas o envio falhou: o preview FICA ABERTO (a pessoa não pode achar que respondeu)", async () => {
    renderComposer();
    const enviar = await colarEAbrirPreview(png());

    fireEvent.click(enviar);

    await waitFor(() => expect(sendMock).toHaveBeenCalled());
    // sendMock nunca chama o onSuccess: é o envio que não confirmou.
    expect(
      screen.getByRole("dialog"),
      "fechar o preview sem confirmação do envio é falha-em-verde",
    ).toBeInTheDocument();
  });
});

describe("colagem de imagem — paridade com o menu +", () => {
  it("o que a colagem aceita, o menu + também aceita (validação não pode existir em só um caminho)", async () => {
    // 3MB: acima de qualquer thumbnail e abaixo do teto de 50MB do servidor.
    const grande = png("captura.png", 3 * 1024 * 1024);

    const colado = renderComposer();
    fireEvent.paste(campo(), { clipboardData: clipboard({ files: [grande] }) });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    colado.unmount();

    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: /anexar/i }));
    const inputMedia = document.querySelector('input[accept^="image/"]') as HTMLInputElement;
    fireEvent.change(inputMedia, { target: { files: [grande] } });

    expect(
      await screen.findByRole("dialog"),
      "os dois caminhos terminam no mesmo preview — divergir aqui é validação num só",
    ).toBeInTheDocument();
  });
});
