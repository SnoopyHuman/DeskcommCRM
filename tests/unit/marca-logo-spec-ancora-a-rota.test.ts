/**
 * A SPEC DO LOGO NÃO PODE MEDIR UMA TELA QUE JÁ TROCOU — NEM ESPERAR SEM TETO.
 *
 * ── O defeito que este arquivo guarda (issue #274) ──────────────────────────
 *
 * O caso (1) de `tests/e2e/marca-logo.spec.ts` reprovou 2 de 3 execuções de CI
 * com `element(s) not found` na prévia, e a captura do momento da falha estava
 * na CASCA DO TENANT — não em `/admin/marca`. A leitura natural ("o produto tem
 * um desvio de modo plataforma↔tenant") não se sustenta — mas NÃO pelo motivo
 * que este cabeçalho afirmava. Ele dizia "nenhum `redirect` para rota de tenant
 * existe fora de `app/app/**`", e isso é FALSO. Reconte com:
 *
 *   grep -rn 'redirect("/app' app lib --include="*.ts*" | grep -v '^app/app/'
 *
 * Em 2026-08-20 esse comando devolvia 7 linhas — `app/page.tsx`,
 * `app/(public)/login/mfa/page.tsx`, `app/actions/auth/verifyMfa.ts`,
 * `app/actions/onboarding/finishOnboarding.ts`, `app/actions/team/acceptInvite.ts`
 * e as duas de `app/onboarding/` — e uma delas é justamente o
 * `verifyMfa.ts → redirect("/app/inbox")` de que ESTA história causal depende.
 *
 * O que sustenta a conclusão é outra coisa: nenhum desses sete parte de
 * `/admin/marca`. Eles partem da raiz, do onboarding, do aceite de convite ou do
 * próprio desafio de MFA. O `proxy.ts` só desvia `/admin/*` para `/login` ou
 * `/admin/forbidden`, e o fallback de MPA do Next devolve a URL ORIGINAL. Quem
 * larga a página no tenant é o helper de login da spec — disparando exatamente o
 * redirect do `verifyMfa.ts` que a lista acima mostra.
 *
 * MEDIDO neste repositório, com o helper ANTIGO numa sonda que replica o caso
 * (1) sob `Emulation.setCPUThrottlingRate` — 2 reprovações em 18 execuções:
 *
 *   Error: locator.click: Test timeout of 180000ms exceeded.
 *     - waiting for locator('input[aria-label="Dígito 1"]')
 *   FIM url=http://localhost:3001/app/inbox
 *
 * A cadeia: `waitForURL(/\/app\//, { timeout: 8_000 })` desiste enquanto o
 * `verifyMfa` ainda está em voo; o código entra depois; a página vira
 * `/app/inbox`; a retentativa clica num `Dígito 1` que não existe mais; e como
 * `playwright.config.ts` não define `actionTimeout` (default 0 = SEM teto), esse
 * clique espera até o timeout do caso.
 *
 * ── Por que a guarda é sobre o TEXTO da spec ────────────────────────────────
 *
 * O artefato consertado é um TESTE. Não há como cobri-lo por comportamento sem
 * subir o mesmo rig que ele mesmo é (Supabase local + build + Playwright), que é
 * o que o job `e2e` faz uma vez por PR e o `test:unit` não faz nunca. A régua
 * possível aqui é a fonte — mesmo caminho de `tests/unit/branding.test.ts` e
 * `tests/unit/e2e-cobertura-completa.test.ts`. O que ela cobra são PROPRIEDADES
 * (esperar estado terminal, ter teto, ancorar a rota antes de medir), não a
 * escrita exata das linhas.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const CAMINHO_SPEC = path.join(RAIZ, "tests/e2e/marca-logo.spec.ts");
const CAMINHO_CONFIG = path.join(RAIZ, "playwright.config.ts");

const SPEC = readFileSync(CAMINHO_SPEC, "utf8");
const CONFIG = readFileSync(CAMINHO_CONFIG, "utf8");

/**
 * Tira os comentários — a guarda mede CÓDIGO, não prosa.
 *
 * Nos dois sentidos, e os dois já morderam: a prosa que explica o defeito
 * (`timeout: 0` significa esperar para sempre) foi lida como se fosse o defeito,
 * e um comentário que citasse `getByRole("alert")` satisfaria sozinho a asserção
 * que cobra o localizador. Só saem o bloco `/* … *\/` e a linha que ABRE com
 * `//`; comentário no fim de uma linha de código fica, porque cortá-lo cortaria
 * junto o `/\/app\//` das expressões regulares de rota.
 */
function semComentarios(fonte: string): string {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((linha) => !linha.trimStart().startsWith("//"))
    .join("\n");
}

/** O corpo de uma função de topo de arquivo, do `{` ao `\n}` da coluna zero. */
function corpoDaFuncao(fonte: string, assinatura: string): string {
  const inicio = fonte.indexOf(assinatura);
  expect(inicio, `não achei \`${assinatura}\` em ${CAMINHO_SPEC}`).toBeGreaterThan(-1);
  const fim = fonte.indexOf("\n}\n", inicio);
  expect(fim, `\`${assinatura}\` não fecha na coluna zero`).toBeGreaterThan(inicio);
  return semComentarios(fonte.slice(inicio, fim));
}

/**
 * O ARGUMENTO do `Promise.race([...])`, do `[` ao `]` que o fecha.
 *
 * ⚠️ Ler o corpo inteiro NÃO SERVE, e foi assim que esta guarda passou verde
 * sobre a sabotagem que reinstala o defeito da issue #274. Substituindo o lado
 * do alerta por `page.waitForTimeout(8_000).then(() => "recusado")` — um relógio
 * vestido de corrida — a asserção `corpo.toContain('getByRole("alert")')`
 * continuava satisfeita pela mera DECLARAÇÃO `const recusa = …`, que sobrevive
 * mesmo quando ninguém mais a usa. A propriedade que a guarda nomeia é sobre os
 * LADOS DA CORRIDA; então é a corrida que precisa ser lida.
 */
function corridaDeDesfechos(corpo: string): string {
  const abre = corpo.indexOf("Promise.race([");
  expect(abre, "não achei `Promise.race([` em `loginComTotp`").toBeGreaterThan(-1);
  const inicio = corpo.indexOf("[", abre);
  let profundidade = 0;
  for (let i = inicio; i < corpo.length; i++) {
    if (corpo[i] === "[") profundidade++;
    else if (corpo[i] === "]" && --profundidade === 0) return corpo.slice(inicio + 1, i);
  }
  throw new Error("o `Promise.race([` de `loginComTotp` não fecha");
}

describe("marca-logo.spec.ts: o desafio de MFA espera um estado terminal", () => {
  const corpo = corpoDaFuncao(SPEC, "async function loginComTotp(");

  it("decide por corrida entre os DOIS desfechos, e não por relógio", () => {
    expect(
      corpo,
      "sem `Promise.race`, o helper voltou a apostar num relógio para decidir se o " +
        "login entrou — que é o defeito da issue #274",
    ).toContain("Promise.race");
    expect(
      corpo,
      "a recusa do formulário (`role=alert` do MfaForm) é um dos dois estados terminais; " +
        "sem ela a corrida tem um lado só e volta a ser um relógio",
    ).toContain('getByRole("alert")');
  });

  it("o localizador do alerta é USADO na corrida, não só declarado", () => {
    const nome = corpo.match(/const\s+(\w+)\s*=[^;]*getByRole\("alert"\)/)?.[1];
    expect(nome, "não achei a declaração do localizador de recusa em `loginComTotp`").toBeTruthy();
    expect(
      corridaDeDesfechos(corpo),
      `\`${nome}\` é declarado mas não entra na corrida — a declaração sozinha satisfaz ` +
        "uma leitura ingênua do corpo e deixa passar um lado de corrida que é relógio",
    ).toContain(`${nome}.waitFor(`);
  });

  it("nenhum lado da corrida é um relógio", () => {
    const corrida = corridaDeDesfechos(corpo);
    expect(
      corrida,
      "um `waitForTimeout` dentro da corrida é o defeito da issue #274 de volta, só que " +
        "disfarçado: o desfecho volta a ser decidido pelo relógio da máquina",
    ).not.toContain("waitForTimeout");
    expect(corrida, "um `setTimeout` dentro da corrida é o mesmo relógio").not.toMatch(
      /setTimeout\(/,
    );
  });

  it("não redigita um código antes de a tentativa anterior terminar", () => {
    // Uma segunda digitação por caminho de exceção é a assinatura exata do
    // helper antigo: `try { waitForURL } catch { dorme; redigita }`.
    expect(
      corpo.match(/page\.keyboard\.type\(/g)?.length ?? 0,
      "o helper voltou a ter mais de um ponto de digitação fora do laço de tentativas",
    ).toBe(1);
    expect(
      corpo,
      "o `catch` que engolia o estouro do `waitForURL` voltou: ele é o que permitia " +
        "digitar por cima de uma tela que já tinha navegado",
    ).not.toMatch(/}\s*catch\s*(\([^)]*\))?\s*{/);
  });

  it("nenhuma espera tem teto PRÓPRIO — todas dividem o orçamento do login", () => {
    // Teto por espera é o que fazia o pior caminho do helper (2 tentativas + a
    // virada da janela do TOTP) passar do teto do CASO: o Playwright estourava
    // primeiro e a mensagem do helper nunca saía. Um relógio só, do login
    // inteiro, torna essa aritmética impossível de apodrecer.
    expect(
      corpo.match(/timeout:\s*[0-9]/g) ?? [],
      "voltou um teto escrito à mão dentro de `loginComTotp` — ele não conhece o que as " +
        "esperas anteriores já gastaram, e a soma deles é o que estourava o caso",
    ).toEqual([]);
    expect(
      corpo,
      "as esperas do login não são mais regidas por `ORCAMENTO_DO_LOGIN_MS`",
    ).toContain("ORCAMENTO_DO_LOGIN_MS");
  });

  it("todo clique tem teto — o config do Playwright não dá nenhum", () => {
    const configTemTeto = /actionTimeout\s*:/.test(CONFIG);
    if (configTemTeto) return; // o teto passou a vir do config; a guarda local perde a razão
    for (const clique of corpo.match(/\.click\([^)]*\)/g) ?? []) {
      expect(
        clique,
        "sem `actionTimeout` no playwright.config.ts (default 0 = sem teto), um clique sem " +
          "teto próprio espera até o timeout do CASO quando o controle sumiu",
      ).toMatch(/timeout:/);
    }
  });
});

describe("marca-logo.spec.ts: a prévia só é medida depois de a rota ser provada", () => {
  it("a âncora fica ENTRE o toast de sucesso e a medição da prévia", () => {
    const iPrevia = SPEC.indexOf("[data-previa-do-logo='claro'] img");
    expect(iPrevia, "não achei a medição da prévia clara").toBeGreaterThan(-1);

    const iToast = SPEC.lastIndexOf("logo atualizado", iPrevia);
    expect(iToast, "não achei a asserção do toast antes da prévia").toBeGreaterThan(-1);

    const iAncora = SPEC.lastIndexOf("aindaNaTelaDeMarca(page", iPrevia);
    expect(
      iAncora,
      "a prévia é medida sem provar a rota antes. O toast NÃO serve de âncora: o " +
        "`<Toaster/>` mora no layout raiz e sobrevive à troca de rota, então " +
        '"Logo atualizado" verde + prévia ausente é o que se vê quando a página já é outra',
    ).toBeGreaterThan(iToast);
  });

  it("a âncora prova a URL E o campo montado", () => {
    const corpo = corpoDaFuncao(SPEC, "async function aindaNaTelaDeMarca(");
    expect(corpo, "a âncora parou de provar a rota").toContain("toHaveURL");
    expect(
      corpo,
      "a âncora parou de provar que o campo de logo está montado — só a URL deixaria passar " +
        "uma casca trocada na mesma rota",
    ).toContain("toBeAttached");
  });
});

describe("marca-logo.spec.ts: o teto do caso cobre o pior caminho do login", () => {
  /**
   * ⚠️ O TETO DO CASO JÁ FOI MENOR QUE O PIOR CAMINHO DO HELPER, e isso apaga a
   * mensagem que o helper existe para dar. Com 60s por tentativa, o pior
   * caminho era 60s + até 30,2s (virada da janela do TOTP) + 60s ≈ 150s, contra
   * os 120s do `describe`: quem reprovava era o relógio do Playwright, com
   * `Test timeout` — o diagnóstico opaco da issue #274 de volta.
   *
   * Por isso a guarda não confere um número: ela cobra que o teto do caso seja
   * DERIVADO do orçamento do login. Número escrito à mão nos dois lugares é
   * exatamente o que apodrece quando um deles muda.
   */
  function constante(nome: string): number {
    const achado = SPEC.match(new RegExp(`const ${nome} = ([0-9_]+)`));
    expect(achado, `não achei \`const ${nome}\` em ${CAMINHO_SPEC}`).not.toBeNull();
    return Number(achado![1]!.replace(/_/g, ""));
  }

  it("todo `test.setTimeout` deriva do orçamento do login", () => {
    const chamadas = SPEC.match(/test\.setTimeout\([^)]*\)/g) ?? [];
    expect(chamadas.length, "a spec deixou de dar teto próprio aos casos").toBeGreaterThan(0);
    for (const chamada of chamadas) {
      expect(
        chamada,
        `\`${chamada}\` é um número escrito à mão. Ele já ficou MENOR que o pior caminho ` +
          "do `loginComTotp`, e aí o caso morre no relógio do Playwright antes de o helper " +
          "poder dizer onde a página parou",
      ).toContain("ORCAMENTO_DO_LOGIN_MS");
    }
  });

  it("a folga do caso é positiva e o orçamento cabe duas tentativas de MFA", () => {
    expect(
      constante("ORCAMENTO_DO_LOGIN_MS"),
      "o orçamento precisa caber duas tentativas MAIS a virada da janela do TOTP (30s), " +
        "senão a segunda tentativa nasce sem tempo de terminar",
      ).toBeGreaterThanOrEqual(90_000);
    expect(
      constante("FOLGA_DO_CASO_MS"),
      "sem folga, o corpo do caso (upload, prévia, screenshot) não tem tempo depois do login",
    ).toBeGreaterThan(0);
  });
});

/**
 * ── A CLASSE: o laço defeituoso está em mais 9 arquivos, e este PR não os toca ──
 *
 * O padrão `try { waitForURL(curto) } catch { dorme; redigita }` — o que a issue
 * #274 achou — está copiado em 8 outras specs E no helper compartilhado
 * `tests/e2e/helpers/login-admin.ts`, importado por mais 6 specs. Todas rodam no
 * job `e2e`, que é status check obrigatório: todas podem reprovar PR alheio pelo
 * mesmo motivo, que é a queixa central da issue.
 *
 * ESTE PR CONSERTA UMA CÓPIA. A escolha é registrada aqui em vez de na prosa do
 * PR porque a razão é medível e envelhece: propagar o conserto exige refazer, em
 * cada arquivo, o ORÇAMENTO que a guarda acima cobra (cada spec tem o seu
 * `test.setTimeout`) — e isso não é verificável sem rodar o rig do `e2e`
 * (Supabase local + `next build` + Playwright). Medido em 2026-08-20 neste
 * worktree: o Supabase local está DESLIGADO (`curl http://127.0.0.1:54321` →
 * sem resposta) e 60+ worktrees compartilham essa instância, cujo seed rotaciona
 * o fator TOTP de todas as sessões. Reescrever 9 orçamentos sem poder rodar
 * nenhum deles seria plantar, em 15 specs de um gate obrigatório, o mesmo
 * defeito que este PR existe para tirar de uma.
 *
 * O que dá para fazer sem rodar o rig é IMPEDIR QUE A CLASSE CRESÇA. A lista
 * abaixo é dívida CONGELADA: quem escrever o padrão num arquivo novo reprova
 * aqui, e quem consertar um dos congelados é obrigado a tirá-lo da lista.
 */
const IRMAS_COM_O_LACO_ANTIGO = new Set([
  "tests/e2e/followup-builder.spec.ts",
  "tests/e2e/followup-journey.spec.ts",
  "tests/e2e/gatilho-de-caso.spec.ts",
  "tests/e2e/gatilho-de-etapa.spec.ts",
  "tests/e2e/helpers/login-admin.ts",
  "tests/e2e/navegacao.spec.ts",
  "tests/e2e/qa-agente-usa-as-maos.spec.ts",
  "tests/e2e/rbac-roles.spec.ts",
  "tests/e2e/system-update.spec.ts",
]);

/** Os arquivos do e2e que hoje têm o laço `try { waitForURL curto } catch`. */
function comOLacoAntigo(): string[] {
  const dir = path.join(RAIZ, "tests/e2e");
  const arquivos = [
    ...readdirSync(dir)
      .filter((n) => n.endsWith(".spec.ts"))
      .map((n) => `tests/e2e/${n}`),
    ...readdirSync(path.join(dir, "helpers"))
      .filter((n) => n.endsWith(".ts"))
      .map((n) => `tests/e2e/helpers/${n}`),
  ].sort();

  return arquivos.filter((rel) => {
    const fonte = readFileSync(path.join(RAIZ, rel), "utf8");
    const inicios = /try\s*\{/g;
    let bloco: RegExpExecArray | null;
    while ((bloco = inicios.exec(fonte)) !== null) {
      // 700 caracteres: o laço inteiro cabe nisso nas 9 cópias medidas, e uma
      // janela maior passaria a casar `try` e `catch` de blocos diferentes.
      const janela = fonte.slice(bloco.index, bloco.index + 700);
      const espera = janela.match(/waitForURL\([^;]*?timeout:\s*([0-9_]+)/);
      const catchDoBloco = janela.search(/\}\s*catch/);
      if (espera === null || catchDoBloco < 0) continue;
      if (janela.indexOf(espera[0]) > catchDoBloco) continue;
      if (Number(espera[1]!.replace(/_/g, "")) < 30_000) return true;
    }
    return false;
  });
}

describe("o laço da issue #274 não se espalha para specs novas", () => {
  it("nenhum arquivo FORA da dívida congelada desiste da URL no relógio", () => {
    const novos = comOLacoAntigo().filter((f) => !IRMAS_COM_O_LACO_ANTIGO.has(f));
    expect(
      novos,
      "estes arquivos copiaram o laço da issue #274 (`try { waitForURL curto } catch { " +
        "dorme; redigita }`). Ele redigita em cima de uma tela que já navegou e, sem " +
        "`actionTimeout` no config, o clique seguinte espera até o timeout do CASO. " +
        "Use um estado terminal, como `loginComTotp` em tests/e2e/marca-logo.spec.ts",
    ).toEqual([]);
  });

  it("a dívida congelada só encolhe", () => {
    const ainda = new Set(comOLacoAntigo());
    const jaConsertados = [...IRMAS_COM_O_LACO_ANTIGO].filter((f) => !ainda.has(f));
    expect(
      jaConsertados,
      "estes já não têm o laço antigo — tire-os de `IRMAS_COM_O_LACO_ANTIGO`, senão a " +
        "lista deixa de medir a dívida e vira decoração",
    ).toEqual([]);
  });
});
