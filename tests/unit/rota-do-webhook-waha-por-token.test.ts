import { describe, expect, it, vi } from "vitest";

/**
 * A ROTA `/api/v1/webhooks/waha/[token]` — o ponto de chamada, não a função.
 *
 * `contrato-do-webhook-waha.test.ts` mede o schema e exercita a rota GLOBAL
 * (`/webhooks/waha`). Esta aqui é a outra: a per-tenant, que é a que o WAHA de
 * produção chama e a única das duas alcançável da internet — a global fica
 * atrás de um 403 do Caddy. Sem este arquivo, o conserto inteiro da rota por
 * token podia ser revertido ao `JSON.parse(rawBody) as WahaEnvelope` e a suíte
 * de unidade continuava verde: os schemas estão cobertos, o CALL SITE não
 * estava.
 *
 * O que se mede aqui é só o que pertence à rota — os dois estágios e a ORDEM
 * entre eles, o desfecho HTTP e o que chega (ou não) ao dispatch. A forma do
 * schema é assunto do outro arquivo e não se repete.
 */

const TOKEN = "tok-de-teste-longo";

const SESSAO = {
  id: "sess-1",
  organization_id: "org-1",
  waha_session_name: "default",
  webhook_secret_encrypted: "\\x00",
  status: "WORKING",
  is_warmup_complete: true,
  warmup_started_at: null,
};

const arquivados: Record<string, unknown>[] = [];
const despachados: unknown[] = [];
/**
 * A autenticação é chaveada de fora porque um dos casos mede a ORDEM entre ela
 * e o contrato — e ordem só se mede fazendo a primeira etapa reprovar.
 */
let assinaturaConfere = true;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      insert: async (linha: Record<string, unknown>) => {
        arquivados.push(linha);
        return { error: null };
      },
    }),
    rpc: async () => ({ data: "segredo-decifrado-longo", error: null }),
  }),
}));

vi.mock("@/lib/channels/archived", () => ({
  ARCHIVED_AT: "archived_at",
  queryTolerantToMissingArchived: async () => ({ data: SESSAO, error: null }),
}));

vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));

vi.mock("@/lib/waha/webhook-auth", () => ({
  authenticateWahaWebhook: () =>
    assinaturaConfere
      ? { ok: true, signatureVerified: true }
      : { ok: false, reason: "invalid_signature" },
}));

vi.mock("@/lib/waha/ingest", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  dispatchWahaEvent: async (_a: unknown, _s: unknown, envelope: unknown) => {
    despachados.push(envelope);
  },
}));

import { POST } from "@/app/api/v1/webhooks/waha/[token]/route";

/** O mesmo evento de produção do arquivo de contrato (webhook_events_log, 2026-08-06). */
const REAL = {
  event: "message.any",
  session: "default",
  payload: {
    id: "false_70192801575156@lid_3A60443E83484256AF03",
    from: "70192801575156@lid",
    fromMe: false,
    body: "oi, tudo bem?",
    timestamp: 1_760_000_000,
    hasMedia: false,
    _data: {
      pushName: "Cliente Real",
      key: { id: "3A60443E83484256AF03", remoteJidAlt: "558183647258@s.whatsapp.net" },
      message: { conversation: "oi, tudo bem?" },
    },
  },
};

const pedido = (corpo: unknown) =>
  ({
    text: async () => (typeof corpo === "string" ? corpo : JSON.stringify(corpo)),
    headers: new Headers({ "x-webhook-hmac": "sha512=abc" }),
  }) as never;

const ctx = { params: Promise.resolve({ token: TOKEN }) } as never;

const zerar = () => {
  assinaturaConfere = true;
  arquivados.length = 0;
  despachados.length = 0;
};

describe("a rota por token — o desfecho que o WAHA de produção enxerga", () => {
  it("payload real: 200, e o dispatch recebe o envelope inteiro", async () => {
    zerar();
    const res = await POST(pedido(REAL), ctx);

    expect(res.status).toBe(200);
    expect(despachados).toHaveLength(1);
    // `toEqual` e não `toMatchObject`: o que se prova é que nada SUMIU no meio.
    expect(despachados[0]).toEqual(REAL);
    expect(arquivados[0]).toMatchObject({ webhook_path_token: TOKEN, event_type: "message.any" });
  });

  it("`from` não-string: 400 com o campo, e NADA chega ao dispatch", async () => {
    // Era o 200 mudo desta rota: `parseChatId` chamava `.endsWith` num número,
    // a exceção estourava dentro do dispatch, o `catch` da rota a engolia, e o
    // provider riscava o evento da fila achando que entregou.
    zerar();
    const res = await POST(pedido({ event: "message", session: "default", payload: { id: "x", from: 5 } }), ctx);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "validation_failed", details: { campos: ["payload.from"] } },
    });
    expect(despachados).toHaveLength(0);
  });

  it("o corpo cru é ARQUIVADO mesmo quando o estágio 2 reprova — é o AC do PRD §3.3", async () => {
    // "Webhook com HMAC válido grava raw em `webhook_events_log` mesmo se o
    // parse falhar depois". É esta ordem que o corte em dois estágios existe
    // para manter: conferir tudo antes do INSERT apagaria justamente a
    // evidência do formato novo.
    zerar();
    const corpo = { event: "message", session: "default", payload: { id: "wamid.X", from: 5 } };

    const res = await POST(pedido(corpo), ctx);

    expect(res.status).toBe(400);
    expect(arquivados, "o corpo cru se perdeu — a evidência do formato novo sumiu").toHaveLength(1);
    expect(arquivados[0]).toMatchObject({ raw_body: JSON.stringify(corpo), external_id: "wamid.X" });
  });

  it("o estágio 1 reprova ANTES do arquivo — nada é gravado nem despachado", async () => {
    // `session` resolve a organização e `payload.id` é coluna do próprio
    // arquivo: sem eles não há linha a gravar. Este caso segura a outra ponta
    // da ordem — o estágio 1 não pode escorregar para depois do INSERT.
    zerar();
    const res = await POST(pedido({ event: "message", session: 1, payload: { id: 2 } }), ctx);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "validation_failed", details: { campos: ["session", "payload.id"] } },
    });
    expect(arquivados).toHaveLength(0);
    expect(despachados).toHaveLength(0);
  });

  it("json quebrado segue devolvendo o mesmo 400 de sempre", async () => {
    zerar();
    const res = await POST(pedido("{nao é json"), ctx);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_request", message: "invalid_json" } });
  });

  it("token curto nem chega a ler o corpo — 404", async () => {
    zerar();
    const res = await POST(pedido(REAL), { params: Promise.resolve({ token: "curto" }) } as never);

    expect(res.status).toBe(404);
    expect(arquivados).toHaveLength(0);
  });

  it("sem assinatura válida, o CONTEÚDO nunca é conferido — 401, não 400", async () => {
    // A assimetria deliberada desta rota (registrada no cabeçalho dela): o
    // estágio 1 roda antes do HMAC porque a organização e o arquivo dependem
    // dele, mas o estágio 2 — o contrato do CONTEÚDO — roda depois. Um chamador
    // sem segredo nunca recebe de volta o nome de um campo de conteúdo.
    zerar();
    assinaturaConfere = false;
    const res = await POST(pedido({ event: "message", session: "default", payload: { id: "x", from: 5 } }), ctx);

    expect(res.status).toBe(401);
    expect(despachados).toHaveLength(0);
  });
});
