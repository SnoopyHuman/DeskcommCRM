import { describe, expect, it } from "vitest";

/**
 * Entrada do canal Telegram.
 *
 * Diferente do zernio, o Telegram não assina o corpo — o segredo configurado
 * no `setWebhook` volta inteiro no header `X-Telegram-Bot-Api-Secret-Token`,
 * e a verificação é comparação de tempo constante entre dois valores, não
 * HMAC sobre `rawBody`. Ver o cabeçalho de `lib/channels/telegram/webhook.ts`.
 */
import { parseTelegramUpdate, verifyTelegramSecretToken } from "@/lib/channels/telegram/webhook";

describe("verifyTelegramSecretToken", () => {
  it("aceita quando os valores são iguais", () => {
    expect(verifyTelegramSecretToken("segredo-123", "segredo-123")).toBe(true);
  });

  it("recusa valores diferentes de mesmo comprimento", () => {
    expect(verifyTelegramSecretToken("segredo-abc", "segredo-xyz")).toBe(false);
  });

  it("recusa comprimentos diferentes sem lançar", () => {
    // `timingSafeEqual` lança com buffers de tamanhos diferentes — um throw
    // aqui viraria 500 em vez de 401.
    expect(() => verifyTelegramSecretToken("curto", "um-segredo-bem-mais-longo")).not.toThrow();
    expect(verifyTelegramSecretToken("curto", "um-segredo-bem-mais-longo")).toBe(false);
  });

  it("recusa quando não há header — 'não dá para verificar' nunca é 'passa'", () => {
    expect(verifyTelegramSecretToken(null, "segredo-123")).toBe(false);
  });
});

describe("parseTelegramUpdate", () => {
  it("lê um update válido com update_id numérico", () => {
    const corpo = JSON.stringify({
      update_id: 10000,
      message: {
        message_id: 1,
        chat: { id: 123, type: "private" },
        date: 1700000000,
        text: "oi",
      },
    });
    const r = parseTelegramUpdate(corpo);
    expect(r?.update_id).toBe(10000);
    expect(r?.message?.text).toBe("oi");
  });

  it("corpo que não é JSON válido devolve null, sem lançar", () => {
    expect(() => parseTelegramUpdate("{ isso não é json")).not.toThrow();
    expect(parseTelegramUpdate("{ isso não é json")).toBeNull();
  });

  it("JSON válido mas sem update_id numérico devolve null", () => {
    expect(parseTelegramUpdate(JSON.stringify({ message: { text: "oi" } }))).toBeNull();
    expect(parseTelegramUpdate(JSON.stringify({ update_id: "10000" }))).toBeNull();
  });
});
