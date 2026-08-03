/**
 * Seed E2E da política de expiração do contexto por etapa (C3-01 — Spec 16
 * §9.1). Alimenta tests/e2e/pipeline-context-policy.spec.ts.
 *
 * Cria uma etapa DEDICADA no funil default (não reaproveita "Pago"/"Cancelado"
 * — mexer no papel de ganho/perda não é o que este e2e testa) e garante o
 * baseline de fábrica a cada run: `resets_context=false`,
 * `context_reset_after_days=7`. Idempotente por (organization_id, slug).
 *
 * Depende de .e2e-creds.json (rode scripts/seed-e2e-credentials.ts antes).
 * Grava o bloco `pipeline_policy`.
 *
 * Run: npx tsx scripts/seed-e2e-pipeline-policy.ts
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
const STAGE_NAME = "Etapa E2E Política de Contexto";
const STAGE_SLUG = "e2e_politica_contexto";

interface Creds {
  org_id: string;
  pipeline_policy?: unknown;
}

async function ensureStage(orgId: string, pipelineId: string): Promise<string> {
  const { data: existing, error: findErr } = await admin
    .from("crm_stages")
    .select("id")
    .eq("organization_id", orgId)
    .eq("pipeline_id", pipelineId)
    .eq("slug", STAGE_SLUG)
    .maybeSingle();
  if (findErr) throw new Error(`find stage: ${findErr.message}`);

  // Baseline de fábrica a cada run — o spec depende de partir sempre do mesmo estado.
  const baseline = { resets_context: false, context_reset_after_days: 7, is_archived: false };

  if (existing) {
    const id = (existing as { id: string }).id;
    const { error: updErr } = await admin
      .from("crm_stages")
      .update(baseline as never)
      .eq("id", id)
      .eq("organization_id", orgId);
    if (updErr) throw new Error(`reset stage baseline: ${updErr.message}`);
    return id;
  }

  const { data: maxPos } = await admin
    .from("crm_stages")
    .select("position")
    .eq("organization_id", orgId)
    .eq("pipeline_id", pipelineId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  const position = ((maxPos as { position: number } | null)?.position ?? 0) + 1000;

  const { data, error } = await admin
    .from("crm_stages")
    .insert({
      organization_id: orgId,
      pipeline_id: pipelineId,
      name: STAGE_NAME,
      slug: STAGE_SLUG,
      position,
      ...baseline,
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error(`insert stage: ${error?.message}`);
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

  const stageId = await ensureStage(orgId, pipelineId);

  creds.pipeline_policy = { pipeline_id: pipelineId, stage_id: stageId, stage_name: STAGE_NAME };
  fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2));

  console.log(`✅ Seed da política de contexto (C3-01) completo. pipeline=${pipelineId} stage=${stageId}`);
}

main().catch((err) => {
  console.error("❌ Seed falhou:", err);
  process.exit(1);
});
