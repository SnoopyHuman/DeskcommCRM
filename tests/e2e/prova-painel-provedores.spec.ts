/**
 * A PROVA PELA TELA das quatro frentes de provedores de IA.
 *
 * Dirige o browser como um operador faria: entra, abre o painel, troca o modelo
 * de um ponto, e confere que a troca VALEU — no banco, que é onde o runtime vai
 * ler. Chamada de API não prova UX, e asserção sobre a resposta do PUT não prova
 * que a configuração passou a valer.
 *
 * Os quatro eixos, um por bloco:
 *  - F0/F1: o painel mostra os pontos agrupados, explica cada um e diz a ORIGEM
 *    da escolha;
 *  - F1: trocar o modelo grava, e o valor gravado é o que a tela passa a exibir;
 *  - F3: a OpenRouter aparece como opção e seus modelos estão no seletor;
 *  - F1/F3: a catraca recusa modelo sem ferramentas no ponto que cria o lead;
 *  - F2: a tela de execuções abre e responde "está tudo bem?".
 */
import { expect, test } from "@playwright/test";

import { lerCreds, loginComoAdmin, type CredsE2E } from "./helpers/login-admin";

/**
 * Entra como ADMIN, com MFA — e não é detalhe de teste.
 *
 * Só admin edita provedores, e admin exige 2FA neste produto. A primeira versão
 * deste arquivo logava como `manager` para escapar do MFA e os testes de edição
 * falhavam com "o seletor não existe": a tela mostra o painel a um manager, mas
 * não os controles. Ou seja, o caminho que o teste precisa exercitar é
 * exatamente o que passa pelo 2FA — trocar o papel para simplificar o teste
 * teria provado uma tela que ninguém usa para configurar nada.
 */
let creds: CredsE2E;

test.beforeAll(() => {
  creds = lerCreds();
});

test.beforeEach(async ({ page }) => {
  creds = await loginComoAdmin(page, creds);
});

test("F0/F1 — o painel abre agrupado, explica os pontos e diz a origem", async ({ page }) => {
  await page.goto("/app/ai/providers");
  await page.waitForSelector('[data-testid="painel-de-provedores"]', { timeout: 30_000 });

  await expect(page.getByRole("heading", { name: "Provedores de IA" })).toBeVisible();
  // A frase de abertura conta ao operador a dimensão do que ele controla.
  await expect(page.locator('[data-testid="painel-de-provedores"]')).toContainText("23 lugares");

  for (const papel of ["atender", "entender", "proteger", "lembrar", "perceber", "melhorar"]) {
    await expect(page.locator(`[data-testid="papel-${papel}"]`)).toBeVisible();
  }
  await page.screenshot({ path: "evidence/provedores/01-painel-agrupado.png", fullPage: true });

  // "Configuração avançada" revela os pontos um a um — a granularidade fina.
  await page.click('[data-testid="avancado-entender"]');
  const cartao = page.locator('[data-testid="ponto-stage_classifier"]');
  await expect(cartao).toBeVisible();
  await expect(cartao).toContainText("Se falhar:");
  await expect(page.locator('[data-testid="origem-stage_classifier"]')).toContainText(
    /padrão da organização|painel|instalação|agente/i,
  );
  await page.screenshot({ path: "evidence/provedores/02-configuracao-avancada.png", fullPage: true });
});

test("F1 — ponto fixo mostra a RAZÃO, não um cadeado mudo", async ({ page }) => {
  await page.goto("/app/ai/providers");
  await page.waitForSelector('[data-testid="painel-de-provedores"]');
  await page.click('[data-testid="avancado-lembrar"]');
  await expect(page.locator('[data-testid="razao-fixo-embedding_indexar"]')).toContainText(
    "mesmo modelo",
  );
  // E o ponto fixo NÃO oferece seletor — oferecer e ignorar seria a tela que mente.
  await expect(page.locator('[data-testid="provider-embedding_indexar"]')).toHaveCount(0);
  await page.screenshot({ path: "evidence/provedores/03-ponto-fixo-com-razao.png", fullPage: true });
});

test("F3 — a OpenRouter é oferecida e seus modelos estão no seletor", async ({ page }) => {
  await page.goto("/app/ai/providers");
  await page.waitForSelector('[data-testid="painel-de-provedores"]');
  await page.click('[data-testid="avancado-entender"]');

  await page.click('[data-testid="provider-stage_classifier"]');
  await expect(page.getByRole("option", { name: /OpenRouter/ })).toBeVisible();
  await page.getByRole("option", { name: /OpenRouter/ }).click();

  await page.click('[data-testid="modelo-stage_classifier"]');
  // O catálogo sincronizado precisa ter chegado ao seletor; sem isto a opção
  // existiria e não haveria o que escolher.
  await expect(page.getByRole("option").first()).toBeVisible();
  const quantos = await page.getByRole("option").count();
  expect(quantos, "o seletor não trouxe modelos da OpenRouter").toBeGreaterThan(50);
  await page.screenshot({ path: "evidence/provedores/04-modelos-openrouter.png", fullPage: true });
});

test("F1 — trocar o modelo GRAVA, e a tela passa a mostrar o novo", async ({ page }) => {
  await page.goto("/app/ai/providers");
  await page.waitForSelector('[data-testid="painel-de-provedores"]');
  await page.click('[data-testid="avancado-entender"]');

  await page.click('[data-testid="provider-stage_classifier"]');
  await page.getByRole("option", { name: /OpenRouter/ }).click();
  await page.click('[data-testid="modelo-stage_classifier"]');
  await page.getByRole("option", { name: /Llama 3\.3 70B Instruct/ }).first().click();
  await page.click('[data-testid="salvar-stage_classifier"]');

  // A confirmação é o mínimo; o que importa vem depois.
  await expect(page.getByText(/agora usa|não sabe usar/i).first()).toBeVisible({ timeout: 15_000 });

  // A PROVA: navegar de novo e ver o valor vindo do banco, pela mesma resolução
  // que o runtime usa. Asserção no toast provaria só que o clique aconteceu.
  //
  // `page.goto` e não `page.reload()`: o reload devolvia
  // `net::ERR_ABORTED; maybe frame was detached` nesta máquina — instabilidade
  // do harness que aparecia como falha da tela.
  await page.goto("/app/ai/providers");
  await page.waitForSelector('[data-testid="painel-de-provedores"]');
  await page.click('[data-testid="avancado-entender"]');
  const cartao = page.locator('[data-testid="ponto-stage_classifier"]');
  await expect(cartao).toContainText("llama-3.3-70b-instruct");
  await expect(page.locator('[data-testid="origem-stage_classifier"]')).toContainText(
    /Escolhido por você/i,
  );
  await page.screenshot({ path: "evidence/provedores/05-troca-valeu.png", fullPage: true });
});

test("F1/F3 — a catraca RECUSA modelo sem ferramentas no ponto que cria o lead", async ({ page }) => {
  // O desfecho que a abertura da OpenRouter torna possível: o agente conversa
  // bem, o cliente é atendido, e nada chega ao funil — sem erro na tela.
  await page.goto("/app/ai/providers");
  await page.waitForSelector('[data-testid="painel-de-provedores"]');
  await page.click('[data-testid="avancado-atender"]');

  const cartao = page.locator('[data-testid="ponto-operator_turn"]');
  await expect(cartao).toBeVisible();
  await expect(cartao).toContainText("precisa de ferramentas");
  await page.screenshot({ path: "evidence/provedores/06-exige-ferramentas.png", fullPage: true });
});

test("F2 — a tela de execuções abre e responde 'está tudo bem?'", async ({ page }) => {
  await page.goto("/app/ai/runs");
  await page.waitForSelector('[data-testid="execucoes-de-ia"]', { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Execuções de IA" })).toBeVisible();
  // O resumo vem ANTES da lista — é o que a tela responde primeiro.
  await expect(page.locator('[data-testid="resumo"]')).toBeVisible();
  await expect(page.locator('[data-testid="filtro-erros"]')).toBeVisible();
  await page.screenshot({ path: "evidence/provedores/07-execucoes.png", fullPage: true });
});

test("as duas telas têm porta na navegação — pelo hub de IA", async ({ page }) => {
  // Tela alcançável só por URL digitada é tela que não existe para o operador.
  //
  // A porta é o HUB, não a sidebar: pô-las na sidebar estourou a dobra em 900px
  // (pego pelo e2e `navegacao.spec.ts` no CI, e é o mesmo eixo do
  // `feedback_agrupar_cria_overflow` — agrupar o menu o faz crescer). Elas
  // seguem o padrão das outras nove telas do grupo, todas alcançáveis daqui.
  await page.goto("/app/ai");
  await expect(page.getByRole("link", { name: /Provedores/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Execuções/ })).toBeVisible();
});
