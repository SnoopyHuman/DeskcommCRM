/**
 * Entrada do canal intermediado — verificação de assinatura e leitura do
 * payload.
 *
 * PURO de propósito: nada aqui toca banco, rede ou relógio. A rota faz o
 * efeito; aqui só se decide *o que o payload diz*. É o que permite provar o
 * caso difícil (assinatura errada, campo ausente, identidade sem telefone) sem
 * subir infraestrutura.
 *
 * ─── Por que este módulo é o que destrava o envio ───────────────────────────
 *
 * O `conversationId` do provider NÃO se deriva do contato: ele o inventa e o
 * entrega AQUI. `conversations.provider_conversation_id` só existe porque este
 * webhook o traz — sem gravá-lo, responder dentro da janela de 24h fica
 * impossível, porque o endpoint que aceita telefone exige template.
 *
 * ─── A identidade em transição (rollout BSUID, abril/2026) ──────────────────
 *
 * A doc do provider é explícita: quem adota um *username* pode escrever à
 * empresa **sem expor telefone**, e aí `phoneNumber` vem ausente. O anchor
 * recomendado passa a ser o `businessScopedUserId`. Ler só o telefone
 * funcionaria hoje e criaria contato órfão amanhã — por isso a resolução de
 * identidade tem ordem explícita e devolve QUAL âncora usou, para quem grava
 * saber o que está guardando.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Assinatura HMAC-SHA256 no header `X-Zernio-Signature`. */
export function verifyZernioSignature(
  rawBody: string,
  headerValue: string | null,
  secret: string,
): boolean {
  // Sem segredo configurado NÃO é "passa": é "não dá para verificar". Deixar
  // passar transformaria a rota num endpoint público que escreve no banco de
  // quem instalou. Quem decide seguir sem verificação faz isso explicitamente
  // na rota, não por omissão aqui.
  if (!secret || !headerValue) return false;

  const got = headerValue.startsWith("sha256=") ? headerValue.slice(7) : headerValue;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

  // Comparação de tempo constante, e comprimento conferido ANTES:
  // `timingSafeEqual` lança quando os buffers têm tamanhos diferentes, e um
  // throw aqui viraria 500 em vez de 401 — o atacante aprenderia pelo código
  // de status o que não deveria.
  const a = Buffer.from(got, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export interface ZernioInboundMessage {
  /** Id da THREAD no provider — o que endereça o envio livre depois. */
  conversationId: string;
  /** Id da mensagem na plataforma (wamid) — chave de idempotência. */
  externalId: string;
  /** Conta conectada que recebeu — casa com `channel_sessions.zernio_account_id`. */
  accountId: string | null;
  text: string | null;
  attachments: { type: string; url: string }[];
  sentAt: string | null;
  identity: ZernioIdentity;
}

export interface ZernioIdentity {
  /** E.164 COM `+`, quando a pessoa expõe telefone. */
  phone: string | null;
  /** Âncora canônica da Meta para o usuário dentro do negócio. */
  bsuid: string | null;
  /** `@handle` — muda quando a pessoa quer; serve para exibir, não para casar. */
  username: string | null;
  displayName: string | null;
  /**
   * Qual âncora usar para casar o contato, já decidida aqui.
   *
   * `null` = payload sem identidade utilizável. Não é erro de parsing: é um
   * evento que não dá para atribuir a ninguém, e quem grava precisa recusá-lo
   * em vez de criar um contato anônimo por engano.
   */
  anchor: { kind: "bsuid" | "phone"; value: string } | null;
}

type Bruto = Record<string, unknown>;
const obj = (v: unknown): Bruto | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Bruto) : null;
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * Identidade do remetente, com a ordem de precedência declarada.
 *
 * BSUID primeiro porque é o que o provider chama de "âncora primária
 * recomendada" e o único que sobrevive a alguém trocar de telefone ou adotar
 * username. Telefone é o fallback — e continua sendo o caso comum hoje.
 * `whatsappUsername` NUNCA vira âncora: a própria doc avisa que não é estável.
 */
export function resolveZernioIdentity(sender: Bruto | null): ZernioIdentity {
  const s = sender ?? {};
  const phone = str(s.phoneNumber);
  const bsuid = str(s.businessScopedUserId);
  const username = str(s.whatsappUsername);
  const displayName = str(s.name) ?? str(s.displayName);

  const anchor = bsuid
    ? ({ kind: "bsuid", value: bsuid } as const)
    : phone
      ? ({ kind: "phone", value: phone } as const)
      : null;

  return { phone, bsuid, username, displayName, anchor };
}

/**
 * Lê um payload de mensagem recebida. `null` quando não é isso — outro evento,
 * mensagem de saída (o eco do nosso próprio envio) ou payload incompleto.
 *
 * Devolver `null` em vez de lançar é deliberado: a rota responde 200 para o
 * provider parar de reenviar, e um evento que não nos interessa não é falha.
 * Lançar faria o provider retentar para sempre um payload que nunca vai servir.
 */
export function parseZernioInbound(payload: unknown): ZernioInboundMessage | null {
  const p = obj(payload);
  if (!p) return null;
  if (str(p.event) !== "message.received") return null;

  const m = obj(p.message);
  if (!m) return null;

  // Só WhatsApp: a mesma conta serve outras plataformas, e um DM de outra rede
  // entrando como conversa de WhatsApp é pior que ignorá-lo.
  if (str(m.platform) !== "whatsapp") return null;

  // `outgoing` é o eco do nosso próprio envio. Ingerir isso duplicaria toda
  // mensagem enviada — o mesmo defeito que o canal por QR já teve.
  if (str(m.direction) === "outgoing") return null;

  const conversationId = str(m.conversationId);
  const externalId = str(m.platformMessageId) ?? str(m.id);
  if (!conversationId || !externalId) return null;

  const anexosBrutos = Array.isArray(m.attachments) ? m.attachments : [];
  const attachments = anexosBrutos
    .map((a) => obj(a))
    .filter((a): a is Bruto => a !== null)
    .map((a) => ({ type: str(a.type) ?? "file", url: str(a.url) ?? "" }))
    .filter((a) => a.url.length > 0);

  return {
    conversationId,
    externalId,
    accountId: str(obj(p.account)?.id) ?? str(obj(p.account)?.accountId) ?? str(p.accountId),
    text: str(m.text),
    attachments,
    sentAt: str(m.sentAt),
    identity: resolveZernioIdentity(obj(m.sender)),
  };
}

/**
 * A URL do anexo é um endpoint AUTENTICADO do provider, não um link público —
 * buscá-la sem o Bearer devolve 401, e a doc avisa que a Meta descarta a mídia
 * depois de um tempo, quando passa a devolver 400.
 *
 * Existe como função nomeada para que o chamador não seja tentado a repassar a
 * URL crua para o browser: o que ela devolve é para BAIXAR e guardar, agora.
 */
export function zernioMediaFetchInit(apiKey: string): RequestInit {
  return { headers: { Authorization: `Bearer ${apiKey}` } };
}
