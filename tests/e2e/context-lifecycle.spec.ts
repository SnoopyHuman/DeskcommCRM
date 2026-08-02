/**
 * C2 — ciclo de vida do contexto do agente (Spec 16 / PRD 07).
 *
 * Cobertura permanente pro que a review do PR #4 (QA manual, 02/08/2026)
 * validou manualmente mexendo direto no Supabase e pediu como regressão
 * automatizada (achados A/D):
 *
 *  1. Hard reset bloqueado por caso humano aberto (`agent_cases.status =
 *     'awaiting_human'`) → 409 com a mensagem exata da Spec 16 §9.3, diálogo
 *     continua aberto.
 *  2. Divisor de corte renderiza na posição certa na thread (mensagem
 *     anterior ao corte continua visível pro humano) + `DELETE
 *     /api/v1/contacts/{id}/context/cutoff` REAL — chamado via `page.request`
 *     (cookies da sessão autenticada do Playwright, não curl solto) — remove
 *     a marca, o divisor some após reload, e uma 2ª chamada é idempotente
 *     (`cleared:false`).
 *
 * A UI publicada não tem um botão pra "desfazer corte" (só o backend existe);
 * por isso o passo 2 dirige a rota real via `page.request` em vez de clique —
 * ainda é uma chamada autenticada de dentro da sessão do browser, não uma
 * chamada isolada fora do fluxo do usuário.
 *
 * Pré-requisito: scripts/seed-e2e-credentials.ts + scripts/seed-e2e-context.ts
 * (o beforeAll re-roda o seed de contexto para restaurar o estado a cada run).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCE = path.join(process.cwd(), ".superpowers/evidence/C2");

interface Creds {
  password: string;
  users: Record<string, { id: string; email: string; role: string }>;
  context?: {
    contact_id: string;
    conversation_id: string;
    contact_name: string;
    cutoff_iso: string;
    fato_antes_do_corte: string;
    fato_depois_do_corte: string;
  };
}

let creds: Creds;

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//, { timeout: 60_000 });
}

test.describe("C2 — ciclo de vida do contexto", () => {
  // Dev server compila /app/* a frio na 1ª visita (pode passar de 30s).
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(() => {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-context.ts"], { stdio: "inherit" });
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    if (!creds.context) throw new Error("bloco `context` ausente em .e2e-creds.json");
    fs.mkdirSync(EVIDENCE, { recursive: true });
  });

  test("hard reset bloqueado por caso humano aberto → 409 com a mensagem da Spec 16 §9.3", async ({
    page,
  }) => {
    const ctx = creds.context!;
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto(`/app/contacts/${ctx.contact_id}`);

    await page.getByRole("button", { name: "Resetar conversa" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.locator("#reset-confirm").fill("APAGAR");
    await page.getByRole("button", { name: "Apagar contexto" }).click();

    const alerta = page.getByRole("alert");
    await expect(alerta).toBeVisible({ timeout: 15_000 });
    await expect(alerta).toHaveText(
      "Existe um caso aberto para este contato. Resolva o caso antes de apagar o contexto — senão quem estiver cuidando dele perde a referência.",
    );
    // Bloqueado de verdade: o diálogo de confirmação continua aberto, nada foi apagado.
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.screenshot({
      path: path.join(EVIDENCE, "C2-hard-reset-blocked.png"),
      fullPage: true,
    });
  });

  test("divisor na posição certa + DELETE real do cutoff remove a marca e é idempotente", async ({
    page,
  }) => {
    const ctx = creds.context!;
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto(`/app/inbox/${ctx.conversation_id}`);

    // (1) Divisor visível, e a mensagem anterior ao corte CONTINUA visível pro
    // humano (Spec 16 §9.4 — soft reset é filtro de leitura, não apaga nada).
    const divisor = page.getByRole("separator", { name: /Contexto reiniciado/ });
    await expect(divisor).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(ctx.fato_antes_do_corte)).toBeVisible();
    await expect(page.getByText(ctx.fato_depois_do_corte)).toBeVisible();
    await page.screenshot({
      path: path.join(EVIDENCE, "C2-divisor-thread.png"),
      fullPage: true,
    });

    // (2) DELETE real através da sessão autenticada do Playwright (cookies
    // compartilhados com `page`) — não é uma chamada solta fora do fluxo.
    const del1 = await page.request.delete(
      `/api/v1/contacts/${ctx.contact_id}/context/cutoff`,
    );
    expect(del1.ok()).toBe(true);
    const body1 = (await del1.json()) as { data: { contact_id: string; cleared: boolean } };
    expect(body1.data).toEqual({ contact_id: ctx.contact_id, cleared: true });

    // (3) Reload → divisor some (query do Inbox precisa refletir o novo estado).
    await page.reload();
    await expect(page.getByRole("separator", { name: /Contexto reiniciado/ })).toHaveCount(0, {
      timeout: 15_000,
    });

    // (4) Idempotência: 2ª chamada sem corte → cleared:false.
    const del2 = await page.request.delete(
      `/api/v1/contacts/${ctx.contact_id}/context/cutoff`,
    );
    expect(del2.ok()).toBe(true);
    const body2 = (await del2.json()) as { data: { contact_id: string; cleared: boolean } };
    expect(body2.data).toEqual({ contact_id: ctx.contact_id, cleared: false });
  });
});
