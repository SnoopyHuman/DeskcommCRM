import Link from "next/link";

import { Card } from "@/components/ui/card";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";

export const dynamic = "force-dynamic";

interface SettingsLink {
  href: string;
  title: string;
  description: string;
  adminOnly?: boolean;
  managerOnly?: boolean;
}

const LINKS: SettingsLink[] = [
  { href: "/app/settings/profile", title: "Perfil", description: "Nome, idioma, fuso, avatar." },
  {
    href: "/app/settings/security",
    title: "Segurança",
    description: "MFA, códigos de recuperação, sessões.",
  },
  {
    href: "/app/settings/notifications",
    title: "Notificações",
    description: "Canais e categorias (em breve).",
  },
  {
    href: "/app/settings/api-tokens",
    title: "API Tokens",
    description: "Tokens server-to-server.",
    adminOnly: true,
  },
  {
    href: "/app/settings/tenant",
    title: "Organização",
    description: "Dados da empresa, retenção, DPO.",
    adminOnly: true,
  },
  {
    href: "/app/settings/tenant/pipelines",
    title: "Funis",
    description: "Para onde o agente leva o card em cada passo do atendimento.",
    managerOnly: true,
  },
  {
    href: "/app/settings/canal-oficial",
    title: "Canal oficial (Cloud API)",
    description: "Conectar o número oficial da Meta e o webhook.",
    adminOnly: true,
  },
  {
    href: "/app/settings/templates",
    title: "Templates do WhatsApp",
    description: "Espelho dos templates da Meta e seus parâmetros.",
    adminOnly: true,
  },
  {
    href: "/app/connections",
    title: "Conexões WhatsApp",
    description: "Saúde, reconexão e novos números.",
    adminOnly: true,
  },
  { href: "/app/audit", title: "Audit Log", description: "Histórico de ações.", managerOnly: true },
  {
    href: "/app/settings/billing",
    title: "Billing",
    description: "Planos e cobrança (em breve).",
  },
];

export default async function SettingsHubPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  const role = activeOrg?.role;
  const isAdmin = user.is_platform_admin || (role && ROLE_RANK[role] >= ROLE_RANK.admin);
  const isManager = user.is_platform_admin || (role && ROLE_RANK[role] >= ROLE_RANK.manager);

  const visible = LINKS.filter((l) => {
    if (l.adminOnly && !isAdmin) return false;
    if (l.managerOnly && !isManager) return false;
    return true;
  });

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Configurações</h1>
        <p className="text-sm text-muted-foreground">
          Gerencie sua conta, organização e integrações.
        </p>
      </header>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {visible.map((l) => (
          <Link key={l.href} href={l.href} className="block">
            <Card className="h-full p-4 transition-colors hover:border-border-strong">
              <h2 className="text-sm font-semibold">{l.title}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{l.description}</p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
