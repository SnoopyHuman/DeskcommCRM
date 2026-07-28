import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import type { RouterListItem } from "@/hooks/ai/useRouters";
import type { ChannelSessionLite } from "../agents/[id]/_components/AgentForm";
import { RoutersClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function RoutersPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  if (!user.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();

  const [{ data: routerRows }, { data: memberRows }, { data: channelRows }] = await Promise.all([
    supabase
      .from("ai_routers")
      .select("id, name, channel_session_id, is_active, fallback_agent_id, updated_at")
      .eq("organization_id", activeOrg.orgId)
      .order("created_at", { ascending: false }),
    supabase.from("ai_router_members").select("router_id").eq("organization_id", activeOrg.orgId),
    supabase
      .from("channel_sessions")
      .select("id, display_name, status, phone_number, waha_session_name")
      .eq("organization_id", activeOrg.orgId),
  ]);

  const counts = new Map<string, number>();
  for (const m of memberRows ?? []) {
    counts.set(m.router_id, (counts.get(m.router_id) ?? 0) + 1);
  }

  const routers: RouterListItem[] = (routerRows ?? []).map((r) => ({
    ...r,
    member_count: counts.get(r.id) ?? 0,
  }));

  const channelSessions: ChannelSessionLite[] = (channelRows ?? []).map((c) => ({
    id: c.id,
    display_name: c.display_name ?? c.waha_session_name,
    status: c.status,
    phone_number: c.phone_number ?? null,
  }));

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Roteadores</h1>
        <p className="text-sm text-muted-foreground">
          Um roteador entende o que o cliente quer e entrega a conversa para o agente certo —
          plugado em um número de WhatsApp.
        </p>
      </header>
      <RoutersClient initialState={{ routers }} channelSessions={channelSessions} />
    </div>
  );
}
