/**
 * C3-01 — política de expiração do contexto por etapa (Spec 16 §9.1).
 *
 * Prova pela tela, como um leigo usaria: admin marca "a IA recomeça do zero"
 * numa etapa, define a carência, recarrega e vê o valor salvo — sem nenhum
 * jargão técnico na tela. Manager (abaixo de admin) não vê o controle: a rota
 * já recusa (`context.policy_write`), e a tela ESCONDE em vez de desabilitar —
 * mesmo precedente do editor de vocabulário/custom fields desta mesma página.
 *
 * Pré-requisito: scripts/seed-e2e-credentials.ts + scripts/seed-e2e-pipeline-policy.ts
 * (o beforeAll roda os dois; o segundo garante uma etapa dedicada e o baseline
 * de fábrica — resets_context=false, context_reset_after_days=7 — a cada run).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCE = path.join(process.cwd(), ".superpowers/evidence/C3");

interface Creds {
  password: string;
  users: Record<string, { id: string; email: string; role: string }>;
  admin_totp?: { factor_id: string; secret: string };
  pipeline_policy?: { pipeline_id: string; stage_id: string; stage_name: string };
}

let creds: Creds;

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//, { timeout: 60_000 });
}

async function loginWithTotp(page: Page, email: string, password: string, secret: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
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
      await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    }
  }
  throw new Error("MFA challenge failed after 2 TOTP attempts");
}

test.describe("C3-01 — política de expiração do contexto por etapa", () => {
  // Dev server (next start) + primeira compilação da rota podem passar de 30s.
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(() => {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    execFileSync("npx", ["tsx", "scripts/seed-e2e-pipeline-policy.ts"], { stdio: "inherit" });
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    if (!creds.pipeline_policy) throw new Error("bloco `pipeline_policy` ausente em .e2e-creds.json");
    if (!creds.admin_totp?.secret) throw new Error("bloco `admin_totp` ausente em .e2e-creds.json");
    fs.mkdirSync(EVIDENCE, { recursive: true });
  });

  test("admin marca 'a IA recomeça do zero', define a carência, e o valor persiste após reload", async ({
    page,
  }) => {
    const { pipeline_id, stage_id } = creds.pipeline_policy!;
    await loginWithTotp(page, creds.users.admin!.email, creds.password, creds.admin_totp!.secret);

    await page.goto(`/app/settings/tenant/pipelines#etapas-${pipeline_id}`);
    const linha = page.getByTestId(`etapa-${stage_id}`);
    await expect(linha).toBeVisible();

    const bloco = linha.getByTestId(`politica-contexto-${stage_id}`);
    await expect(bloco).toBeVisible();
    await expect(bloco.getByText("Recomeçar o atendimento nesta etapa")).toBeVisible();
    await expect(
      bloco.getByText("Quando o negócio chegar aqui, a IA recomeça do zero"),
    ).toBeVisible();
    await expect(
      bloco.getByText(/A IA esquece o que foi conversado/),
    ).toBeVisible();
    // Nenhum jargão técnico nesta tela.
    await expect(bloco.getByText(/checkpoint|cutoff|lead_state/i)).toHaveCount(0);

    await page.screenshot({ path: path.join(EVIDENCE, "01-bloco-politica-antes.png") });

    const switchEl = bloco.getByTestId(`resets-context-${stage_id}`);
    await expect(switchEl).toHaveAttribute("aria-checked", "false");
    await switchEl.click();
    // Sem otimismo local: o Switch só reflete `checked=true` depois do PATCH
    // resolver e a releitura (`onSettled`) trazer o estado de volta — round-trip
    // real contra o Supabase remoto, por isso a janela generosa.
    await expect(page.getByText("Etapa atualizada.")).toBeVisible({ timeout: 15_000 });
    await expect(switchEl).toHaveAttribute("aria-checked", "true");

    const dias = bloco.getByTestId(`dias-contexto-${stage_id}`);
    await dias.fill("14");
    await dias.blur();
    await expect(page.getByText("Etapa atualizada.")).toBeVisible({ timeout: 15_000 });

    await page.screenshot({ path: path.join(EVIDENCE, "02-bloco-politica-depois.png") });

    // Recarrega: o que a tela mostra tem que ser o que o banco tem, não um eco otimista.
    await page.reload();
    const blocoDepois = page.getByTestId(`etapa-${stage_id}`).getByTestId(`politica-contexto-${stage_id}`);
    await expect(blocoDepois.getByTestId(`resets-context-${stage_id}`)).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(blocoDepois.getByTestId(`dias-contexto-${stage_id}`)).toHaveValue("14");
  });

  test("manager não vê o bloco de política — a rota é admin, a tela esconde", async ({ page }) => {
    const { pipeline_id, stage_id } = creds.pipeline_policy!;
    await login(page, creds.users.manager!.email, creds.password);

    await page.goto(`/app/settings/tenant/pipelines#etapas-${pipeline_id}`);
    const linha = page.getByTestId(`etapa-${stage_id}`);
    await expect(linha).toBeVisible();

    // A etapa continua editável (nome, papel, ordem) — só a política some.
    await expect(linha.getByTestId(`nome-${stage_id}`)).toBeVisible();
    await expect(linha.getByTestId(`politica-contexto-${stage_id}`)).toHaveCount(0);

    await page.screenshot({ path: path.join(EVIDENCE, "03-manager-sem-bloco.png") });
  });
});
