/**
 * A REDE VISUAL QUE PRECISA EXISTIR ANTES DA MIGRAÇÃO DO TAILWIND 3 → 4 (issue #239).
 *
 * ─── Por que este arquivo existe (não apague achando que é cerimônia) ───
 *
 * Todo gate atual do repo lê TypeScript, não CSS. `typecheck`, `lint`,
 * `test:unit`, `invariants` e `build-and-size` ficam VERDES quando o CSS
 * gerado muda, porque nenhum deles chega a compilar o Tailwind e olhar o
 * resultado. E `grep -rn toHaveScreenshot tests/` devolve 0: também não há
 * prova por imagem. Ou seja: hoje o produto inteiro pode mudar de aparência
 * sem um único vermelho.
 *
 * O caso que provou o buraco, medido em e7d4a786:
 *
 *   Uma varredura de "tokens do tailwind.config sem consumidor" apontou
 *   `duration-fast/base/slow` como mortos. É falso — eles são usados pelas
 *   quatro primitivas mais reusadas do repo (button, badge, input, textarea),
 *   mas por interpolação de classe dentro de um `cva([...])`, num formato que
 *   a varredura não pegou. Removendo o bloco `transitionDuration` do
 *   `tailwind.config.ts` o Tailwind compila em ~130ms, sem erro e sem warning,
 *   e NENHUMA regra `.duration-*` é emitida.
 *
 *   Efeito real (medido, e menor do que "a transição some", que era a leitura
 *   inicial): `transition-colors` e `transition-[...]` do Tailwind 3 já trazem
 *   `transition-duration: 150ms` e `cubic-bezier(0.4, 0, 0.2, 1)` embutidos.
 *   Sem `.duration-fast`/`.ease-out` por cima, todo botão, badge, input e
 *   textarea do produto NÃO para de animar — ele passa a animar com os
 *   defaults do Tailwind (150ms / cubic-bezier(0.4, 0, 0.2, 1)) em vez dos
 *   tokens do design system (120ms / cubic-bezier(0.2, 0, 0, 1)). Uma troca
 *   silenciosa de VALOR é ainda mais difícil de flagrar do que um sumiço, e é
 *   exatamente por isso que este gate compara a DECLARAÇÃO, não a existência
 *   da regra: "a regra `.duration-fast` existe" passaria numa migração que
 *   apontasse o token para outro valor.
 *
 * A migração 3 → 4 reescreve justamente `tailwind.config.ts` (o config em JS
 * vira `@theme` em CSS) — é a mudança com maior chance de derrubar tokens em
 * silêncio que este repo tem pela frente. Este arquivo é o pré-requisito dela.
 *
 * ─── Onde fica a fronteira (o que este gate NÃO cobre, e por quê) ───
 *
 * DENTRO: todo token que o `tailwind.config.ts` cria — 105 folhas em 8
 * famílias — mais `theme.container`, o seletor de `darkMode`, os globs de
 * `content`, e a resolução de cada `var()` que essas utilitárias apontam.
 * Critério: é exatamente esse arquivo que a migração reescreve.
 *
 * FORA, de propósito:
 *  - As utilitárias NATIVAS do Tailwind (`flex`, `text-sm`, `grid-cols-*`…).
 *    São milhares, são upstream, e não é aqui que a migração edita.
 *  - O preflight (`@tailwind base`). É o reset do Tailwind, não promessa
 *    nossa; a fonte do produto é aplicada explicitamente em `app/globals.css`
 *    (`html`/`body`), que este gate alcança pela via dos tokens.
 *  - Os tokens de `app/globals.css` que NENHUMA utilitária do config alcança:
 *    `--density-*` (lidos só por `app/design/showcase.css`), `--z-*`
 *    (duplicam o `zIndex` do config, que usa literais) e os 19 aliases crus
 *    do shadcn (`--background`, `--foreground`, `--radius`…, que hoje têm
 *    ZERO consumidor — medido: `grep -rn 'var(--background)' app components
 *    lib` não retorna nada). Não são superfície da migração do Tailwind.
 *  - Layout/geometria de tela (o que um `toHaveScreenshot` pegaria). Fica de
 *    fora porque baseline de imagem é instável entre macOS local e o runner
 *    ubuntu do CI, e gate instável é gate que o time aprende a ignorar.
 *    Complemento possível, não substituto — e este é a espinha dorsal.
 *
 * ─── Custo ───
 *
 * Roda no `pnpm test:unit`, que já é o job `verify`. Nenhuma infra nova: o
 * `postcss` e o `tailwindcss` já são devDependencies (é o que o
 * `postcss.config.mjs` do build usa). Compila UMA vez, com `content` sintético
 * (a lista de classes deste arquivo) em vez dos globs reais — ~3s em vez de
 * ~18s, e, mais importante, determinístico: o gate não fica vermelho porque
 * alguém parou de usar `shadow-xl` em algum componente.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import fs from "node:fs";
import path from "node:path";

import config from "@/tailwind.config";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const RAIZ = path.resolve(__dirname, "../..");

/* ────────────────────────────────────────────────────────────────────────────
 * O INVENTÁRIO — as promessas do design system, escritas À MÃO.
 *
 * Escritas à mão DE PROPÓSITO: se estas classes fossem derivadas do
 * `tailwind.config.ts`, apagar um bloco do config encolheria a lista junto e o
 * gate continuaria verde. A lista é a régua; o config é o medido.
 *
 * Cada entrada é `classe -> valor esperado da declaração`. A propriedade CSS
 * vem da família (constante literal em FAMILIAS, logo abaixo).
 * ──────────────────────────────────────────────────────────────────────────── */

/** Cores → `bg-*`. Uma utilitária por token; `background-color` é a mais direta. */
const CORES: Record<string, string> = {
  // Fundação
  "bg-bg": "var(--color-bg)",
  "bg-surface": "var(--color-surface)",
  "bg-surface-elevated": "var(--color-surface-elevated)",
  "bg-overlay": "var(--color-overlay)",
  "bg-text": "var(--color-text)",
  "bg-text-muted": "var(--color-text-muted)",
  "bg-text-subtle": "var(--color-text-subtle)",

  // Acento — escala Sage
  "bg-accent-50": "var(--color-accent-50)",
  "bg-accent-100": "var(--color-accent-100)",
  "bg-accent-200": "var(--color-accent-200)",
  "bg-accent-300": "var(--color-accent-300)",
  "bg-accent-400": "var(--color-accent-400)",
  "bg-accent-500": "var(--color-accent-500)",
  "bg-accent-600": "var(--color-accent-600)",
  "bg-accent-700": "var(--color-accent-700)",
  "bg-accent-800": "var(--color-accent-800)",
  "bg-accent-900": "var(--color-accent-900)",
  "bg-accent-950": "var(--color-accent-950)",
  "bg-accent": "var(--color-accent)",
  "bg-accent-foreground": "var(--color-accent-fg)",
  "bg-accent-soft": "var(--color-accent-soft)",
  "bg-accent-hover": "var(--color-accent-hover)",

  // Neutros — greige
  "bg-neutral-50": "var(--color-neutral-50)",
  "bg-neutral-100": "var(--color-neutral-100)",
  "bg-neutral-200": "var(--color-neutral-200)",
  "bg-neutral-300": "var(--color-neutral-300)",
  "bg-neutral-400": "var(--color-neutral-400)",
  "bg-neutral-500": "var(--color-neutral-500)",
  "bg-neutral-600": "var(--color-neutral-600)",
  "bg-neutral-700": "var(--color-neutral-700)",
  "bg-neutral-800": "var(--color-neutral-800)",
  "bg-neutral-900": "var(--color-neutral-900)",
  "bg-neutral-950": "var(--color-neutral-950)",

  // Estados
  "bg-success": "var(--color-success)",
  "bg-success-bg": "var(--color-success-bg)",
  "bg-success-fg": "var(--color-success-fg)",
  "bg-warning": "var(--color-warning)",
  "bg-warning-bg": "var(--color-warning-bg)",
  "bg-warning-fg": "var(--color-warning-fg)",
  "bg-error": "var(--color-error)",
  "bg-error-bg": "var(--color-error-bg)",
  "bg-error-fg": "var(--color-error-fg)",
  "bg-info": "var(--color-info)",
  "bg-info-bg": "var(--color-info-bg)",
  "bg-info-fg": "var(--color-info-fg)",

  // Aliases do shadcn — compat de componentes ainda não migrados.
  // Estes NÃO são redundantes com os de cima: são o mapeamento (ex.:
  // `primary` → o MESMO var que `accent`). Se a migração trocar o alvo de um
  // alias, a tela muda de cor sem que nenhum token some.
  "bg-border": "var(--color-border)",
  "bg-border-strong": "var(--color-border-strong)",
  "bg-input": "var(--color-border)",
  "bg-ring": "var(--color-accent-500)",
  "bg-background": "var(--color-bg)",
  "bg-foreground": "var(--color-text)",
  "bg-primary": "var(--color-accent)",
  "bg-primary-foreground": "var(--color-accent-fg)",
  "bg-secondary": "var(--color-surface-elevated)",
  "bg-secondary-foreground": "var(--color-text)",
  "bg-destructive": "var(--color-error)",
  // A ÚNICA cor literal do config inteiro (`#ffffff`, não um token). O Tailwind
  // 3 a passa pelo maquinário de opacidade; por isso o valor não é um `var()`.
  "bg-destructive-foreground":
    "rgb(255 255 255 / var(--tw-bg-opacity, 1))",
  "bg-muted": "var(--color-surface-elevated)",
  "bg-muted-foreground": "var(--color-text-muted)",
  "bg-popover": "var(--color-surface)",
  "bg-popover-foreground": "var(--color-text)",
  "bg-card": "var(--color-surface)",
  "bg-card-foreground": "var(--color-text)",
};

/** Espaçamento → `p-*`. A escala Aerada; um número trocado reflui a tela toda. */
const ESPACAMENTO: Record<string, string> = {
  "p-0": "var(--space-0)",
  "p-1": "var(--space-1)",
  "p-2": "var(--space-2)",
  "p-3": "var(--space-3)",
  "p-4": "var(--space-4)",
  "p-5": "var(--space-5)",
  "p-6": "var(--space-6)",
  "p-8": "var(--space-8)",
  "p-10": "var(--space-10)",
  "p-12": "var(--space-12)",
  "p-16": "var(--space-16)",
  "p-20": "var(--space-20)",
  "p-24": "var(--space-24)",
  "p-32": "var(--space-32)",
};

/** Raio → `rounded-*`. `rounded` (sem sufixo) é o DEFAULT do config. */
const RAIO: Record<string, string> = {
  "rounded-none": "var(--radius-none)",
  "rounded-sm": "var(--radius-sm)",
  rounded: "var(--radius-md)",
  "rounded-md": "var(--radius-md)",
  "rounded-lg": "var(--radius-lg)",
  "rounded-xl": "var(--radius-xl)",
  "rounded-full": "var(--radius-full)",
};

/**
 * Sombra → `shadow-*`, medida em `--tw-shadow`.
 *
 * A propriedade guardada é a variável interna do Tailwind, não `box-shadow`:
 * `box-shadow` é só encanamento (`var(--tw-ring-offset-shadow), …`) e o nosso
 * token não aparece lá. Consequência assumida: um bump de major do Tailwind
 * que renomeie `--tw-shadow` deixa ESTES casos vermelhos sem regressão real —
 * o que é o comportamento certo numa migração (alguém tem que conferir se as
 * sombras sobreviveram), mas explica o vermelho para quem for ler.
 */
const SOMBRA: Record<string, string> = {
  "shadow-xs": "var(--shadow-xs)",
  "shadow-sm": "var(--shadow-sm)",
  shadow: "var(--shadow-sm)",
  "shadow-md": "var(--shadow-md)",
  "shadow-lg": "var(--shadow-lg)",
  "shadow-xl": "var(--shadow-xl)",
  "shadow-none": "0 0 #0000",
};

/** Curva de movimento → `ease-*`. */
const CURVA: Record<string, string> = {
  "ease-out": "var(--ease-out)",
  "ease-in-out": "var(--ease-in-out)",
  "ease-spring": "var(--ease-spring)",
};

/** Duração de movimento → `duration-*`. O caso que originou a issue #239. */
const DURACAO: Record<string, string> = {
  "duration-fast": "var(--duration-fast)",
  "duration-base": "var(--duration-base)",
  "duration-slow": "var(--duration-slow)",
};

/**
 * Camadas → `z-*`.
 *
 * Aqui o config usa LITERAIS, não `var()` — e `app/globals.css` define
 * `--z-base`…`--z-toast` com os mesmos números, sem ninguém lendo. A
 * duplicação é real e está fora do escopo desta issue; o que o gate garante é
 * que os números do config não escorreguem (trocar `modal` e `dropdown` põe o
 * dropdown atrás do modal, e ninguém vê isso em teste de TypeScript).
 */
const CAMADAS: Record<string, string> = {
  "z-base": "0",
  "z-raised": "10",
  "z-dropdown": "20",
  "z-sticky": "30",
  "z-modal": "40",
  "z-toast": "50",
};

/**
 * Fontes → `font-*`.
 *
 * `--font-atkinson` e `--font-mono` NÃO vivem em `app/globals.css`: são
 * injetadas pelo `next/font` em `app/layout.tsx`. Por isso ficam fora do teste
 * de "todo var resolve em :root" e ganham verificação própria mais abaixo.
 */
const FONTES: Record<string, string> = {
  "font-sans":
    "var(--font-atkinson), ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  "font-mono":
    "var(--font-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
};

/**
 * As oito famílias. `chaveNoConfig` liga cada família ao bloco de
 * `theme.extend` que a produz — é o que o teste de completude usa para provar
 * que nenhum token novo entrou no config sem entrar no inventário.
 */
const FAMILIAS = [
  { rotulo: "cores", chaveNoConfig: "colors", prefixo: "bg", propriedade: "background-color", promessas: CORES },
  { rotulo: "espaçamento", chaveNoConfig: "spacing", prefixo: "p", propriedade: "padding", promessas: ESPACAMENTO },
  { rotulo: "raio de borda", chaveNoConfig: "borderRadius", prefixo: "rounded", propriedade: "border-radius", promessas: RAIO },
  { rotulo: "sombra", chaveNoConfig: "boxShadow", prefixo: "shadow", propriedade: "--tw-shadow", promessas: SOMBRA },
  { rotulo: "curva de movimento", chaveNoConfig: "transitionTimingFunction", prefixo: "ease", propriedade: "transition-timing-function", promessas: CURVA },
  { rotulo: "duração de movimento", chaveNoConfig: "transitionDuration", prefixo: "duration", propriedade: "transition-duration", promessas: DURACAO },
  { rotulo: "camadas (z-index)", chaveNoConfig: "zIndex", prefixo: "z", propriedade: "z-index", promessas: CAMADAS },
  { rotulo: "fontes", chaveNoConfig: "fontFamily", prefixo: "font", propriedade: "font-family", promessas: FONTES },
] as const;

/**
 * Tokens do config deliberadamente fora do inventário — nome da folha → razão.
 *
 * Hoje está vazio (as 105 folhas estão todas cobertas). O mecanismo existe
 * porque o teste de completude é intransigente: sem uma porta de saída
 * ESCRITA, o próximo token que não valha o custo entraria por cima do gate em
 * vez de por uma linha declarada aqui.
 */
const FORA_DO_INVENTARIO: Record<string, string> = {};

/** Classes de teste que não pertencem a nenhuma família (variante e componente). */
const CLASSES_AVULSAS = ["dark:bg-surface", "container"];

/* ────────────────────────────────────────────────────────────────────────────
 * Compilação — uma vez para o arquivo inteiro.
 * ──────────────────────────────────────────────────────────────────────────── */

/** selector normalizado → lista de declarações do topo (fora de @media). */
let regras = new Map<string, { prop: string; valor: string }[]>();
/** selector → declarações dentro de @media (só o `.container` usa hoje). */
let regrasEmMedia = new Map<string, { media: string; prop: string; valor: string }[]>();
let cssGerado = "";

/** Compila o Tailwind com `content` sintético — determinístico e barato. */
async function compilar(classes: string[]): Promise<string> {
  const resultado = await postcss([
    tailwindcss({ ...config, content: [{ raw: classes.join(" "), extension: "html" }] }),
  ]).process("@tailwind components;@tailwind utilities;", { from: undefined });
  return resultado.css;
}

function indexar(css: string) {
  const raiz = postcss.parse(css);
  const topo = new Map<string, { prop: string; valor: string }[]>();
  const media = new Map<string, { media: string; prop: string; valor: string }[]>();
  raiz.walkRules((regra) => {
    const decls = regra.nodes
      .filter((n): n is postcss.Declaration => n.type === "decl")
      .map((d) => ({ prop: d.prop, valor: d.value }));
    if (regra.parent?.type === "atrule") {
      const at = regra.parent as postcss.AtRule;
      const anterior = media.get(regra.selector) ?? [];
      media.set(
        regra.selector,
        anterior.concat(decls.map((d) => ({ media: `@${at.name} ${at.params}`, ...d }))),
      );
      return;
    }
    topo.set(regra.selector, decls);
  });
  return { topo, media };
}

/** `.duration-fast` a partir de `duration-fast`; escapa o `:` das variantes. */
const seletorDe = (classe: string) => `.${classe.replace(/:/g, "\\:")}`;

/** A declaração que a classe produz para uma propriedade, ou `undefined`. */
function declaracao(classe: string, propriedade: string): string | undefined {
  return regras.get(seletorDe(classe))?.find((d) => d.prop === propriedade)?.valor;
}

/** Todas as classes que este arquivo pede ao Tailwind. */
function todasAsClasses(): string[] {
  return [
    ...FAMILIAS.flatMap((f) => Object.keys(f.promessas)),
    ...CLASSES_AVULSAS,
    ...classesDasPrimitivas(),
  ];
}

/* ────────────────────────────────────────────────────────────────────────────
 * As quatro primitivas da issue — renderizadas, não lidas do fonte.
 *
 * Renderizar (em vez de `grep` no arquivo) prova a corrente inteira: o `cva`
 * monta a string, o `cn()`/tailwind-merge pode DESCARTAR uma classe que ele
 * julgue conflitante, e só o que sobra no `className` do elemento chega ao
 * navegador. Um grep no fonte não vê esse último passo.
 * ──────────────────────────────────────────────────────────────────────────── */

const PRIMITIVAS = [
  { nome: "Button", elemento: <Button>ok</Button> },
  { nome: "Badge", elemento: <Badge>ok</Badge> },
  { nome: "Input", elemento: <Input /> },
  { nome: "Textarea", elemento: <Textarea /> },
] as const;

function classesDaPrimitiva(indice: number): string[] {
  const { container } = render(PRIMITIVAS[indice].elemento);
  const alvo = container.firstElementChild;
  return (alvo?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

function classesDasPrimitivas(): string[] {
  return PRIMITIVAS.flatMap((_, i) => classesDaPrimitiva(i));
}

beforeAll(async () => {
  cssGerado = await compilar(todasAsClasses());
  const indexado = indexar(cssGerado);
  regras = indexado.topo;
  regrasEmMedia = indexado.media;
}, 120_000);

/* ════════════════════════════════════════════════════════════════════════════
 * 1. As utilitárias que o design system promete continuam sendo geradas — com
 *    a MESMA declaração. É o gate que a issue #239 pede como item zero.
 * ════════════════════════════════════════════════════════════════════════════ */
describe("o CSS gerado pelo tailwind.config.ts (rede da migração 3 → 4)", () => {
  for (const familia of FAMILIAS) {
    it(`família "${familia.rotulo}": toda utilitária existe e resolve para o token prometido`, () => {
      const esperado = familia.promessas;
      const obtido = Object.fromEntries(
        Object.keys(esperado).map((classe) => [
          classe,
          declaracao(classe, familia.propriedade) ?? "(NENHUMA REGRA GERADA)",
        ]),
      );
      expect(obtido).toEqual(esperado);
    });
  }

  it('o seletor de tema escuro continua sendo [data-theme="dark"], não a classe .dark', () => {
    // `darkMode: ["class", "[data-theme='dark']"]`. Se a migração cair no
    // default do Tailwind 4, TODA utilitária `dark:` passa a exigir
    // `class="dark"` no <html> — e o app escreve `data-theme`, então o tema
    // escuro inteiro para de existir sem um único erro de compilação.
    const seletores = [...regras.keys()].filter((s) => s.startsWith(seletorDe("dark:bg-surface")));
    expect(seletores).toHaveLength(1);
    expect(seletores[0]).toContain("[data-theme='dark']");
    expect(seletores[0]).not.toMatch(/\.dark\s/);
  });

  it("o container mantém centro, respiro de 2rem e teto de 1400px", () => {
    const container = regras.get(".container") ?? [];
    const decl = (p: string) => container.find((d) => d.prop === p)?.valor;
    expect(decl("margin-left")).toBe("auto");
    expect(decl("margin-right")).toBe("auto");
    expect(decl("padding-left")).toBe("2rem");
    expect(decl("padding-right")).toBe("2rem");
    expect(regrasEmMedia.get(".container")).toEqual([
      { media: "@media (min-width: 1400px)", prop: "max-width", valor: "1400px" },
    ]);
  });

  it("os globs de content varrem as quatro pastas que escrevem className", () => {
    // Perder um glob não quebra nada: o Tailwind só deixa de emitir as classes
    // que SÓ aquela pasta usa. O sintoma é telas sem estilo, com build verde.
    expect(config.content).toEqual([
      "./app/**/*.{ts,tsx}",
      "./components/**/*.{ts,tsx}",
      "./lib/**/*.{ts,tsx}",
      "./hooks/**/*.{ts,tsx}",
    ]);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 2. Completude — o inventário acima não pode envelhecer em silêncio.
 *
 *    Sem isto, o gate cobriria só o que existia no dia em que foi escrito:
 *    token novo no config entraria sem rede e ninguém notaria.
 * ════════════════════════════════════════════════════════════════════════════ */
describe("completude do inventário perante o tailwind.config.ts", () => {
  /**
   * Achata um bloco de tokens em nomes de folha; `DEFAULT` vira o pai.
   *
   * Array É folha: `fontFamily.sans` é uma PILHA de fontes, um valor só. Sem
   * este caso, o achatamento desce nos índices e inventa `font-sans-0`…`-6`.
   */
  function folhas(no: unknown, prefixo = ""): string[] {
    if (typeof no !== "object" || no === null || Array.isArray(no)) return [prefixo];
    return Object.entries(no as Record<string, unknown>).flatMap(([chave, valor]) => {
      const nome = chave === "DEFAULT" ? prefixo : prefixo ? `${prefixo}-${chave}` : chave;
      return folhas(valor, nome);
    });
  }

  const extend = config.theme?.extend as Record<string, unknown>;

  it("nenhum bloco novo apareceu em theme.extend sem uma família que o cubra", () => {
    expect(Object.keys(extend).sort()).toEqual(
      FAMILIAS.map((f) => f.chaveNoConfig).sort(),
    );
  });

  for (const familia of FAMILIAS) {
    it(`família "${familia.rotulo}": todo token do config está no inventário`, () => {
      const semRede = folhas(extend[familia.chaveNoConfig])
        .map((folha) => (folha === "" ? familia.prefixo : `${familia.prefixo}-${folha}`))
        .filter((classe) => !(classe in familia.promessas))
        .filter((classe) => !(classe in FORA_DO_INVENTARIO));
      expect(semRede).toEqual([]);
    });
  }

  it("o inventário cobre os 105 tokens medidos no config em e7d4a786", () => {
    // Catraca, não decoração: é o que impede que uma família inteira suma do
    // config E do inventário no mesmo commit, deixando os dois testes acima
    // verdes por vacuidade. Encolher este número é uma decisão consciente.
    const total = FAMILIAS.reduce((n, f) => n + Object.keys(f.promessas).length, 0);
    expect(total).toBe(105);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 3. Os `var()` que as utilitárias apontam existem de verdade.
 *
 *    Buraco irmão do primeiro, e igualmente invisível: `.bg-accent` pode
 *    compilar perfeitamente enquanto `--color-accent` some do `globals.css`.
 *    O navegador não reclama — só não pinta nada.
 * ════════════════════════════════════════════════════════════════════════════ */
describe("os tokens que o CSS gerado consome existem em app/globals.css", () => {
  const globals = fs.readFileSync(path.join(RAIZ, "app/globals.css"), "utf8");

  /** Declarações `--x:` do primeiro bloco com esse seletor no topo do arquivo. */
  function definidasEm(seletor: string): Set<string> {
    const inicio = globals.indexOf(`${seletor} {`);
    expect(inicio, `bloco "${seletor}" sumiu de app/globals.css`).toBeGreaterThan(-1);
    const corpo = globals.slice(inicio, globals.indexOf("\n}", inicio));
    return new Set([...corpo.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((m) => m[1]));
  }

  it("toda variável referenciada pelas utilitárias está declarada em :root", () => {
    const noRoot = definidasEm(":root");
    const usadas = new Set(
      [...cssGerado.matchAll(/var\((--[a-z0-9-]+)/g)]
        .map((m) => m[1])
        // `--tw-*` é encanamento interno do Tailwind, não token nosso.
        .filter((v) => !v.startsWith("--tw-"))
        // As duas fontes vêm do next/font em app/layout.tsx (teste próprio abaixo).
        .filter((v) => v !== "--font-atkinson" && v !== "--font-mono"),
    );
    expect([...usadas].filter((v) => !noRoot.has(v)).sort()).toEqual([]);
  });

  it("toda cor do tema claro tem contraparte no tema escuro", () => {
    // Uma cor sem par em [data-theme="dark"] herda o valor claro: no escuro a
    // tela ganha uma mancha clara. Medido em e7d4a786: 47 de 47 têm par.
    const claras = [...definidasEm(":root")].filter((v) => v.startsWith("--color-"));
    const escuras = definidasEm('[data-theme="dark"]');
    expect(claras.length).toBeGreaterThanOrEqual(47);
    expect(claras.filter((v) => !escuras.has(v)).sort()).toEqual([]);
  });

  it("as duas fontes do design system continuam vindo do next/font no layout raiz", () => {
    const layout = fs.readFileSync(path.join(RAIZ, "app/layout.tsx"), "utf8");
    expect(layout).toContain('variable: "--font-atkinson"');
    expect(layout).toContain('variable: "--font-mono"');
    // Declarar não basta: as duas variáveis precisam chegar ao elemento raiz,
    // senão `font-sans` cai no fallback do sistema em toda tela.
    expect(layout).toMatch(/className=\{`\$\{\w+\.variable\} \$\{\w+\.variable\}`\}/);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 4. As quatro primitivas nomeadas na issue #239.
 *
 *    button (155 importadores), badge (78), input (68) e textarea (28) são o
 *    consumidor REAL de `duration-fast`/`ease-out`, e é por não achá-lo que a
 *    varredura de tokens mortos concluiu que o bloco podia ser deletado. Este
 *    bloco é esse consumidor virando fato checado, para a próxima varredura
 *    cair aqui em vez de repetir a conclusão errada.
 * ════════════════════════════════════════════════════════════════════════════ */
describe("as quatro primitivas mais reusadas mantêm o movimento do design system", () => {
  PRIMITIVAS.forEach((primitiva, indice) => {
    it(`<${primitiva.nome}> anima com os tokens do produto, não com o default do Tailwind`, () => {
      const classes = classesDaPrimitiva(indice);
      expect(classes).toContain("duration-fast");
      expect(classes).toContain("ease-out");
      // E as classes que sobreviveram ao `cn()` geram MESMO a declaração:
      // sem o bloco `transitionDuration` no config, `duration-fast` continua
      // no className e simplesmente não vira regra nenhuma.
      expect(declaracao("duration-fast", "transition-duration")).toBe("var(--duration-fast)");
      expect(declaracao("ease-out", "transition-timing-function")).toBe("var(--ease-out)");
    });
  });

  it("a cascata continua deixando duration-fast VENCER o default de 150ms do transition-*", () => {
    // `transition-colors` e `transition-[...]` já trazem `150ms` +
    // `cubic-bezier(0.4, 0, 0.2, 1)` embutidos. Os tokens do produto só valem
    // porque `.duration-fast`/`.ease-out` vêm DEPOIS na folha, com a mesma
    // especificidade. Se a ordem inverter, o produto volta ao default do
    // Tailwind sem perder uma classe sequer — invisível a qualquer outro gate.
    const posicao = (seletor: string) => cssGerado.indexOf(`${seletor} {`);
    const transicoes = [...regras.keys()].filter((s) => s.startsWith(".transition"));
    expect(transicoes.length).toBeGreaterThan(0);
    for (const seletor of transicoes) {
      expect(posicao(seletor)).toBeLessThan(posicao(".duration-fast"));
      expect(posicao(seletor)).toBeLessThan(posicao(".ease-out"));
    }
  });
});
