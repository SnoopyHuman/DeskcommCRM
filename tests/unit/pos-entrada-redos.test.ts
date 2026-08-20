/**
 * O detector de opt-out roda DENTRO da request do webhook, no event loop único
 * do contêiner (`app/api/v1/webhooks/waha/[token]/route.ts` faz `await
 * dispatchWahaEvent(...)` com `runtime = "nodejs"`), e recebe o corpo INTEIRO
 * da mensagem — `lib/waha/ingest.ts` e `lib/channels/zernio/ingest.ts` passam
 * `texto` sem truncar. Uma regex quadrática aqui congela TODOS os tenants
 * daquela instalação por dezenas de segundos, e o transporte reentrega por
 * timeout, multiplicando o dano.
 *
 * Não é hipótese: a mesma classe (js/polynomial-redos) foi removida deste mesmo
 * caminho pelo PR #241, e voltou pelo PR #275 num padrão novo — medido em
 * 21.391 ms para uma mensagem de 65 mil caracteres, contra 0–6 ms na `main`
 * daquele dia.
 *
 * A régua é TEMPO, e não presença de símbolo: um grep por `\\p{P}*` não
 * distingue o padrão perigoso do inofensivo, e a próxima regex não vai ter a
 * mesma forma. E o caso afirma também o VEREDITO, senão um refactor que faça a
 * entrada cair em "nao" cedo demais deixa de exercitar o caminho caro e o teste
 * fica verde sem medir nada.
 */
import { describe, expect, it } from "vitest";

import { lerPedidoDeSaida } from "@/lib/channels/pos-entrada";

/** Folgado de propósito: pega ordem de grandeza, não jitter de CI. */
const TETO_MS = 1_000;

function cronometrar(texto: string): { ms: number; veredito: string } {
  const t0 = process.hrtime.bigint();
  const veredito = lerPedidoDeSaida(texto);
  const t1 = process.hrtime.bigint();
  return { ms: Number(t1 - t0) / 1e6, veredito };
}

describe("lerPedidoDeSaida não trava com mensagem longa", () => {
  // Aquece o JIT com o caminho barato, para o primeiro caso não pagar compilação.
  it("aquecimento", () => {
    for (let i = 0; i < 2_000; i++) lerPedidoDeSaida("oi tudo bem");
    expect(lerPedidoDeSaida("STOP")).toBe("pediu");
  });

  const ataques: Array<[string, string]> = [
    ["pontuação depois da palavra", "STOP" + ".".repeat(65_000) + "x"],
    ["espaço depois da palavra", "PARAR" + " ".repeat(30_000) + "x"],
    ["hífen depois da palavra", "baja" + "-".repeat(20_000) + "z"],
    ["emoji depois da palavra", "STOP" + "🙏".repeat(20_000) + "x"],
  ];

  for (const [nome, texto] of ataques) {
    it(`${nome}: ${texto.length} chars decidem em menos de ${TETO_MS} ms`, () => {
      const { ms, veredito } = cronometrar(texto);
      expect(ms, `levou ${ms.toFixed(1)} ms`).toBeLessThan(TETO_MS);
      // Guarda de vacuidade: a entrada precisa chegar ao caminho caro. Com a
      // palavra presente e lixo em volta, a leitura correta é "talvez" — se um
      // dia isto virar "nao" cedo demais, o teste para de medir o que mediu.
      expect(veredito, "a entrada precisa exercitar o caminho da regex").toBe("talvez");
    });
  }

  it("o pedido curto de verdade continua bloqueando — o teto não engoliu o caso bom", () => {
    for (const bom of ["STOP", "stop!", "*STOP*", "PARAR por favor", "BAJA", "🛑 STOP", "Stop 🙏"]) {
      expect(lerPedidoDeSaida(bom), `"${bom}" tem de ser pedido`).toBe("pediu");
    }
  });

  it("mensagem longa que É só o pedido em volta de lixo NÃO vira pedido silencioso", () => {
    // Acima do teto, a leitura cai para "talvez": não bloqueia sozinho, abre
    // aviso. É a degradação certa — o erro caro é bloquear quem não pediu.
    expect(lerPedidoDeSaida("STOP" + ".".repeat(200))).toBe("talvez");
  });
});
