/**
 * Seed E2E do ciclo de vida do contexto (C2 — Spec 16). Alimenta
 * tests/e2e/context-lifecycle.spec.ts, cobrindo os dois cenários que a review
 * do PR #4 pediu prova permanente (não manual):
 *
 *  1. Hard reset bloqueado por caso humano aberto (`agent_cases.status =
 *     'awaiting_human'`) → 409 com a mensagem exata da Spec 16 §9.3.
 *  2. Divisor de corte na thread (`contacts.context_reset_at` setado, com
 *     mensagens antes E depois) + `DELETE /context/cutoff` real através da
 *     sessão autenticada do Playwright.
 *
 * Idempotente e auto-reset: cada run apaga e recria as mensagens/caso/corte
 * (mesmo espírito de seed-e2e-queue.ts) — o teste pode rodar de novo depois
 * de o spec anterior ter chamado o DELETE de verdade. Depende de
 * .e2e-creds.json (rode scripts/seed-e2e-credentials.ts antes). Grava o
 * bloco `context`.
 *
 * Run: npx tsx scripts/seed-e2e-context.ts
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";

const envFile = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
const env: Record<string, string> = {};
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
}

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const CONTACT_NAME = "Contato Contexto E2E";
const SESSION_NAME = "e2e-context-session";
const ANTES_1 = "E2E-CTX-ANTES-1 (fato que deve sumir com o corte)";
const ANTES_2 = "E2E-CTX-ANTES-2";
const DEPOIS_1 = "E2E-CTX-DEPOIS-1";
const DEPOIS_2 = "E2E-CTX-DEPOIS-2";

interface Creds {
  org_id: string;
  users: Record<string, { id: string }>;
  context?: unknown;
}

async function ensureSession(orgId: string): Promise<string> {
  const { data: existing } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", orgId)
    .eq("waha_session_name", SESSION_NAME)
    .maybeSingle();
  if (existing) return (existing as { id: string }).id;
  const { data, error } = await admin
    .from("channel_sessions")
    .insert({
      organization_id: orgId,
      waha_session_name: SESSION_NAME,
      display_name: "Número Contexto E2E",
      webhook_secret_encrypted: "\\x00",
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error(`insert channel_session: ${error?.message}`);
  return (data as { id: string }).id;
}

async function ensureContact(orgId: string): Promise<string> {
  const { data: existing } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", orgId)
    .eq("display_name", CONTACT_NAME)
    .maybeSingle();
  if (existing) return (existing as { id: string }).id;
  const { data, error } = await admin
    .from("contacts")
    .insert({ organization_id: orgId, display_name: CONTACT_NAME } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error(`insert contact: ${error?.message}`);
  return (data as { id: string }).id;
}

async function ensureConversation(
  orgId: string,
  contactId: string,
  sessionId: string,
): Promise<string> {
  const { data: existing } = await admin
    .from("conversations")
    .select("id")
    .eq("organization_id", orgId)
    .eq("contact_id", contactId)
    .eq("is_group", false)
    .maybeSingle();
  if (existing) return (existing as { id: string }).id;
  const { data, error } = await admin
    .from("conversations")
    .insert({
      organization_id: orgId,
      contact_id: contactId,
      channel_session_id: sessionId,
      status: "open",
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error(`insert conversation: ${error?.message}`);
  return (data as { id: string }).id;
}

/** Apaga e recria as 4 mensagens da fixture — garante posição relativa ao cutoff a cada run. */
async function reseedMessages(
  orgId: string,
  conversationId: string,
  sessionId: string,
  contactId: string,
  cutoffIso: string,
): Promise<void> {
  await admin
    .from("messages")
    .delete()
    .eq("organization_id", orgId)
    .eq("conversation_id", conversationId)
    .in("body", [ANTES_1, ANTES_2, DEPOIS_1, DEPOIS_2]);

  const cutoffMs = Date.parse(cutoffIso);
  const rows = [
    { body: ANTES_1, offsetMin: -180, direction: "inbound" },
    { body: ANTES_2, offsetMin: -150, direction: "outbound" },
    { body: DEPOIS_1, offsetMin: -60, direction: "inbound" },
    { body: DEPOIS_2, offsetMin: -30, direction: "outbound" },
  ].map((m) => ({
    organization_id: orgId,
    conversation_id: conversationId,
    channel_session_id: sessionId,
    contact_id: contactId,
    type: "text",
    direction: m.direction,
    body: m.body,
    sent_at: new Date(cutoffMs + m.offsetMin * 60_000).toISOString(),
  }));

  const { error } = await admin.from("messages").insert(rows as never);
  if (error) throw new Error(`insert messages: ${error.message}`);
}

/** Garante 1 agent_cases aberto (status='awaiting_human') na conversa — bloqueia o hard reset. */
async function reseedOpenCase(orgId: string, conversationId: string): Promise<void> {
  await admin
    .from("agent_cases")
    .delete()
    .eq("organization_id", orgId)
    .eq("conversation_id", conversationId);
  const { error } = await admin.from("agent_cases").insert({
    organization_id: orgId,
    conversation_id: conversationId,
    status: "awaiting_human",
    title: "Caso E2E — hard reset deve bloquear",
    summary: "Fixture do context-lifecycle.spec.ts (C2-03).",
    blocker: "Aguardando decisão humana (fixture de teste).",
  } as never);
  if (error) throw new Error(`insert agent_cases: ${error.message}`);
}

async function main(): Promise<void> {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  const orgId = creds.org_id;

  const sessionId = await ensureSession(orgId);
  const contactId = await ensureContact(orgId);
  const conversationId = await ensureConversation(orgId, contactId, sessionId);

  // Corte fixo a 90min do "agora" do seed — entre ANTES (h-3/h-2.5) e DEPOIS (h-1/h-0.5).
  const cutoffIso = new Date(Date.now() - 90 * 60_000).toISOString();

  await reseedMessages(orgId, conversationId, sessionId, contactId, cutoffIso);
  await reseedOpenCase(orgId, conversationId);

  const { error: contactErr } = await admin
    .from("contacts")
    .update({
      context_reset_at: cutoffIso,
      context_reset_reason: "stage_policy",
    } as never)
    .eq("id", contactId)
    .eq("organization_id", orgId);
  if (contactErr) throw new Error(`update contact cutoff: ${contactErr.message}`);

  creds.context = {
    contact_id: contactId,
    conversation_id: conversationId,
    contact_name: CONTACT_NAME,
    cutoff_iso: cutoffIso,
    fato_antes_do_corte: ANTES_1,
    fato_depois_do_corte: DEPOIS_1,
  };
  fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2));

  console.log("✅ Seed de contexto (C2) completo.");
  console.log(`contact: ${contactId} / conversation: ${conversationId} / cutoff: ${cutoffIso}`);
}

main().catch((err) => {
  console.error("❌ Seed falhou:", err);
  process.exit(1);
});
