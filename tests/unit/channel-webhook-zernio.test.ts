import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

/**
 * Entrada do canal intermediado.
 *
 * Este é o módulo que DESTRAVA o envio: o `conversationId` do provider não se
 * deriva do contato — ele o inventa e o entrega aqui. Sem lê-lo e gravá-lo,
 * responder dentro da janela de 24h fica impossível.
 *
 * Metade dos casos abaixo prova o que o parser tem que RECUSAR. Um webhook que
 * aceita o que não devia escreve lixo no banco de quem instalou, e ninguém
 * descobre até a conversa errada aparecer no inbox.
 */
import {
  parseZernioInbound,
  resolveZernioIdentity,
  verifyZernioSignature,
  zernioMediaFetchInit,
} from "@/lib/channels/zernio/webhook";

const SECRET = "s3cr3t";
const firmar = (corpo: string) => createHmac("sha256", SECRET).update(corpo, "utf8").digest("hex");

const payload = (over: Record<string, unknown> = {}, msg: Record<string, unknown> = {}) => ({
  id: "evt_1",
  event: "message.received",
  account: { id: "6a3572a15f7d1751ab117832" },
  message: {
    id: "m_1",
    conversationId: "6a76a2dc4b8fe115e5f6c300",
    platform: "whatsapp",
    platformMessageId: "wamid.ABC",
    direction: "incoming",
    text: "hola",
    attachments: [],
    sender: { phoneNumber: "+595991733685", name: "Marcelo" },
    sentAt: "2026-08-08T01:00:00.000Z",
    isRead: false,
    ...msg,
  },
  ...over,
});

describe("assinatura", () => {
  const corpo = JSON.stringify(payload());

  it("aceita a assinatura correta", () => {
    expect(verifyZernioSignature(corpo, firmar(corpo), SECRET)).toBe(true);
  });

  it("aceita o prefixo sha256=", () => {
    expect(verifyZernioSignature(corpo, `sha256=${firmar(corpo)}`, SECRET)).toBe(true);
  });

  it("recusa corpo adulterado — é o ponto inteiro da assinatura", () => {
    expect(verifyZernioSignature(corpo + " ", firmar(corpo), SECRET)).toBe(false);
  });

  it("recusa assinatura de outro segredo", () => {
    const outra = createHmac("sha256", "outro").update(corpo).digest("hex");
    expect(verifyZernioSignature(corpo, outra, SECRET)).toBe(false);
  });

  it("SEM segredo configurado recusa — não é 'passa', é 'não dá para verificar'", () => {
    // Deixar passar transformaria a rota num endpoint público que escreve no
    // banco de quem instalou.
    expect(verifyZernioSignature(corpo, firmar(corpo), "")).toBe(false);
  });

  it("sem header recusa", () => {
    expect(verifyZernioSignature(corpo, null, SECRET)).toBe(false);
  });

  it("assinatura de tamanho errado devolve false em vez de lançar", () => {
    // `timingSafeEqual` lança com buffers de tamanhos diferentes, e um throw
    // aqui viraria 500 em vez de 401 — o atacante aprenderia pelo status.
    expect(() => verifyZernioSignature(corpo, "abcd", SECRET)).not.toThrow();
    expect(verifyZernioSignature(corpo, "abcd", SECRET)).toBe(false);
    expect(verifyZernioSignature(corpo, "", SECRET)).toBe(false);
  });
});

describe("parse — o que ACEITA", () => {
  it("lê a thread do provider, que é o que destrava o envio livre", () => {
    expect(parseZernioInbound(payload())?.conversationId).toBe("6a76a2dc4b8fe115e5f6c300");
  });

  it("usa o platformMessageId (wamid) como chave de idempotência", () => {
    expect(parseZernioInbound(payload())?.externalId).toBe("wamid.ABC");
  });

  it("cai no id do provider quando não há wamid", () => {
    expect(parseZernioInbound(payload({}, { platformMessageId: null }))?.externalId).toBe("m_1");
  });

  it("lê a conta que recebeu — casa com a sessão", () => {
    expect(parseZernioInbound(payload())?.accountId).toBe("6a3572a15f7d1751ab117832");
  });

  it("descarta anexo sem url em vez de guardar entrada quebrada", () => {
    const r = parseZernioInbound(
      payload({}, { attachments: [{ type: "image", url: "https://x/1" }, { type: "image" }, null] }),
    );
    expect(r?.attachments).toEqual([{ type: "image", url: "https://x/1" }]);
  });
});

describe("parse — o que RECUSA", () => {
  const recusa = (p: unknown) => expect(parseZernioInbound(p)).toBeNull();

  it("outro evento", () => recusa(payload({ event: "post.published" })));
  it("outra plataforma — DM de outra rede não é conversa de WhatsApp", () =>
    recusa(payload({}, { platform: "instagram" })));
  it("mensagem de SAÍDA — é o eco do nosso envio, e ingeri-lo duplicaria tudo", () =>
    recusa(payload({}, { direction: "outgoing" })));
  it("sem conversationId — sem thread não há o que endereçar depois", () =>
    recusa(payload({}, { conversationId: null })));
  it("sem nenhum id de mensagem — não há chave de idempotência", () =>
    recusa(payload({}, { platformMessageId: null, id: null })));
  it("payload que não é objeto", () => {
    recusa(null);
    recusa("texto");
    recusa([1, 2]);
  });
});

describe("identidade — o rollout que quebra quem só lê telefone", () => {
  it("prefere o BSUID: é a âncora que sobrevive a trocar de número", () => {
    const i = resolveZernioIdentity({ phoneNumber: "+595991733685", businessScopedUserId: "BS_1" });
    expect(i.anchor).toEqual({ kind: "bsuid", value: "BS_1" });
  });

  it("cai no telefone quando não há BSUID — o caso comum hoje", () => {
    const i = resolveZernioIdentity({ phoneNumber: "+595991733685" });
    expect(i.anchor).toEqual({ kind: "phone", value: "+595991733685" });
  });

  it("quem usa username SEM telefone continua identificável pelo BSUID", () => {
    // A doc é explícita: desde abril/2026 há quem escreva sem expor telefone.
    // Ler só o telefone funcionaria hoje e criaria contato órfão amanhã.
    const i = resolveZernioIdentity({ whatsappUsername: "@jane", businessScopedUserId: "BS_2" });
    expect(i.phone).toBeNull();
    expect(i.anchor).toEqual({ kind: "bsuid", value: "BS_2" });
  });

  it("username NUNCA vira âncora — a própria doc avisa que não é estável", () => {
    const i = resolveZernioIdentity({ whatsappUsername: "@jane" });
    expect(i.username).toBe("@jane");
    expect(i.anchor).toBeNull();
  });

  it("sem identidade utilizável devolve anchor null, não um contato anônimo", () => {
    expect(resolveZernioIdentity({}).anchor).toBeNull();
    expect(resolveZernioIdentity(null).anchor).toBeNull();
  });
});

describe("mídia", () => {
  it("a url do anexo é endpoint AUTENTICADO — sem Bearer devolve 401", () => {
    const init = zernioMediaFetchInit("sk_x") as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe("Bearer sk_x");
  });
});
