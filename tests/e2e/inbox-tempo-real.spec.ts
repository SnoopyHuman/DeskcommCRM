/**
 * A MENSAGEM NOVA APARECE SEM O F5 — provado pela tela, que é o que o usuário faz.
 *
 * ─── O defeito que este spec guarda ─────────────────────────────────────────
 *
 * "Recebemos mensagem e só reflete no inbox se atualizarmos a página."
 *
 * O socket do Realtime assinava com a ANON KEY: o cookie de sessão é httpOnly,
 * o supabase-js do browser não enxerga a sessão, e a callback padrão dele
 * termina em `?? this.supabaseKey`. Canal anônimo responde SUBSCRIBED, a RLS
 * filtra do outro lado, e nada é entregue — em silêncio, com todo sinal
 * disponível dizendo "saudável".
 *
 * ─── Por que ESTE teste, e não um unitário ──────────────────────────────────
 *
 * Os unitários anteriores exercitavam `setAuth` contra um cliente FAKE e
 * ficaram verdes durante todo o defeito, porque o que quebrou foi o EFEITO de
 * uma chamada, não a chamada. Só o caminho inteiro — browser real, cookie
 * httpOnly real, socket real, RLS real — prova que a entrega acontece.
 *
 * ⚠️ NÃO RECARREGA A PÁGINA depois de abrir o inbox, e isso é o teste. Se
 * alguém acrescentar um `reload()` aqui "para estabilizar", ele passa a medir o
 * F5 — exatamente o sintoma que existe para proibir.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

interface E2ECreds {
  password: string;
  users: Record<string, { id: string; email: string; role: string }>;
  /** Bloco gravado por `seed-e2e-queue.ts` — a conversa que este teste usa. */
  queue?: { conversation_id: string; contact_name: string };
}

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

/**
 * SEMEIA SEMPRE, nunca "só se o arquivo não existir".
 *
 * `.e2e-creds.json` é estado de disco: ele sobrevive a um banco recriado e passa
 * a apontar para uma organização que não existe mais. Medido — o seed da fila
 * morria com `channel_sessions_organization_id_fkey`, e a causa não era o teste
 * nem o banco, era um arquivo velho. Os seeds são idempotentes; pular por
 * existência de arquivo troca um custo pequeno por uma falha confusa.
 */
function creds(): E2ECreds {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/seed-e2e-credentials.ts"], {
    stdio: "inherit",
  });
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
}

/**
 * A CONVERSA QUE ESTE TESTE PRECISA — semeada, nunca pressuposta.
 *
 * O seed de credenciais NÃO cria conversas. Depender de "já ter alguma no banco"
 * passaria na máquina de quem desenvolve (onde o banco acumulou histórico) e
 * falharia num banco fresco, que é o do CI — e é o único que vale como prova.
 * `seed-e2e-queue.ts` já monta o trio contato + canal + conversa e é idempotente.
 */
function semearConversa(): NonNullable<E2ECreds["queue"]> {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/seed-e2e-queue.ts"], {
    stdio: "inherit",
  });
  const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
  if (!c.queue) throw new Error("bloco `queue` ausente em .e2e-creds.json após o seed");
  return c.queue;
}

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

/**
 * Faz a mensagem CHEGAR — fora do browser, como o webhook do WhatsApp chega.
 *
 * Se a mensagem fosse escrita pela própria página, o teste provaria que a UI
 * mostra o que ela mesma escreveu, que é outra coisa. O script grava as duas
 * pontas que o inbox escuta (`messages` e o carimbo de `conversations`) — dois
 * canais no mesmo socket, e era a coexistência deles que expunha o defeito.
 */
function chegarMensagem(conversationId: string, corpo: string): void {
  execFileSync(
    process.execPath,
    ["--import", "tsx", "scripts/e2e-chega-mensagem.ts", conversationId, corpo],
    { cwd: process.cwd(), stdio: "inherit" },
  );
}

test.describe("inbox em tempo real", () => {
  /**
   * O TETO DE 30s DO `playwright.config.ts` NÃO CABE NESTE TESTE.
   *
   * Medido no CI: `Test timeout of 30000ms exceeded` na última asserção — o
   * teste chegou até o fim e o relógio o matou. As esperas somam ~67s no pior
   * caso (cabeçalho 20s + assentar 2s + canal de pé 20s + a mensagem 25s), e
   * cada uma delas existe por uma razão: são os prazos de uma tela que fala com
   * um socket, não folga preguiçosa.
   *
   * Subir o teto do describe é o padrão do repo para specs assim
   * (`agente-novo-e-uso`, `capacidades-do-agente`, `distribuicao-atendimento`…),
   * e o fim de `docs/testing/user-journey-map.md` avisa exatamente isto para
   * quem escreve spec nova. Eu li e não apliquei — daí a segunda rodada vermelha.
   */
  test.describe.configure({ timeout: 120_000 });

  /**
   * Os seeds saem de DENTRO do relógio do teste.
   *
   * São dois `execFileSync` (credenciais + fila) que sobem processos Node e
   * falam com o banco. Rodando dentro do `test()`, eles gastavam o orçamento do
   * teste antes de o browser abrir a primeira página. `beforeAll` tem relógio
   * próprio — o tempo de preparar deixa de competir com o tempo de medir.
   */
  let c: E2ECreds;
  let fila: NonNullable<E2ECreds["queue"]>;

  test.beforeAll(() => {
    c = creds();
    fila = semearConversa();
  });

  test("mensagem que chega aparece na conversa aberta, sem recarregar", async ({ page }) => {

    // `manager` e não `admin`: o admin do seed tem fator MFA cadastrado e o
    // login dele para em /login/mfa. O manager vê a aba "Todas" (leitura
    // org-wide), que é o que este teste precisa.
    await login(page, c.users.manager!.email, c.password);

    /**
     * DEEP-LINK, não "clicar na primeira da lista".
     *
     * A primeira versão clicava em `[data-conversation-id]`.first() e esperava o
     * cabeçalho do contato do seed. Passou aqui e reprovou no CI: lá o banco é
     * compartilhado entre as duas partes do job, outras specs criam conversas
     * mais recentes, e a primeira da lista não era a semeada. O teste media a
     * ORDEM da lista — que não é o assunto dele — e, pior, a conversa poderia
     * nem estar na primeira página (`limit=50`).
     *
     * `?filter=all` porque a fila (default) só mostra as não atribuídas.
     */
    const conversationId = fila.conversation_id;
    await page.goto(`/app/inbox?id=${conversationId}&filter=all`);

    // A seleção é estado LOCAL — a URL não muda (`setSelectedId`, não `router.push`).
    // O sinal de que a conversa abriu é o cabeçalho dela; esperar navegação aqui
    // seria esperar por algo que o app nunca faz.
    await expect(
      page.getByRole("heading", { level: 2, name: fila.contact_name }),
    ).toBeVisible({ timeout: 20_000 });

    // Deixa a tela ASSENTAR antes de escrever. Sem isto o refetch inicial
    // poderia trazer a mensagem e o teste passaria sem o canal ter feito nada —
    // verde pelo motivo errado, que é o modo de falha desta classe de teste.
    await page.waitForTimeout(2_000);

    // O canal tem de estar de pé ANTES de a mensagem chegar — e a asserção vem
    // ANTES da escrita, senão ela não afirma isso: um canal que subisse só
    // depois da entrega passaria igual. (A primeira versão tinha esta asserção
    // DEPOIS do `chegarMensagem`, com este mesmo comentário dizendo "antes".)
    //
    // Sem ela, o teste passaria com o canal morto se a rede de segurança
    // curasse a perda a tempo — e a rede existe justamente para o canal morto.
    await expect(page.locator("[data-realtime-status]")).toHaveAttribute(
      "data-realtime-status",
      "subscribed",
      { timeout: 20_000 },
    );

    const corpo = `chegou em tempo real ${Date.now()}`;
    chegarMensagem(conversationId, corpo);

    // ⚠️ SEM reload. Se aparecer, o canal entregou.
    await expect(page.getByText(corpo)).toBeVisible({ timeout: 25_000 });

    // E entregou pelo CANAL, não pela rede de segurança: `divergencias` conta as
    // vezes em que o refetch trouxe novidade que o canal não tinha trazido.
    await expect(page.locator("[data-refetch-divergencias]")).toHaveAttribute(
      "data-refetch-divergencias",
      "0",
    );

    // A evidência vai para `evidence/`, que é VERSIONADO — `.superpowers/` é
    // ignorado pelo git, e prova citada que ninguém consegue abrir não é prova.
    await page.screenshot({
      path: "evidence/inbox-tempo-real/mensagem-sem-reload.png",
      fullPage: true,
    });

    // E a lista também reagiu — é o outro canal do mesmo socket, que era
    // justamente o que ficava anônimo quando dois canais coexistiam.
    // E A LISTA REORDENOU: a conversa que acabou de receber vai para o topo
    // (`_handler.ts` ordena por `last_message_at` desc). Asserir no PRIMEIRO
    // item é seguro AQUI — e só aqui — porque a mensagem que acabou de chegar é
    // a mais recente do banco por construção. Antes de ela chegar, a posição na
    // lista era imprevisível, e foi o que reprovou no CI.
    const primeiro = page.locator("[data-conversation-id]").first();
    await expect(primeiro).toHaveAttribute("data-conversation-id", conversationId, {
      timeout: 25_000,
    });
    await expect(primeiro).toContainText(corpo, { timeout: 25_000 });
  });
});
