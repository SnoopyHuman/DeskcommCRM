/**
 * Atualização self-service pela UI (doutrina de QA visual, DoD 12) — prova
 * pela TELA, como o dono da instalação faria. O agente do host (`agent.sh`,
 * task 8) é simulado por requisições `POST /api/v1/system/agent` assinadas
 * com o mesmo segredo que ele usaria de verdade: o que se prova aqui é a
 * experiência na tela (rodapé → aviso → clique → progresso → desfecho), não
 * o bash em si — esse é provado na VPS (ver o brief da task).
 *
 * Pré-requisitos:
 * - `.e2e-creds.json` (o spec roda `seed-e2e-credentials.ts` sozinho se
 *   ausente/incompleto, como `rbac-roles.spec.ts`) + `seed-e2e-system-update.ts`
 *   (promove o usuário `admin` do seed a dono do servidor via `platform_admins`
 *   — é uma superfície diferente do role de organização — e limpa
 *   `system_version`/`system_update_runs` pra não colidir com o índice único
 *   de run em andamento).
 * - `INTERNAL_SECRET` no ambiente do Playwright (o segredo que autentica o
 *   agente do host em `/api/v1/system/agent`). Sem ele, o heartbeat simulado
 *   nem autenticaria — o arquivo INTEIRO pula em vez de falhar por motivo
 *   errado (ausência de ambiente ≠ defeito).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const SECRET = process.env.INTERNAL_SECRET ?? "";

test.skip(
  !SECRET,
  "INTERNAL_SECRET ausente no ambiente do Playwright — o heartbeat simulado do agente do host não teria como autenticar.",
);

interface E2ECreds {
  password: string;
  users: Record<string, { id: string; email: string; role: string }>;
  admin_totp?: { factor_id: string; secret: string };
}

function loadCreds(): E2ECreds {
  const needsSeed = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
    return !c.users?.agent || !c.admin_totp?.secret;
  };
  if (needsSeed()) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  // Dono do servidor (platform_admins) + system_version/system_update_runs
  // limpos — idempotente, roda sempre pra deixar o teste repetível.
  execFileSync("npx", ["tsx", "scripts/seed-e2e-system-update.ts"], { stdio: "inherit" });
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
}

// Só carrega/seeda de verdade quando o teste vai rodar — sem SECRET, o arquivo
// inteiro já pulou acima, e chamar isto seria trabalho (e risco de falha de
// banco) para um teste que nunca vai executar.
const creds: E2ECreds = SECRET ? loadCreds() : ({ password: "", users: {} } as E2ECreds);

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

async function loginWithTotp(page: Page, email: string, secret: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/login\/mfa/);

  // Até 2 tentativas: um código pode expirar na borda da janela de 30s.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (msUntilNextTotpWindow() < 3_000) {
      await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    }
    const code = generateTotp(secret);
    const firstDigit = page.locator('input[aria-label="Dígito 1"]');
    await firstDigit.click();
    await page.keyboard.type(code, { delay: 40 });
    try {
      await page.waitForURL(/\/app\//, { timeout: 8_000 });
      return;
    } catch {
      // código rejeitado — espera a próxima janela e tenta de novo
      await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    }
  }
  throw new Error("MFA challenge failed after 2 TOTP attempts");
}

interface HeartbeatResponse {
  data: { update_requested: boolean; run_id: string | null };
}

/** Simula um ciclo do `agent.sh` real: mesmo endpoint, mesmo bearer. */
async function heartbeat(
  request: APIRequestContext,
  opts: { latest_version: string; current_version?: string; changelog?: string },
): Promise<HeartbeatResponse> {
  const res = await request.post("/api/v1/system/agent", {
    headers: { Authorization: `Bearer ${SECRET}` },
    data: {
      kind: "heartbeat",
      current_version: opts.current_version ?? "1.0.0",
      current_sha: "abc1234",
      off_release: false,
      latest_version: opts.latest_version,
      changelog: opts.changelog ?? "",
    },
  });
  expect(res.status()).toBe(200);
  return res.json();
}

test("o dono vê a versão nova na sidebar e atualiza pela tela", async ({ page, request }) => {
  const changelog =
    "## [1.1.0] — 2026-08-02\n\n**⚠️ Requer atenção**\n\nReconecte o número depois.\n\n### Adicionado\n\n- Botão de atualizar pela tela.\n";

  await loginWithTotp(page, creds.users.admin!.email, creds.admin_totp!.secret);
  await heartbeat(request, { latest_version: "1.1.0", changelog });
  await page.goto("/app/inbox");

  const aviso = page.getByRole("link", { name: /nova versão/i });
  await expect(aviso).toBeVisible();
  await aviso.click();
  await page.waitForURL(/\/app\/settings\/atualizacao/);

  await expect(page.getByRole("heading", { name: /versão 1\.1\.0 disponível/i })).toBeVisible();
  await expect(page.getByText(/Reconecte o número depois/)).toBeVisible();
  await expect(page.getByText(/Botão de atualizar pela tela/)).toBeVisible();
  await page.screenshot({ path: ".superpowers/evidence/task9-1-tem-novidade.png" });

  // O bloco de atenção precisa vir ANTES do botão na ordem visual — medido
  // por ferramenta (boundingBox), nunca a olho: quem precisa agir à mão (ex.:
  // reconectar o número) tem que ver isso ANTES de clicar, não descobrir depois.
  const atencao = await page.getByText(/Reconecte o número depois/).boundingBox();
  const botao = await page.getByRole("button", { name: /atualizar agora/i }).boundingBox();
  expect(atencao).not.toBeNull();
  expect(botao).not.toBeNull();
  expect(atencao!.y).toBeLessThan(botao!.y);

  await page.getByRole("button", { name: /atualizar agora/i }).click();
  await expect(page.getByRole("heading", { name: /atualizando para a versão 1\.1\.0/i })).toBeVisible();
  await expect(page.getByText(/Guardando uma cópia de segurança/)).toBeVisible();
  await page.screenshot({ path: ".superpowers/evidence/task9-2-atualizando.png" });

  // O agente do host detecta o pedido no próximo heartbeat...
  const { data } = await heartbeat(request, { latest_version: "1.1.0" });
  expect(data.update_requested).toBe(true);
  expect(data.run_id).not.toBeNull();

  // ...executa (fora deste teste — é o `agent.sh`/`update.sh` reais, provados
  // na task 8) e reporta o desfecho.
  const runResult = await request.post("/api/v1/system/agent", {
    headers: { Authorization: `Bearer ${SECRET}` },
    data: { kind: "run_result", run_id: data.run_id, status: "success", log_tail: "ok" },
  });
  expect(runResult.status()).toBe(200);

  // Depois do sucesso, o agente reinicia e o próximo heartbeat já anuncia a
  // versão nova como a instalada — é o que a tela usa pra sair do estado
  // "atualizando" e mostrar "você está em dia".
  await heartbeat(request, { current_version: "1.1.0", latest_version: "1.1.0" });
  await page.reload();
  await expect(page.getByRole("heading", { name: /você está na versão 1\.1\.0/i })).toBeVisible();
  await page.screenshot({ path: ".superpowers/evidence/task9-3-em-dia.png" });
});

test("quem não é dono do servidor não vê o botão", async ({ page, request }) => {
  // Update disponível de verdade nesse instante — a ausência do aviso tem que
  // vir da falta de is_platform_admin, não de coincidentemente já estar em dia.
  await heartbeat(request, { current_version: "1.0.0", latest_version: "1.1.0" });

  await login(page, creds.users.agent!.email);
  await page.goto("/app/inbox");
  await expect(page.getByRole("link", { name: /nova versão/i })).toHaveCount(0);

  await page.goto("/app/settings/atualizacao");
  await expect(page.getByText(/404 — Página não encontrada/i)).toBeVisible();
  await page.screenshot({ path: ".superpowers/evidence/task9-4-nao-dono-404.png" });
});
