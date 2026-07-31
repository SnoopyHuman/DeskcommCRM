import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { TemplatesClient } from "./_components/TemplatesClient";

export const dynamic = "force-dynamic";

/**
 * A superfície que o invariante 6 do sistema vivo exige: existia disparo de
 * template por follow-up sem nenhum lugar para VER ou configurar template.
 * Mecanismo operável só por quem lê o banco não é operável.
 */
export default async function TemplatesPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg || ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Templates do WhatsApp</h1>
        <p className="text-sm text-muted-foreground">
          Espelho dos templates aprovados na Meta. Fora da janela de 24 horas, só template
          aprovado pode ser enviado — e os parâmetros abaixo são{" "}
          <strong>derivados do template</strong>, nunca digitados aqui.
        </p>
      </header>
      <TemplatesClient />
    </div>
  );
}
