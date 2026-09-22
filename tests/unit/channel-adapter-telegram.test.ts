import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Adapter do canal Telegram — o transporte.
 *
 * Mesmo padrão do teste do zernio: mocka o admin client e a resolução de
 * credencial diretamente (`resolveTelegramCreds`), e deixa só as chamadas à
 * Bot API passarem pelo `fetch` espionado. Evita depender de rede/Supabase de
 * verdade neste teste unitário.
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

const credsRef: { current: unknown } = { current: null };
vi.mock("@/lib/channels/telegram/credentials", () => ({
  resolveTelegramCreds: async () => credsRef.current,
}));

import { telegramAdapter } from "@/lib/channels/adapters/telegram";

const CREDS = {
  botId: "123456",
  token: "123456:ABC-DEF",
  baseUrl: "https://api.telegram.org",
  source: "session" as const,
};

const ORG = "00000000-0000-4000-8000-000000000381";

function respondeOk(result: Record<string, unknown>) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result }),
  });
}

function respondeErro(status: number, error_code: number, description: string) {
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => ({ ok: false, error_code, description }),
  });
}

const ultimaChamada = () => ({
  url: String(fetchMock.mock.calls.at(-1)?.[0] ?? ""),
  init: (fetchMock.mock.calls.at(-1)?.[1] ?? {}) as { body?: string },
});
const corpo = () => JSON.parse(ultimaChamada().init.body ?? "{}") as Record<string, unknown>;

beforeEach(() => {
  fetchMock.mockReset();
  credsRef.current = CREDS;
});

describe("resolveRecipient", () => {
  it("grupo com groupChatId devolve o chatId do grupo", () => {
    expect(
      telegramAdapter.resolveRecipient({
        isGroup: true,
        groupChatId: "-1001234567890",
        phoneNumber: null,
        waIdentity: null,
      }),
    ).toBe("-1001234567890");
  });

  it("grupo sem groupChatId devolve null", () => {
    expect(
      telegramAdapter.resolveRecipient({
        isGroup: true,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: null,
      }),
    ).toBeNull();
  });

  // Chat privado endereça por THREAD (`conversations.provider_conversation_id`,
  // lido em `send()` via `envelope.providerConversationId`), não por atributo
  // do contato — mesmo padrão de `lib/channels/social/adapter.ts`
  // (zernio_social). `resolveRecipient` devolve só a sentinela
  // `"provider-thread"`: não é um endereço de verdade, é o sinal de "canal
  // aplicável" que o handler usa para decidir fila/erro de destinatário.
  it("não-grupo devolve a sentinela 'provider-thread', não um chat_id", () => {
    expect(
      telegramAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: null,
      }),
    ).toBe("provider-thread");
  });
});

// `isConfigured` existe porque `send` devolvendo `{externalId:null}` colapsa
// "não tentei" com "tentei e falhei" — desfechos que o chamador trata
// diferente. Sempre `true` porque a credencial pode viver só na sessão
// cifrada, que este método síncrono não pode consultar.
it("isConfigured é sempre true, mesmo sem nenhuma env/credencial", () => {
  expect(telegramAdapter.isConfigured()).toBe(true);
});

describe("send", () => {
  it("texto: caminho feliz compõe externalId como \"<chat_id>:<message_id>\"", async () => {
    respondeOk({ message_id: 42, chat: { id: 123 } });

    const res = await telegramAdapter.send({
      organizationId: ORG,
      sessionRef: "123456",
      to: "provider-thread",
      providerConversationId: "123",
      kind: "text",
      body: "oi",
    });

    expect(res).toEqual({ externalId: "123:42" });
    expect(ultimaChamada().url).toContain("/sendMessage");
    expect(corpo()).toEqual({ chat_id: "123", text: "oi" });
  });

  // O `chat_id` de verdade vem de `providerConversationId`, nunca de `to` — a
  // ausência dele NÃO é caso raro: é o estado normal antes da primeira
  // mensagem do cliente (bots não iniciam conversa no Telegram).
  it("sem providerConversationId, lança telegram_no_conversation e nada sai pela rede", async () => {
    await expect(
      telegramAdapter.send({
        organizationId: ORG,
        sessionRef: "123456",
        to: "provider-thread",
        kind: "text",
        body: "oi",
      }),
    ).rejects.toThrow("telegram_no_conversation");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falha do provedor lança contendo telegram_send_failed", async () => {
    respondeErro(400, 400, "Bad Request");

    await expect(
      telegramAdapter.send({
        organizationId: ORG,
        sessionRef: "123456",
        to: "provider-thread",
        providerConversationId: "123",
        kind: "text",
        body: "oi",
      }),
    ).rejects.toThrow(telegramAdapter.codes.sendFailed);
  });

  // Sem credencial nem na sessão nem no ambiente: `resolveTelegramCreds`
  // devolve `null` (aqui simulado via `credsRef`), e `send` deve LANÇAR em vez
  // de devolver `{externalId: null}` — colapsar os dois desfechos faria o
  // chamador gravar `sent` para algo que nunca saiu.
  it("sem credencial nenhuma, lança telegram_not_configured e nada sai pela rede", async () => {
    credsRef.current = null;

    await expect(
      telegramAdapter.send({
        organizationId: ORG,
        sessionRef: "123456",
        to: "provider-thread",
        providerConversationId: "123",
        kind: "text",
        body: "oi",
      }),
    ).rejects.toThrow(telegramAdapter.codes.notConfigured);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("checkHealth", () => {
  it("401 é token revogado — status FAILED", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });

    const h = await telegramAdapter.checkHealth!({ organizationId: ORG, sessionRef: "123456" });
    expect(h).toEqual({ reachable: true, status: "FAILED", detail: null });
  });

  it("ok:true é status WORKING", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, result: {} }) });

    const h = await telegramAdapter.checkHealth!({ organizationId: ORG, sessionRef: "123456" });
    expect(h).toEqual({ reachable: true, status: "WORKING", detail: null });
  });
});
