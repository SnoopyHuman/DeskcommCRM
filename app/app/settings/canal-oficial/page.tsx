import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { CanalOficialClient } from "./_components/CanalOficialClient";

export const dynamic = "force-dynamic";

/**
 * A superfície que faltava ao BYO (invariante 6 do sistema vivo): a credencial do
 * canal oficial existia por sessão, mas só era gravável por SQL.
 *
 * Não é Embedded Signup — ver `docs/doctrine/restricao-de-canal.md`, seção "Embedded
 * Signup não cabe em self-host". Aqui o self-hoster cola as credenciais do PRÓPRIO
 * app da Meta, que ele já precisou criar para ter um número oficial.
 */
export default async function CanalOficialPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg || ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Canal oficial (WhatsApp Cloud API)</h1>
        <p className="text-sm text-muted-foreground">
          Conecte o número oficial da sua conta na Meta. A credencial fica guardada{" "}
          <strong>por canal, cifrada</strong> — cada organização usa a sua.
        </p>
      </header>
      <CanalOficialClient />
    </div>
  );
}
