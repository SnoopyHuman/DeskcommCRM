import { notFound, redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import type { RouterDetailState } from "@/hooks/ai/useRouters";
import type { ChannelSessionLite } from "../../agents/[id]/_components/AgentForm";
import { RouterEditorClient } from "./_client";

export const dynamic = "force-dynamic";

const ROUTER_DETAIL_COLUMNS = "id, name, channel_session_id, is_active, config, fallback_agent_id";
const MEMBER_COLUMNS = "id, agent_id, intent_name, intent_description, examples, position";

export default async function RouterEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!user.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();

  const [{ data: routerRow }, { data: memberRows }, { data: agentRows }, { data: channelRows }] =
    await Promise.all([
      supabase
        .from("ai_routers")
        .select(ROUTER_DETAIL_COLUMNS)
        .eq("id", id)
        .eq("organization_id", activeOrg.orgId)
        .maybeSingle(),
      supabase
        .from("ai_router_members")
        .select(MEMBER_COLUMNS)
        .eq("router_id", id)
        .eq("organization_id", activeOrg.orgId)
        .order("position", { ascending: true }),
      supabase
        .from("ai_agents")
        .select("id, name")
        .eq("organization_id", activeOrg.orgId)
        .is("archived_at", null)
        .order("name", { ascending: true }),
      supabase
        .from("channel_sessions")
        .select("id, display_name, status, phone_number, waha_session_name")
        .eq("organization_id", activeOrg.orgId),
    ]);

  if (!routerRow) notFound();

  const initialState: RouterDetailState = {
    router: routerRow as RouterDetailState["router"],
    members: (memberRows ?? []) as RouterDetailState["members"],
  };

  const agents = agentRows ?? [];
  const channelSessions: ChannelSessionLite[] = (channelRows ?? []).map((c) => ({
    id: c.id,
    display_name: c.display_name ?? c.waha_session_name,
    status: c.status,
    phone_number: c.phone_number ?? null,
  }));

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <RouterEditorClient
        routerId={id}
        initialState={initialState}
        agents={agents}
        channelSessions={channelSessions}
      />
    </div>
  );
}
