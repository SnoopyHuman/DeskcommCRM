import { afterEach, describe, expect, it, vi } from "vitest";

import {
  conexaoWahaDoEnv,
  definirPresenca,
  idsParaSendSeen,
  marcarComoLida,
} from "@/lib/waha/presence";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("conexaoWahaDoEnv", () => {
  it("null sem env configurado", () => {
    vi.stubEnv("WAHA_API_BASE_URL", "");
    vi.stubEnv("WAHA_API_KEY", "");
    expect(conexaoWahaDoEnv()).toBeNull();
  });

  it("null com o placeholder de dev", () => {
    vi.stubEnv("WAHA_API_BASE_URL", "http://localhost:3030");
    vi.stubEnv("WAHA_API_KEY", "dev_plaintext_change_me");
    expect(conexaoWahaDoEnv()).toBeNull();
  });

  it("conexão válida com env preenchido", () => {
    vi.stubEnv("WAHA_API_BASE_URL", "http://localhost:3030");
    vi.stubEnv("WAHA_API_KEY", "hash123");
    expect(conexaoWahaDoEnv()).toEqual({
      baseUrl: "http://localhost:3030",
      apiKey: "hash123",
    });
  });
});

describe("definirPresenca", () => {
  const conn = { baseUrl: "http://localhost:3030", apiKey: "hash123" };

  it("POSTa presence no endpoint da sessão", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await definirPresenca(conn, "default", "5531999998888@c.us", "typing");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3030/api/default/presence");
    expect((init.headers as Record<string, string>)["X-Api-Key"]).toBe("hash123");
    expect(JSON.parse(String(init.body))).toEqual({
      chatId: "5531999998888@c.us",
      presence: "typing",
    });
  });

  it("nunca lança — falha de rede é engolida (presença é cosmética)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(
      definirPresenca(conn, "default", "5531999998888@c.us", "typing"),
    ).resolves.toBeUndefined();
  });

  it("nunca lança — resposta não-OK também é engolida", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    await expect(
      definirPresenca(conn, "default", "5531999998888@c.us", "paused"),
    ).resolves.toBeUndefined();
  });
});

describe("idsParaSendSeen", () => {
  it("passa id completo intacto", () => {
    expect(idsParaSendSeen("5511@c.us", "false_5511@c.us_ABC")).toEqual([
      "false_5511@c.us_ABC",
    ]);
  });

  it("monta formato completo a partir do bare id (NOWEB envia bare às vezes)", () => {
    expect(idsParaSendSeen("5511@lid", "3EB0ABC")).toEqual(["false_5511@lid_3EB0ABC"]);
  });

  it("undefined sem messageId", () => {
    expect(idsParaSendSeen("5511@c.us", null)).toBeUndefined();
    expect(idsParaSendSeen("5511@c.us", undefined)).toBeUndefined();
  });
});

describe("marcarComoLida", () => {
  const conn = { baseUrl: "http://localhost:3030", apiKey: "hash123" };

  it("POSTa sendSeen com messageIds (obrigatório no NOWEB pra pintar ✓✓)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await marcarComoLida(
      conn,
      "default",
      "5531999998888@c.us",
      "false_5531999998888@c.us_ABC123",
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3030/api/sendSeen");
    expect(JSON.parse(String(init.body))).toEqual({
      session: "default",
      chatId: "5531999998888@c.us",
      messageIds: ["false_5531999998888@c.us_ABC123"],
    });
  });

  it("sem messageId: cai no endpoint de ler unread do chat", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await marcarComoLida(conn, "default", "5531999998888@c.us");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://localhost:3030/api/default/chats/5531999998888%40c.us/messages/read",
    );
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  it("nunca lança em falha", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    await expect(marcarComoLida(conn, "default", "x@c.us", "id1")).resolves.toBeUndefined();
  });
});
