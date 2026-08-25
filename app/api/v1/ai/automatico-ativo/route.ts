/**
 * GET /api/v1/ai/automatico-ativo — existe atendimento automático nesta org?
 *
 * ## Por que uma rota só para isto
 *
 * O selo de comando do Inbox dizia "Automático atendendo" em toda conversa sem
 * dono e sem trava — **sem saber se existe algum automático**. Numa instalação
 * que ainda não configurou agente nenhum (o estado de todo primeiro deploy), a
 * tela afirmava que o robô estava cuidando de conversas que ninguém estava
 * respondendo. É a frase tranquilizadora que a doutrina proíbe, e ela cai
 * justamente na primeira impressão, que é P0.
 *
 * `GET /api/v1/ai/agents` responderia, mas exige `manager+` — e quem vive no
 * Inbox é o `agent`. Alargar aquela rota exporia prompt, guardrails e modelo a
 * quem não precisa. Esta devolve UM booleano: o mínimo que a tela precisa para
 * parar de afirmar o que não sabe.
 *
 * O predicado é o mesmo que o worker usa para escolher agente
 * (`is_active` + não arquivado), e não `published_version_id`: o motor moderno
 * exige versão publicada, mas o worker legado responde sem ela — perguntar pela
 * versão diria "não há automático" numa org onde há.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { count, error } = await supabase
    .from("ai_agents")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", authz.org.orgId)
    .eq("is_active", true)
    .is("archived_at", null);

  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok({ ativo: (count ?? 0) > 0 }, { requestId });
}
