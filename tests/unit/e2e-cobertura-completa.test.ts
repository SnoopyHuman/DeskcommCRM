/**
 * TODA SPEC DE E2E OU RODA NO CI, OU ESTÁ DECLARADA COMO FORA — NUNCA SUMIDA.
 *
 * ## O defeito, medido em 2026-08-08
 *
 * `.github/workflows/e2e.yml` tinha as listas de spec digitadas dentro dos dois
 * `run:` e, mais abaixo, um passo cuja função declarada era dizer o que o job NÃO
 * cobre — escrito à mão, em prosa. As duas fontes divergiram em silêncio:
 *
 *   no disco: 39 arquivos · nas listas: 36 · o texto afirmava "32 de 33"
 *
 * As três ausentes eram justamente as novas, e uma delas era
 * `agente-papeis-operador.spec.ts` — a prova de tela do épico dos três papéis do
 * agente, apresentada no handoff daquele épico como "7/7", que **nunca rodou em
 * job nenhum**. O número era afirmação do autor, não medição do CI.
 *
 * O modo de falha é o que dói: **cobertura parcial silenciosa se lê como cobertura
 * total.** Quem olha o job verde conclui que a suíte está verde. E o passo que
 * existia para desfazer essa leitura estava, ele mesmo, desatualizado.
 *
 * ## A quarta fonte: o CLAUDE.md (issue #179)
 *
 * O gate cobria as três listas do workflow e **não** cobria a prosa do
 * `CLAUDE.md`, que também afirma quantas specs rodam. Medido em 2026-08-20, antes
 * desta mudança:
 *
 *   $ grep -c 'CLAUDE.md' tests/unit/e2e-cobertura-completa.test.ts
 *   0
 *
 * O próprio `CLAUDE.md` registra que aquele número já apodreceu **quatro vezes** e
 * nomeia o conserto devido: parar de recontar e passar a cobrar o texto. É o que o
 * bloco "o CLAUDE.md não pode divergir do workflow" faz aqui embaixo. Prosa que
 * nenhum gate lê é prosa que diverge — e uma triagem que a use como régua mede
 * contra o número errado, que é o modo de falha nº 1 do procedimento.
 *
 * ## Por que estático, e por que aqui
 *
 * A propriedade é enumerável a partir do repositório — arquivos no disco × nomes
 * nas listas — e é exatamente onde a régua do repo diz que o teste ganha do hábito
 * (`navegacao-completude`, que achou duas telas órfãs que três varreduras manuais
 * não acharam). Descobrir isto dinamicamente custaria um job de CI inteiro, que é
 * o custo que se está tentando não pagar de novo.
 *
 * Vive em `tests/unit/` de propósito: `pnpm test:unit` roda no check `verify`, que
 * é OBRIGATÓRIO na branch protection. Em `tests/invariants/` dependeria de Postgres
 * e de um check que não bloqueia merge.
 *
 * ## O que se guarda — quatro propriedades, quatro modos de falha
 *
 * 1. **Completude** (disco → listas): spec nova que ninguém pôs em lista nenhuma.
 * 2. **Vigência** (listas → disco): spec renomeada ou apagada que ficou na lista;
 *    o Playwright aceita um filtro que não casa nada e o job segue VERDE.
 * 3. **Consumo**: a lista é de fato passada ao Playwright. Sem isto, alguém
 *    acrescenta o nome à variável, o gate fica verde, e a spec continua sem rodar
 *    — a mesma cobertura fantasma, com uma camada a mais de aparência.
 * 4. **Concordância com o CLAUDE.md**: o número escrito na doutrina é o número
 *    que o workflow executa.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const WORKFLOW = path.join(RAIZ, ".github", "workflows", "e2e.yml");
const DOUTRINA = path.join(RAIZ, "CLAUDE.md");
const DIR_SPECS = path.join(RAIZ, "tests", "e2e");

/**
 * Lê uma variável de bloco YAML (`CHAVE: >-`) e devolve os nomes.
 *
 * Parser deliberadamente estreito: casa só a forma que o arquivo usa. Um parser
 * de YAML de verdade aceitaria formas que ninguém escreveu e esconderia uma
 * reescrita do bloco — aqui, se a forma mudar, o controle positivo abaixo estoura
 * em vez de devolver lista vazia.
 */
function listaDoWorkflow(yml: string, chave: string): string[] {
  const re = new RegExp(`^\\s*${chave}:\\s*>-\\s*\\n((?:\\s{8,}\\S.*\\n)+)`, "m");
  const m = re.exec(yml);
  if (m === null) return [];
  return m[1]!
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.endsWith(".spec.ts"));
}

const yml = readFileSync(WORKFLOW, "utf8");
const doutrina = readFileSync(DOUTRINA, "utf8");

/**
 * As listas que EXECUTAM specs. Cada uma é obrigatória: se uma sumir do
 * workflow, o controle positivo estoura em vez de a cobertura passar por
 * vacuidade.
 */
const LISTAS_QUE_EXECUTAM = ["SPECS_PARTE_1", "SPECS_PARTE_2", "SPECS_ONBOARDING_FRESCO"] as const;

const executadas = new Map(LISTAS_QUE_EXECUTAM.map((c) => [c, listaDoWorkflow(yml, c)]));

/**
 * `FORA_DO_CI` é OPCIONAL, e a opcionalidade é o desenho — não um afrouxamento.
 *
 * A versão anterior deste arquivo usava `foraDoCi.length > 0` como controle
 * positivo do parser. Isso amarrava a saúde do gate à existência de dívida:
 * zerar a lista (que é o objetivo) MATAVA o controle e reprovava o `verify` com
 * "FORA_DO_CI não foi lida do workflow: expected 0 to be greater than 0". Um
 * gate que só funciona enquanto houver spec descoberta ensina a manter uma.
 *
 * O controle positivo passou para as listas que EXECUTAM — que nunca podem ser
 * vazias, porque um job sem specs não é um estado desejável em hipótese nenhuma.
 * Quando alguma spec voltar a ficar de fora, basta redeclarar a variável no
 * workflow: o parser e a soma abaixo continuam valendo para ela.
 */
const foraDoCi = listaDoWorkflow(yml, "FORA_DO_CI");

const noDisco = readdirSync(DIR_SPECS)
  .filter((f) => f.endsWith(".spec.ts"))
  .sort();

const totalExecutado = [...executadas.values()].reduce((n, l) => n + l.length, 0);

describe("cobertura do e2e no CI", () => {
  it("o parser está vivo — controle positivo antes de qualquer conclusão", () => {
    // Sem isto, um regex que parou de casar devolveria listas vazias e a
    // asserção de vigência passaria por vacuidade, enquanto a de completude
    // acusaria as 49 specs de uma vez. Verde e vermelho errados pelo mesmo motivo.
    expect(noDisco.length, "nenhuma spec no disco — o diretório mudou de lugar?").toBeGreaterThan(30);
    for (const chave of LISTAS_QUE_EXECUTAM) {
      expect(executadas.get(chave)!.length, `${chave} não foi lida do workflow`).toBeGreaterThan(0);
    }
  });

  it("toda spec do disco está em exatamente uma lista", () => {
    const declaradas = [...[...executadas.values()].flat(), ...foraDoCi];
    const semLista = noDisco.filter((f) => !declaradas.includes(f));
    expect(
      semLista,
      "Spec no disco que não roda no CI nem está declarada como fora. Ponha em " +
        "SPECS_PARTE_1/2 (se rodar sem WAHA/Redis), em SPECS_ONBOARDING_FRESCO (se " +
        "precisar do rig de instalação fresca) ou em FORA_DO_CI com o motivo escrito. " +
        "Cobertura parcial silenciosa se lê como cobertura total.\n",
    ).toEqual([]);

    // Duas listas não podem reivindicar a mesma spec: rodar duas vezes dobra
    // login num job que já vive perto do teto por IP.
    const duplicadas = declaradas.filter((f, i) => declaradas.indexOf(f) !== i);
    expect(duplicadas, "spec declarada em mais de uma lista").toEqual([]);
  });

  it("nenhuma lista nomeia spec que não existe mais", () => {
    // O sentido inverso, e ele é pior: `playwright test naoexiste.spec.ts` não
    // acha nada e o job termina VERDE. Uma renomeação silenciosamente desliga a
    // cobertura daquele arquivo.
    const declaradas = [...[...executadas.values()].flat(), ...foraDoCi];
    const fantasmas = declaradas.filter((f) => !noDisco.includes(f));
    expect(fantasmas, "lista do CI aponta para spec inexistente — renomeada ou apagada").toEqual([]);
  });

  it("as listas são de fato passadas ao Playwright", () => {
    // A terceira ponta. Declarar não é executar: sem o consumo, acrescentar o nome
    // à variável deixa este gate verde e a spec continua fora do run.
    for (const chave of LISTAS_QUE_EXECUTAM) {
      expect(yml, `${chave} é declarada e nenhum passo a invoca`).toContain(
        `playwright test --workers=1 $${chave}`,
      );
    }
    // E FORA_DO_CI nunca é passada a um run — ela existe para NÃO rodar.
    expect(yml).not.toMatch(/playwright test[^\n]*\$FORA_DO_CI/);
  });

  /**
   * O CLAUDE.md é a doutrina do repo, e a linha do check `e2e` afirma quantas
   * specs rodam. Esse número já apodreceu quatro vezes — o próprio arquivo
   * registra as quatro — porque nada o lia. Agora lê.
   *
   * O formato cobrado é o que a linha já usa (`**N das M specs**`), então
   * satisfazer o gate é escrever a frase certa, não decorar um marcador novo.
   */
  describe("o CLAUDE.md não pode divergir do workflow", () => {
    const linha = doutrina
      .split("\n")
      .find((l) => l.trimStart().startsWith("- **`e2e`**"));

    it("a linha do check `e2e` existe na doutrina", () => {
      expect(
        linha,
        "o CLAUDE.md não tem mais a linha que começa com '- **`e2e`**' na seção de " +
          "Testes. Se ela mudou de forma, ajuste ESTE gate junto — a alternativa é " +
          "voltar a ter prosa que ninguém confere.",
      ).toBeDefined();
    });

    it("a contagem escrita é a contagem que o workflow executa", () => {
      const m = /\*\*(\d+) das (\d+) specs\*\*/.exec(linha ?? "");
      expect(
        m,
        "a linha do `e2e` no CLAUDE.md não declara mais a contagem no formato " +
          "`**N das M specs**`. O número é o que se apodrece; escrevê-lo neste " +
          "formato é o que permite conferi-lo.",
      ).not.toBeNull();
      expect(
        Number(m![1]),
        "o CLAUDE.md diz que o CI roda um número de specs diferente do que as " +
          "listas do e2e.yml somam. Reconte com a receita do próprio arquivo.",
      ).toBe(totalExecutado);
      expect(
        Number(m![2]),
        "o CLAUDE.md diz que o disco tem um número de specs diferente do medido " +
          "em tests/e2e/.",
      ).toBe(noDisco.length);
    });

    it("a doutrina nomeia todo job que executa spec", () => {
      // O modo de falha que isto pega: alguém acrescenta um terceiro job de e2e
      // e o CLAUDE.md segue descrevendo só os dois antigos — quem lê para saber
      // o que o CI cobre mede contra a régua errada.
      expect(linha, "a linha do `e2e` não nomeia o job `e2e-onboarding-fresco`").toContain(
        "e2e-onboarding-fresco",
      );
    });

    it("spec declarada FORA do CI aparece na doutrina; e o inverso também vale", () => {
      // Quando `FORA_DO_CI` está vazia, a doutrina não pode afirmar que existe
      // uma spec descoberta — foi exatamente a frase que sobreviveu quatro
      // apodrecimentos ("a **única** de fora é …").
      const afirmaLacuna = /\bde fora\b|\bfora do CI\b|\bnão roda\b/i.test(linha ?? "");
      expect(
        afirmaLacuna,
        foraDoCi.length === 0
          ? "o CLAUDE.md ainda afirma que há spec fora do CI, e FORA_DO_CI está vazia."
          : "FORA_DO_CI tem item e o CLAUDE.md não diz que há spec fora do CI.",
      ).toBe(foraDoCi.length > 0);
    });
  });
});
