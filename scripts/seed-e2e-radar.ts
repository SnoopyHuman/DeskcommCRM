/**
 * Seed E2E do Radar de Risco (C1) e sua alça de ação. Cria:
 *   - 1 contato + 1 channel_session + 1 conversa ABERTA e SEM dono (claimável);
 *   - 1 lead ABERTO vinculado a esse contato, com última atividade há 5 dias e
 *     sem follow-up agendado → aparece no radar como "crítico / sem próximo passo",
 *     com o botão "Assumir" (porque tem conversa).
 *
 * Idempotente E auto-reset: devolve a conversa ao estado sem dono a cada run (o
 * teste de "assumir" pode rodar de novo). Depende de .e2e-creds.json
 * (rode scripts/seed-e2e-credentials.ts antes). Grava o bloco `radar`.
 *
 * Run: npx tsx scripts/seed-e2e-radar.ts
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
const AT_RISK_TITLE = "Demanda E2E em risco (radar)";
const CONTACT_NAME = "Cliente Radar E2E";
const SESSION_NAME = "e2e-radar-session";

interface Creds {
  org_id: string;
  radar?: unknown;
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
      display_name: "Número Radar E2E",
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

async function ensureConversation(orgId: string, contactId: string, sessionId: string): Promise<string> {
  // Estado claimável: aberta, sem dono.
  const state = {
    assigned_to_user_id: null,
    assignee_kind: null,
    assigned_at: null,
    status: "open",
    last_message_preview: "Oi, ainda dá pra resolver meu caso?",
  };
  const { data: existing } = await admin
    .from("conversations")
    .select("id")
    .eq("organization_id", orgId)
    .eq("contact_id", contactId)
    .eq("channel_session_id", sessionId)
    .maybeSingle();
  if (existing) {
    const id = (existing as { id: string }).id;
    await admin.from("conversations").update(state as never).eq("id", id);
    return id;
  }
  const { data, error } = await admin
    .from("conversations")
    .insert({ organization_id: orgId, contact_id: contactId, channel_session_id: sessionId, ...state } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error(`insert conversation: ${error?.message}`);
  return (data as { id: string }).id;
}

async function main(): Promise<void> {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  const orgId = creds.org_id;

  const { data: pipeline, error: pErr } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .maybeSingle();
  if (pErr || !pipeline) throw new Error(`default pipeline not found: ${pErr?.message}`);
  const pipelineId = (pipeline as { id: string }).id;

  const { data: stage, error: sErr } = await admin
    .from("crm_stages")
    .select("id")
    .eq("pipeline_id", pipelineId)
    .eq("is_archived", false)
    .order("position")
    .limit(1)
    .maybeSingle();
  if (sErr || !stage) throw new Error(`stage not found: ${sErr?.message}`);
  const stageId = (stage as { id: string }).id;

  const sessionId = await ensureSession(orgId);
  const contactId = await ensureContact(orgId);
  const conversationId = await ensureConversation(orgId, contactId, sessionId);

  // 5 dias sem atividade → crítico; sem follow-up → "sem próximo passo".
  const coldAt = new Date(Date.now() - 5 * 24 * 3_600_000).toISOString();
  const leadFields = {
    stage_id: stageId,
    contact_id: contactId,
    owner_user_id: null,
    last_activity_at: coldAt,
  };

  const { data: existing } = await admin
    .from("crm_leads")
    .select("id")
    .eq("organization_id", orgId)
    .eq("title", AT_RISK_TITLE)
    .maybeSingle();

  let leadId: string;
  if (existing) {
    leadId = (existing as { id: string }).id;
    await admin.from("crm_leads").update(leadFields as never).eq("id", leadId);
    console.info(`[seed] radar lead existing: ${leadId}`);
  } else {
    const { data, error } = await admin
      .from("crm_leads")
      .insert({
        organization_id: orgId,
        pipeline_id: pipelineId,
        title: AT_RISK_TITLE,
        position_in_stage: 3000,
        source: "manual",
        ...leadFields,
      } as never)
      .select("id")
      .single();
    if (error || !data) throw new Error(`insert radar lead: ${error?.message}`);
    leadId = (data as { id: string }).id;
    console.info(`[seed] radar lead created: ${leadId}`);
  }

  creds.radar = {
    pipeline_id: pipelineId,
    at_risk_lead_id: leadId,
    at_risk_title: AT_RISK_TITLE,
    contact_id: contactId,
    conversation_id: conversationId,
  };
  fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2));
  console.info(`\n✅ Radar seed completo. lead=${leadId} conv=${conversationId} (frio desde ${coldAt})`);
}

main().catch((err) => {
  console.error("❌ Radar seed falhou:", err);
  process.exit(1);
});
