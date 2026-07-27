/**
 * GET /api/v1/contacts/[id]/crm-summary — o resumo de CRM do painel do inbox.
 *
 * POR QUE ESTA ROTA EXISTE (não é organização, é correção de defeito):
 * o `CRMSidePanel` consultava `crm_leads`, `orders` e `crm_lead_activities`
 * DIRETO do navegador, pelo cliente de browser. O cookie de sessão é httpOnly
 * (CLAUDE.md), então o supabase-js do browser não enxerga a sessão e as
 * consultas saem como **anônimas** — provado lendo o `role` do token: `anon`,
 * com um gerente logado na tela.
 *
 * O efeito era pior que um erro:
 *   crm_leads           → a policy chama fn_can_view_lead, que `anon` não pode
 *                         executar → 401 / 42501
 *   crm_lead_activities → a policy usa fn_user_org_ids, que é PUBLIC → `anon`
 *                         chama, avalia falso → **200 com lista vazia**
 *   orders              → idem
 * Um erro e dois silêncios, e a tela traduzia os três para "Sem leads." — uma
 * afirmação sobre o NEGÓCIO feita em cima de uma falha de permissão.
 *
 * A correção **não** é dar EXECUTE a `anon`: `fn_can_view_lead` é primitiva de
 * autorização, e a policy a usa para decidir quem enxerga o quê. É trazer a
 * leitura para o servidor, onde a sessão existe — mesma decisão que o repo já
 * tomou para o fetch do board e para o token de realtime.
 *
 * **Um pedido, um veredito.** As três consultas falham juntas de propósito: a
 * alternativa (status por seção) triplicaria os estados no componente, e a
 * doença que esta rota cura é exatamente estados distintos colapsados num só.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const LEAD_COLS = "id, title, status, value_cents, currency, updated_at";
const ORDER_COLS = "id, external_id, status, total_cents, currency, created_at";
/** Acompanha o que a timeline mostra — `reason` e `actor_kind` inclusive. */
const ACTIVITY_COLS = "id, type, source_module, performed_at, payload, reason, actor_kind";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: contactId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const [leads, orders, activities] = await Promise.all([
    supabase
      .from("crm_leads")
      .select(LEAD_COLS)
      .eq("contact_id", contactId)
      .order("updated_at", { ascending: false })
      .limit(3),
    supabase
      .from("orders")
      .select(ORDER_COLS)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(3),
    supabase
      .from("crm_lead_activities")
      .select(ACTIVITY_COLS)
      .eq("contact_id", contactId)
      .order("performed_at", { ascending: false })
      .limit(5),
  ]);

  // A falha SOBE. Engolir aqui devolveria lista vazia ao cliente e recriaria,
  // do lado do servidor, exatamente a mentira que esta rota veio desfazer.
  const falha = leads.error ?? orders.error ?? activities.error;
  if (falha) {
    return fail("internal_error", falha.message, 500, { requestId });
  }

  return ok(
    {
      leads: leads.data ?? [],
      orders: orders.data ?? [],
      activities: activities.data ?? [],
    },
    { requestId },
  );
}
