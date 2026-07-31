/**
 * GET  /api/v1/channels/official — estado da conexão oficial + o que colar na Meta.
 * POST /api/v1/channels/official — VALIDA a credencial e só então grava.
 *
 * O `POST` valida contra a Graph API **antes** de persistir. Gravar primeiro e
 * descobrir depois é o que faz o operador achar que conectou e só entender que não na
 * primeira mensagem que não sai — com o lead do outro lado esperando.
 *
 * O token é cifrado pelas MESMAS RPCs do resto do repo (`lib/webhooks/secrets.ts`) e
 * **nunca volta** num GET: uma vez gravado, a tela mostra que existe, não qual é.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { validateMetaCredentials } from "@/lib/channels/meta/validate-credentials";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const conectarSchema = z.object({
  phone_number_id: z.string().min(5),
  waba_id: z.string().min(5),
  token: z.string().min(20),
});

type Gate = { ok: true; orgId: string } | { ok: false; resposta: NextResponse };

async function adminGate(requestId: string): Promise<Gate> {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org || ROLE_RANK[org.role] < ROLE_RANK.admin) {
    return { ok: false, resposta: fail("forbidden", "admin_required", 403, { requestId }) };
  }
  return { ok: true, orgId: org.orgId };
}

/** Base pública desta instalação — é o que o operador cola no dashboard da Meta. */
function publicBase(req: NextRequest): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ??
    req.headers.get("origin") ??
    `${req.nextUrl.protocol}//${req.nextUrl.host}`
  );
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const g = await adminGate(requestId);
  if (!g.ok) return g.resposta;

  const admin = createAdminClient();
  const { data } = await admin
    .from("channel_sessions")
    .select("id, meta_phone_number_id, meta_waba_id, meta_token_encrypted, phone_number, display_name, webhook_path_token, status")
    .eq("organization_id", g.orgId)
    .eq("provider", CHANNEL_PROVIDER_META)
    .maybeSingle();

  const base = publicBase(req);
  return ok({
    connected: Boolean(data),
    // `hasToken` em vez do token: uma vez gravado, a tela mostra que EXISTE, nunca
    // qual é. Devolver o segredo para preencher o campo seria vazá-lo a cada render.
    hasToken: Boolean(data?.meta_token_encrypted),
    phoneNumberId: data?.meta_phone_number_id ?? null,
    wabaId: data?.meta_waba_id ?? null,
    displayName: data?.display_name ?? null,
    phoneNumber: data?.phone_number ?? null,
    status: data?.status ?? null,
    /** O que o operador precisa colar do NOSSO lado no dashboard da Meta. */
    webhook: data
      ? {
          callbackUrl: `${base}/api/v1/webhooks/meta/${data.webhook_path_token}`,
          verifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN ?? null,
          fields: ["messages", "message_template_status_update"],
        }
      : null,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const g = await adminGate(requestId);
  if (!g.ok) return g.resposta;

  const parsed = conectarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", "phone_number_id, waba_id e token são obrigatórios", 422, {
      requestId,
    });
  }
  const { phone_number_id, waba_id, token } = parsed.data;

  // VALIDA ANTES DE GRAVAR — a rota não sabe com quem fala; ela pergunta se a
  // credencial presta e o canal responde.
  const validacao = await validateMetaCredentials({ phoneNumberId: phone_number_id, token });
  if (!validacao.ok) {
    return fail("invalid_request", validacao.motivo, 422, { requestId });
  }

  const admin = createAdminClient();
  const cifrado = await encryptWebhookSecret(admin, token);
  if (!cifrado) {
    // Sem a GUC de cifra configurada, gravar o token em claro seria pior que
    // recusar. O operador precisa saber que falta uma configuração de servidor.
    return fail(
      "invalid_request",
      "cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o token não foi gravado",
      422,
      { requestId },
    );
  }

  const { data: existente } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", g.orgId)
    .eq("provider", CHANNEL_PROVIDER_META)
    .maybeSingle();

  const linha = {
    organization_id: g.orgId,
    provider: CHANNEL_PROVIDER_META,
    meta_phone_number_id: phone_number_id,
    meta_waba_id: waba_id,
    meta_token_encrypted: cifrado,
    phone_number: validacao.displayPhoneNumber ? `+${validacao.displayPhoneNumber.replace(/\D/g, "")}` : null,
    display_name: validacao.verifiedName ?? "Canal oficial",
    status: "WORKING",
  };

  // `update` quando já existe em vez de upsert: a trava única de (org, phone_number)
  // é DEFERRABLE e o Postgres recusa constraint deferível como árbitro de
  // `ON CONFLICT` — medido ao criar a sessão de teste da Fase 3b.
  const { error } = existente
    ? await admin.from("channel_sessions").update(linha).eq("id", existente.id)
    : await admin.from("channel_sessions").insert({ ...linha, webhook_secret_encrypted: cifrado });

  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok({
    connected: true,
    displayName: linha.display_name,
    phoneNumber: linha.phone_number,
  });
}
