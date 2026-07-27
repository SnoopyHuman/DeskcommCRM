import { beforeEach, describe, expect, it, vi } from "vitest";

import { __resetRealtimeAuth, authenticateRealtime } from "@/hooks/realtime/useRealtimeChannel";

/**
 * A memo do token do Realtime SÓ SOBREVIVE AO SUCESSO.
 *
 * O DEFEITO QUE ELE GUARDA, medido no banco antes de existir este teste: uma
 * assinatura de `crm_leads` ANÔNIMA (claims.sub nulo) convivendo, no MESMO
 * socket, com assinaturas de `conversations` autenticadas. Com RLS por
 * `auth.uid()`, anônimo devolve zero linhas — o canal responde SUBSCRIBED e
 * nunca entrega nada. Morte silenciosa: a tela parece viva.
 *
 * A causa era memoização de FALHA. Três saídas, só uma limpava a memo, e a que
 * limpava era a exceção — o caminho barulhento, que menos precisava. Um único
 * 401 transitório (sessão estabelecendo, cookie em renovação) deixava todos os
 * canais criados depois anônimos pelo resto do carregamento.
 *
 * ⚠️ O CRITÉRIO NÃO É "deu erro?" — é "o resultado memoizado é o DESEJADO?".
 * Sucesso parcial memoizado é pior que erro memoizado, porque erro alguém repete.
 */
function clienteFake() {
  return { realtime: { setAuth: vi.fn() } } as never;
}

describe("memo do token do Realtime", () => {
  beforeEach(() => {
    __resetRealtimeAuth();
    vi.restoreAllMocks();
  });

  it("401 transitório NÃO condena o carregamento inteiro", async () => {
    const supabase = clienteFake();
    const setAuth = (supabase as unknown as { realtime: { setAuth: ReturnType<typeof vi.fn> } })
      .realtime.setAuth;

    // 1ª: a sessão ainda está se estabelecendo.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    await authenticateRealtime(supabase);
    expect(setAuth).not.toHaveBeenCalled();

    // 2ª: já estabelecida. É AQUI que a versão antiga falhava — a memo guardava
    // a falha e esta chamada devolvia a promessa velha sem refazer nada.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { access_token: "t-1" } }) }),
    );
    await authenticateRealtime(supabase);
    expect(setAuth).toHaveBeenCalledWith("t-1");
  });

  it("resposta 200 SEM token também não é sucesso", async () => {
    // O caminho mais traiçoeiro dos três: `res.ok` é verdadeiro, nada falha, e
    // mesmo assim ninguém autenticou. Memoizar isto é memoizar sucesso parcial.
    const supabase = clienteFake();
    const setAuth = (supabase as unknown as { realtime: { setAuth: ReturnType<typeof vi.fn> } })
      .realtime.setAuth;

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) }));
    await authenticateRealtime(supabase);
    expect(setAuth).not.toHaveBeenCalled();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { access_token: "t-2" } }) }),
    );
    await authenticateRealtime(supabase);
    expect(setAuth).toHaveBeenCalledWith("t-2");
  });

  it("o SUCESSO é memoizado — N hooks não disparam N requisições", async () => {
    // A memo existe por uma razão legítima e o conserto não pode apagá-la.
    const supabase = clienteFake();
    const fetchSpy = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ data: { access_token: "t-3" } }) });
    vi.stubGlobal("fetch", fetchSpy);

    await Promise.all([
      authenticateRealtime(supabase),
      authenticateRealtime(supabase),
      authenticateRealtime(supabase),
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
