/**
 * A AUTOMAÇÃO NÃO PODE CARIMBAR "SUCESSO" NUMA MENSAGEM QUE NÃO SAIU.
 *
 * ═══ O defeito, medido antes do conserto ═══
 *
 * `sendMessageHandler` não lança quando o envio falha: ele marca a LINHA da
 * mensagem (`status='failed'` + `error_code`) ou a deixa em `queued`, e devolve
 * a mensagem normalmente — porque quem o chama pela tela é o Inbox, que
 * renderiza a bolha com o estado dela.
 *
 * A ação da automação só olhava se houve exceção. Reproduzido neste repo com
 * WAHA fora do ar e a regra ligada exatamente como a tela a monta:
 *
 *     automation_rule_runs.status = 'success'   ← ✓ verde na aba Atividade
 *     messages.status             = 'failed'
 *     messages.error_code         = 'waha_error'
 *
 * O cliente não recebeu nada e a tela disse que deu certo. Tela que afirma
 * sucesso é pior que tela silenciosa: quem a lê para de procurar.
 *
 * ═══ O que este arquivo vigia ═══
 *
 * A tradução PURA de estado-da-mensagem → desfecho-do-run. É onde a decisão
 * mora, e é o que precisa continuar valendo para as DUAS ações de envio
 * (`send_whatsapp_message` e `send_ai_message`) — o último caso abaixo é o que
 * reprova se alguém escrever uma terceira ação de envio traduzindo por conta
 * própria.
 */
import { describe, expect, it } from "vitest";

import { desfechoDoEnvio } from "@/lib/automation/desfecho-do-envio";
import { fraseDaFalhaDeCanal } from "@/lib/channels/frases-de-falha";

describe("desfechoDoEnvio — o run conta o que aconteceu com a mensagem", () => {
  it("mensagem enviada vira sucesso", () => {
    const d = desfechoDoEnvio("send_whatsapp_message", { id: "m1", status: "sent" });
    expect(d.status).toBe("success");
  });

  it.each(["delivered", "read"])("mensagem %s também é sucesso (o adapter já confirmou)", (s) => {
    expect(desfechoDoEnvio("send_whatsapp_message", { id: "m1", status: s }).status).toBe("success");
  });

  it("O DEFEITO: mensagem em falha NÃO vira sucesso", () => {
    const d = desfechoDoEnvio("send_whatsapp_message", {
      id: "m1",
      status: "failed",
      error_code: "waha_error",
      error_message: "fetch failed",
    });
    expect(d.status).toBe("failed");
  });

  it("a falha chega com frase de gente, não com o código do adapter", () => {
    const d = desfechoDoEnvio("send_whatsapp_message", {
      id: "m1",
      status: "failed",
      error_code: "waha_error",
      error_message: "fetch failed",
    });
    // Quem lê a aba Atividade é quem montou a automação, não quem escreveu o adapter.
    expect(d.error).toContain("serviço de WhatsApp");
    expect(d.error).not.toBe("fetch failed");
  });

  it("erro SEM tradução conhecida ainda diz alguma coisa — nunca fica mudo", () => {
    const d = desfechoDoEnvio("send_whatsapp_message", {
      id: "m1",
      status: "failed",
      error_code: "codigo_que_ninguem_mapeou",
      error_message: "explosão inesperada",
    });
    expect(d.status).toBe("failed");
    expect(d.error).toBe("explosão inesperada");
  });

  it("mensagem na fila vira ADIADO, não falha — ela ainda pode sair", () => {
    const d = desfechoDoEnvio("send_whatsapp_message", {
      id: "m1",
      status: "queued",
      metadata: { queued_reason: "channel_session_not_working" },
    });
    // `failed` faria quem lê desistir de uma mensagem que o watchdog resgata
    // quando o número reconectar.
    expect(d.status).toBe("postponed");
    expect(String(d.detail?.explicacao)).toContain("não está conectado");
  });

  it("fila SEM motivo declarado ainda explica a espera", () => {
    const d = desfechoDoEnvio("send_whatsapp_message", { id: "m1", status: "queued" });
    expect(d.status).toBe("postponed");
    expect(d.detail?.reason).toBe("aguardando_o_canal");
    expect(String(d.detail?.explicacao)).not.toBe("");
  });

  it("estado DESCONHECIDO falha aberto na informação — nunca vira sucesso por omissão", () => {
    // Um status novo em `messages` (hoje inexistente) não pode ser lido como
    // "deu certo" só porque não é `failed`.
    const d = desfechoDoEnvio("send_whatsapp_message", { id: "m1", status: "status_do_futuro" });
    expect(d.status).toBe("failed");
  });

  it("o id da mensagem viaja no detalhe em todos os desfechos", () => {
    for (const status of ["sent", "failed", "queued", "status_do_futuro"]) {
      const d = desfechoDoEnvio("x", { id: "m-abc", status });
      expect(d.detail?.message_id).toBe("m-abc");
    }
  });

  it("o tipo da ação é preservado — a tela rotula por ele", () => {
    expect(desfechoDoEnvio("send_ai_message", { id: "m1", status: "sent" }).type).toBe(
      "send_ai_message",
    );
  });

  it("a tradução devolve null para código desconhecido — quem chama decide o texto de reserva", () => {
    // Uma frase genérica inventada no lugar do `null` apagaria a mensagem
    // original do provedor, que às vezes é a única pista real.
    expect(fraseDaFalhaDeCanal("nao_existe")).toBeNull();
    expect(fraseDaFalhaDeCanal(null)).toBeNull();
    expect(fraseDaFalhaDeCanal("channel_archived")).toContain("excluído");
  });
});

describe("as duas ações de envio usam o MESMO tradutor", () => {
  it("nenhuma ação de automação deriva o desfecho de conta própria", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");

    const dir = join(process.cwd(), "lib", "automation", "actions");
    const acoes = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

    // Guarda de vacuidade: se a varredura parar de achar arquivos, ela não
    // estaria provando nada.
    expect(acoes.length).toBeGreaterThan(3);

    const culpadas: string[] = [];
    for (const arquivo of acoes) {
      const src = readFileSync(join(dir, arquivo), "utf8");
      // Quem chama o handler de envio TEM que passar o RETORNO dele pelo
      // tradutor. Uma ação que chame `sendMessageHandler` e monte o resultado à
      // mão está replantando o defeito.
      //
      // A checagem é pela CHAMADA (`reportarEnvio(`), não pela menção do nome:
      // medido por sabotagem, a versão anterior — `src.includes("reportarEnvio")`
      // — passava VERDE com o desfecho montado à mão e um `void reportarEnvio;`
      // sobrando no arquivo, que é exatamente a forma que um refactor
      // apressado deixaria.
      //
      // PONTO CEGO DECLARADO: chamar `reportarEnvio(...)` e ignorar o retorno
      // ainda engana esta varredura. Fechar isso exigiria AST, e o custo não se
      // paga aqui — os casos de comportamento acima é que provam a tradução; a
      // varredura existe para pegar a ação NOVA que nasce sem ela.
      if (/\bsendMessageHandler\s*\(/.test(src) && !/\breportarEnvio\s*\(/.test(src)) {
        culpadas.push(arquivo);
      }
    }
    expect(culpadas).toEqual([]);
  });
});

/**
 * O AGREGADOR — o andar de cima do mesmo defeito.
 *
 * `desfechoDoEnvio` (acima) passou a devolver `postponed` honestamente. Mas quem
 * escreve `automation_rule_runs.status` é o motor, e ele fazia:
 *
 *     const failed = results.filter(r => r.status === "failed").length;
 *     const status = failed === 0 ? "success" : …
 *
 * Uma ação `postponed` conta ZERO falhas → o run vira **"Sucesso"** verde na
 * tela, para uma mensagem que ficou em `queued` e não chegou ao cliente. Ou
 * seja: o defeito que esta entrega veio matar, ressuscitado um nível acima,
 * porque o conserto foi por instância e não por classe.
 *
 * Achado em revisão adversarial — os casos de comportamento acima passavam
 * todos, e nenhum deles olhava para a agregação. Este bloco é a rede que
 * faltava.
 *
 * A regra vive dentro de `runAutomationForEvent`, que exige banco e event_log;
 * o que se testa aqui é a REGRA, extraída como a função pura que o motor aplica.
 * Se alguém mudar o motor sem mudar esta função, o `it` final reprova — ele
 * compara os dois lendo o fonte.
 */
describe("o agregador do run também diz a verdade", () => {
  /** Espelha a regra do motor. Mantida em sincronia pelo caso final deste bloco. */
  function statusDoRun(statuses: string[]): string {
    const failed = statuses.filter((s) => s === "failed").length;
    const adiados = statuses.filter((s) => s === "postponed").length;
    return failed > 0
      ? failed === statuses.length
        ? "failed"
        : "partial"
      : adiados > 0
        ? "adiado"
        : "success";
  }

  it("O DEFEITO: uma ação adiada NÃO vira run de sucesso", () => {
    expect(statusDoRun(["postponed"])).toBe("adiado");
  });

  it("sucesso + adiada = adiado — algo ainda não chegou ao cliente", () => {
    // "success" mentiria (nem tudo chegou) e "partial" mentiria ao contrário
    // (nada falhou). O honesto é dizer que ainda há coisa a caminho.
    expect(statusDoRun(["success", "postponed"])).toBe("adiado");
  });

  it("falha VENCE adiamento — quem lê precisa saber que algo quebrou", () => {
    expect(statusDoRun(["failed", "postponed"])).toBe("partial");
  });

  it("tudo falhou continua sendo failed", () => {
    expect(statusDoRun(["failed", "failed"])).toBe("failed");
  });

  it("tudo funcionou continua sendo success", () => {
    expect(statusDoRun(["success", "success"])).toBe("success");
  });

  it("pular não é adiar: uma ação `skipped` não segura o run em adiado", () => {
    // `skipped` é desfecho TERMINAL (contato bloqueado, sem telefone) — nada
    // vai chegar depois. Tratá-lo como adiado prometeria uma mensagem que não
    // existe.
    expect(statusDoRun(["success", "skipped"])).toBe("success");
  });

  it("a regra do motor e a deste teste são a MESMA — senão a rede vigia outra coisa", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const fonte = readFileSync(join(process.cwd(), "lib", "automation", "engine.ts"), "utf8");

    // Não compara texto formatado (o prettier reescreveria e daria falso
    // vermelho): compara os PEDAÇOS que carregam a decisão.
    expect(fonte).toContain('results.filter((r) => r.status === "postponed")');
    expect(fonte).toContain('adiados > 0');
    // E o que NÃO pode voltar: o ternário antigo, que ignorava o adiamento.
    expect(fonte).not.toContain('const status = failed === 0 ? "success"');
  });
});
