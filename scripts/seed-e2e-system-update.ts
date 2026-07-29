/**
 * Seed E2E da atualização self-service (task 9). Garante:
 *   - o usuário `admin` do seed base é dono do servidor (`platform_admins`,
 *     não `role` de organização — são superfícies diferentes);
 *   - `system_version`/`system_update_runs` num estado limpo, sem run pendente,
 *     pra o teste poder disparar sua própria atualização sem colidir com o
 *     índice único `uniq_system_update_runs_dispatched` (migration 0090).
 *
 * Idempotente e auto-reset (mesmo padrão de scripts/seed-e2e-radar.ts). Depende
 * de .e2e-creds.json (rode scripts/seed-e2e-credentials.ts antes).
 *
 * Run: npx tsx scripts/seed-e2e-system-update.ts
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

interface Creds {
  users: Record<string, { id: string; email: string; role: string }>;
}

async function ensurePlatformAdmin(userId: string): Promise<void> {
  const { data: existing } = await admin
    .from("platform_admins")
    .select("user_id, revoked_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (existing && (existing as { revoked_at: string | null }).revoked_at === null) {
    console.log(`[seed] platform_admin já ativo: ${userId}`);
    return;
  }
  if (existing) {
    await admin
      .from("platform_admins")
      .update({ revoked_at: null, revoked_by: null, revoke_reason: null } as never)
      .eq("user_id", userId);
    console.log(`[seed] platform_admin reativado: ${userId}`);
    return;
  }
  const { error } = await admin.from("platform_admins").insert({
    user_id: userId,
    granted_by: userId,
    reason: "seed e2e — dono do servidor para o teste de atualização self-service",
  } as never);
  if (error) throw new Error(`insert platform_admins: ${error.message}`);
  console.log(`[seed] platform_admin criado: ${userId}`);
}

async function resetSystemVersion(): Promise<void> {
  const { error: delError } = await admin.from("system_update_runs").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  if (delError) throw new Error(`delete system_update_runs: ${delError.message}`);

  const { error: updError } = await admin
    .from("system_version")
    .update({
      current_version: "1.0.0",
      current_sha: "abc1234",
      off_release: false,
      latest_version: "",
      changelog_raw: "",
      agent_last_seen_at: null,
      update_requested_at: null,
      update_requested_by: null,
    } as never)
    .eq("id", 1);
  if (updError) throw new Error(`reset system_version: ${updError.message}`);
  console.log("[seed] system_version/system_update_runs resetados");
}

async function main(): Promise<void> {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  const adminUser = creds.users.admin;
  if (!adminUser) throw new Error("creds.users.admin ausente — rode seed-e2e-credentials.ts primeiro");

  await ensurePlatformAdmin(adminUser.id);
  await resetSystemVersion();
  console.log("\n✅ Seed da atualização self-service completo.");
}

main().catch((err) => {
  console.error("❌ Seed da atualização self-service falhou:", err);
  process.exit(1);
});
