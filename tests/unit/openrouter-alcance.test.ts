/**
 * Invariante de ALCANCE: o que a `OPENROUTER_API_KEY` roteia — e o que ela não
 * roteia.
 *
 * Por que este arquivo existe: o `.env.example` afirma ao self-hoster quais
 * caminhos passam a usar a OpenRouter quando ele preenche a chave. Afirmação em
 * comentário não se defende sozinha — a primeira pessoa que ligar o resolver a
 * um caminho novo não vai lembrar de reescrever o aviso, e o usuário decide a
 * configuração da instalação lendo justamente esse aviso.
 *
 * O alcance real hoje, medido: `resolveLanguageModel()` é chamado por
 * `ai-sentiment-worker` (classificação de sentimento) e `ai-response-worker`
 * (bot de resposta). NENHUM dos dois passa `tools` ao SDK. O agente do CRM, que
 * opera por ferramentas, roda por outro caminho — `lib/agent-engine/edge/llm/
 * providers.ts` (credencial BYOK por organização) e `buildModel()` em
 * `lib/ai/runtime/agent.ts` —, e nenhum deles conhece a OpenRouter.
 *
 * Isso importa porque muda QUAL risco o usuário corre. Um modelo sem tool
 * calling sólido é catastrófico num turno com ferramentas (responde texto
 * plausível e nunca cria o lead nem move o card) e é inofensivo numa
 * classificação de sentimento. Enquanto a OpenRouter não alcançar o primeiro
 * grupo, o aviso não deve assustar com ele; no dia em que alcançar, o aviso
 * PRECISA assustar — e este teste é quem obriga a decidir isso conscientemente.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { validarBinding } from "@/lib/ai/pontos/validar-binding";

const RAIZ = resolve(__dirname, "../..");

/** Arquivos de produção que importam o resolver (exclui testes e o próprio módulo). */
function chamadoresDoResolver(): string[] {
  const saida = execFileSync(
    "git",
    ["grep", "-l", "resolveLanguageModel", "--", "lib", "workers", "app", "scripts"],
    { cwd: RAIZ, encoding: "utf8" },
  );
  return saida
    .split("\n")
    .filter(Boolean)
    .filter((f) => !f.includes(".test.") && f !== "lib/ai/gateway.ts" && f !== "lib/env.ts");
}

describe("alcance da OPENROUTER_API_KEY", () => {
  it("o resolver tem chamadores — senão o invariante estaria passando por vacuidade", () => {
    // Sem esta asserção, apagar o resolver deixaria o teste abaixo verde e o
    // aviso do .env.example desprotegido.
    expect(chamadoresDoResolver().length).toBeGreaterThan(0);
  });

  it("os caminhos do resolver por env seguem sem ferramentas", () => {
    const comFerramentas = chamadoresDoResolver().filter((arquivo) =>
      /\btools\s*:/.test(readFileSync(resolve(RAIZ, arquivo), "utf8")),
    );

    expect(
      comFerramentas,
      comFerramentas.length
        ? `${comFerramentas.join(", ")} passa(m) ferramentas ao modelo E resolve(m) pela OpenRouter. ` +
            "O aviso sobre tool calling em .env.example / .env.hostgator.example foi escrito quando " +
            "isso NÃO acontecia e agora está desatualizado: reescreva-o antes de liberar este caminho."
        : undefined,
    ).toEqual([]);
  });

  it("o agente com ferramentas AGORA está ao alcance da OpenRouter — e isso é deliberado", () => {
    // ─── A virada, e por que ela não afrouxa este arquivo ──────────────────
    //
    // Este teste dizia "continua fora do alcance" e o cabeçalho avisava: "no
    // dia em que alcançar, o aviso PRECISA assustar — e este teste é quem
    // obriga a decidir isso conscientemente". O dia chegou: a migration 0127
    // abriu `provider` como vocabulário aberto e `createDefaultRegistry`
    // registra `openrouter`, então uma chave da OpenRouter pode atender o ponto
    // que cria o lead.
    //
    // A guarda não foi removida — ela MUDOU DE ALVO. Antes protegia uma
    // ausência (o caminho não existe); agora protege a proteção (o caminho
    // existe e é vigiado). Apagar o teste teria devolvido verde e deixado o
    // risco solto, que é o pior desfecho possível para um invariante incômodo.
    expect(
      readFileSync(resolve(RAIZ, "lib/agent-engine/edge/llm/providers.ts"), "utf8").toLowerCase(),
    ).toContain("openrouter");
  });

  it("o risco novo tem catraca: modelo sem ferramentas é RECUSADO no ponto que cria o lead", () => {
    // É o desfecho que a abertura da OpenRouter torna possível e que ninguém
    // veria acontecer: o agente conversa bem, o cliente é atendido, e nada
    // chega ao funil — sem erro na tela.
    const semFerramentas = {
      model_id: "algum/modelo-sem-tools",
      supports_tools: false,
      supports_vision: false,
      conhecido: true,
    };
    for (const ponto of ["agent_turn", "operator_turn"]) {
      const r = validarBinding({ pontoId: ponto, modelo: semFerramentas });
      expect(r.ok, `${ponto} aceitou modelo sem ferramentas`).toBe(false);
      if (!r.ok) expect(r.codigo).toBe("modelo_sem_ferramentas");
    }
  });

  it("a catraca não é geral demais — classificador aceita modelo sem ferramentas", () => {
    // A recíproca. Recusar em todo ponto seria fechar o caso de uso mais
    // atraente da OpenRouter (modelo barato para classificar) e o teste acima
    // passaria igual.
    const r = validarBinding({
      pontoId: "stage_classifier",
      modelo: {
        model_id: "algum/modelo-barato",
        supports_tools: false,
        supports_vision: false,
        conhecido: true,
      },
    });
    expect(r.ok).toBe(true);
  });

  it("modelo fora do catálogo passa — a catraca falha ABERTO, e isso é decisão, não descuido", () => {
    // O caso que a instalação fresca vive: `ai_models` nasce semeada só com a
    // curadoria manual (anthropic/openai/google — ver o apêndice do
    // `baseline.sql`), e as linhas da OpenRouter só existem depois que o cron
    // `sync-model-catalog` roda pela primeira vez (diário, 15 4 * * *). Até lá,
    // TODO modelo da OpenRouter é `conhecido: false`.
    //
    // Falhar aberto é a escolha certa — recusar fecharia o caminho que
    // `base_url` existe para abrir (endpoint próprio, modelo local, que por
    // definição não estão no catálogo de ninguém). Mas é uma escolha, e o
    // `.env.example` afirma ao self-hoster que "o painel RECUSA salvar um
    // modelo sem ferramentas". A afirmação vale com catálogo; sem catálogo, o
    // que sobra é o AVISO. Este caso congela as duas metades juntas: se um dia
    // alguém trocar o desfecho, que troque sabendo qual frase deixa de ser
    // verdade.
    const foraDoCatalogo = {
      model_id: "fabricante-novo/modelo-que-ninguem-catalogou",
      supports_tools: false,
      supports_vision: false,
      conhecido: false,
    };
    const r = validarBinding({ pontoId: "agent_turn", modelo: foraDoCatalogo });
    expect(r.ok, "modelo fora do catálogo passou a ser RECUSADO — o caminho de endpoint próprio fechou").toBe(
      true,
    );
    // Passar calado seria a falha-em-verde: a pessoa configura o ponto que cria
    // o lead com um modelo cuja capacidade ninguém verificou, e nada na tela
    // diz que a verificação não aconteceu.
    if (r.ok) {
      expect(r.avisos.length, "passou sem avisar que não deu para verificar o modelo").toBeGreaterThan(0);
      expect(r.avisos.join(" ").toLowerCase()).toContain("catálogo");
    }
  });

  it("o aviso do .env.example acompanhou a virada", () => {
    // O cabeçalho deste arquivo existe por isto: o self-hoster decide a
    // configuração lendo o aviso, e um aviso escrito quando a OpenRouter não
    // alcançava o agente passou a mentir no instante em que ela alcançou.
    const aviso = readFileSync(resolve(RAIZ, ".env.example"), "utf8");
    const trecho = aviso.slice(aviso.toLowerCase().indexOf("openrouter"));
    expect(
      trecho.toLowerCase(),
      "o .env.example precisa avisar que a escolha do modelo agora afeta o agente com ferramentas",
    ).toMatch(/ferramenta|tool/);
  });
});
