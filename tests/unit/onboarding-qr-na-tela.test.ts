/**
 * O PASSO DO WHATSAPP TEM DE MOSTRAR O QR CODE.
 *
 * ## O defeito, medido em 2026-08-20 no HEAD da `main`
 *
 * `app/onboarding/connect-whatsapp/_client.tsx` calculava `showQr` e `qrTick` e
 * **não renderizava imagem nenhuma**. A tela dizia, com todas as letras,
 * "Escaneie o código abaixo com o celular que vai atender" — e não havia código
 * abaixo. No passo em que o dono acabou de instalar o produto e está com o
 * celular na mão.
 *
 *   $ git log -S 'whatsapp/qr' -- app/onboarding/connect-whatsapp/_client.tsx
 *   3adbd5aa feat(onboarding): as duas telas que ainda falavam a língua do sistema
 *
 * O commit reescreveu a copy da tela e levou o `<img>` junto. Ficou sete dias na
 * `main` sem ninguém notar, e o motivo é o ponto:
 *
 *  - variável morta é **warning** no eslint deste repo, não erro. Medido:
 *    `npx eslint app/onboarding/connect-whatsapp/_client.tsx` → 2 problems,
 *    0 errors. `pnpm lint` seguia verde.
 *  - a única prova que OLHA esta tela é a J1.5 de `vps-fresh-onboarding.spec.ts`,
 *    que exige WAHA de pé — e que, até a issue #179, não rodava em job nenhum.
 *
 * ## Por que um teste estático, se a J1.5 já cobre
 *
 * Porque as duas custam coisas diferentes. A J1.5 é a prova de verdade (ela abre
 * o browser, espera o `naturalWidth` da imagem e prova que os bytes chegaram),
 * mas vive no job `e2e-onboarding-fresco`, que precisa de WAHA e **ainda não é
 * check obrigatório** — vermelho ali aparece e não barra merge. Este arquivo
 * roda no `verify`, que barra. Não substitui a J1.5: garante só que o elemento
 * não SUMA de novo por descuido de reescrita, que foi exatamente o que houve.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const TELA = path.join(RAIZ, "app", "onboarding", "connect-whatsapp", "_client.tsx");
const PROXY = path.join(RAIZ, "app", "api", "v1", "onboarding", "whatsapp", "qr", "route.ts");

const tela = readFileSync(TELA, "utf8");

describe("o passo de conectar o WhatsApp mostra o QR Code", () => {
  it("a tela renderiza uma imagem apontada para o proxy do QR", () => {
    expect(
      tela,
      "a tela do WhatsApp no onboarding não tem <img> apontando para " +
        "/api/v1/onboarding/whatsapp/qr. Ela já perdeu essa imagem uma vez (commit " +
        "3adbd5aa) e o texto continuou mandando escanear um código que não existia.",
    ).toContain("/api/v1/onboarding/whatsapp/qr");
    expect(tela, "o proxy do QR é referenciado, mas não por uma <img>").toMatch(/<img\b/);
  });

  it("a imagem é remontada a cada QR novo — senão o browser serve o código expirado", () => {
    // O QR do WAHA vale poucos minutos. Sem trocar a `key` (e o `?t=`) a cada
    // `SCAN_QR_CODE`, o React reaproveita o mesmo nó e o browser o cache: a
    // pessoa escaneia para sempre um código morto, e a tela não dá pista nenhuma.
    expect(tela, "a <img> do QR não usa `key={qrTick}`").toMatch(/key=\{qrTick\}/);
    expect(tela, "a URL do QR não carrega o contador que fura o cache").toMatch(/qr\?t=\$\{qrTick\}/);
  });

  it("a condição que decide mostrar o QR é USADA, não só calculada", () => {
    // O modo de falha exato de 3adbd5aa: `showQr` continuou sendo calculado e
    // deixou de ter consumidor. Uma variável sem consumidor é o anti-pattern nº 3
    // do CLAUDE.md em miniatura — e aqui o consumidor perdido era a tela.
    const usos = tela.match(/\bshowQr\b/g) ?? [];
    expect(
      usos.length,
      "`showQr` aparece uma vez só: está sendo calculado e ninguém o consome — " +
        "exatamente o estado em que a tela ficou sem QR por sete dias.",
    ).toBeGreaterThan(1);
  });

  it("o proxy que serve a imagem existe", () => {
    // Guarda o outro lado do par: apagar a rota deixaria a <img> quebrada, e o
    // teste de cima seguiria verde.
    const rota = readFileSync(PROXY, "utf8");
    expect(rota).toMatch(/auth\/qr\?format=image/);
  });
});
