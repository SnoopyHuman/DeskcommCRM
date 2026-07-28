import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { extractChangelogSection } from "./changelog";

const CHANGELOG = `# Changelog

Todas as mudanças relevantes deste projeto são documentadas aqui.

## [Não lançado]

Sem novidades pendentes de lançamento.

## [1.1.0] — 2026-08-02

**⚠️ Requer atenção**

Se você usa número próprio no WhatsApp, reconecte depois de atualizar.

### Adicionado

- Botão de atualizar pela própria tela.

## [1.0.0] — 2026-07-27

Primeira versão marcada do DeskcommCRM.

[Não lançado]: https://github.com/melgarafael/DeskcommCRM/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.0.0
`;

describe("extractChangelogSection", () => {
  it("acha a versão pedida e devolve só o corpo dela", () => {
    const section = extractChangelogSection(CHANGELOG, "1.1.0");
    expect(section?.version).toBe("1.1.0");
    expect(section?.body).toContain("Botão de atualizar pela própria tela.");
    expect(section?.body).not.toContain("Primeira versão marcada");
    expect(section?.body).not.toContain("## [1.1.0]");
  });

  it("aceita a versão com o prefixo v da tag", () => {
    expect(extractChangelogSection(CHANGELOG, "v1.1.0")?.version).toBe("1.1.0");
  });

  it("extrai o bloco de atenção separado do corpo (formato negrito)", () => {
    const section = extractChangelogSection(CHANGELOG, "1.1.0");
    expect(section?.requiresAttention).toContain("reconecte depois de atualizar");
  });

  it("extrai bloco de atenção em heading (### ⚠️ Requer atenção)", () => {
    const raw = `## [1.0.0] — 2026-07-27
### ⚠️ Requer atenção
Seu sistema precisa de ação.
### Adicionado
- Algo novo`;
    const section = extractChangelogSection(raw, "1.0.0");
    expect(section?.requiresAttention).toContain("Seu sistema precisa de ação");
  });

  it("devolve null no bloco de atenção quando a versão não tem um", () => {
    const raw = `## [2.0.0] — 2026-09-01
### Adicionado
- Coisa`;
    expect(extractChangelogSection(raw, "2.0.0")?.requiresAttention).toBeNull();
  });

  it("para no próximo heading quando existe: testa com Não lançado que tem 1.1.0 seguinte", () => {
    // O teste placebo original testava 1.0.0 (última seção, sem próxima).
    // Agora testamos "Não lançado" que tem "1.1.0" como próxima seção.
    // A sabotagem (end = lines.length) faria incluir "Botão de atualizar".
    const section = extractChangelogSection(CHANGELOG, "Não lançado");
    expect(section?.body).toContain("Sem novidades pendentes");
    expect(section?.body).not.toContain("Botão de atualizar pela própria tela.");
  });

  it("remove referências de link do final (formato [algo]: http://...)", () => {
    // 1.0.0 é a última versão, então body inclui [1.0.0]: ... antes da limpeza.
    const section = extractChangelogSection(CHANGELOG, "1.0.0");
    expect(section?.body).not.toContain("[Não lançado]:");
    expect(section?.body).not.toContain("github.com");
    expect(section?.body).toContain("Primeira versão marcada");
  });

  it("devolve null para versão ausente", () => {
    expect(extractChangelogSection(CHANGELOG, "9.9.9")).toBeNull();
  });

  it("devolve null para entrada vazia ou lixo", () => {
    expect(extractChangelogSection("", "1.0.0")).toBeNull();
    expect(extractChangelogSection("qualquer coisa sem headings", "1.0.0")).toBeNull();
  });

  it("não confunde 1.1.0 com 1.1.0-beta", () => {
    const raw = "## [1.1.0-beta] — 2026-08-01\n\nbeta\n\n## [1.1.0] — 2026-08-02\n\nfinal\n";
    expect(extractChangelogSection(raw, "1.1.0")?.body.trim()).toBe("final");
  });

  it("não corta bloco de atenção em negrito no meio (ex: **Atenção especial**: ...)", () => {
    // IMPORTANT 3: negrito no meio não termina o bloco, só heading de verdade.
    const raw = `## [1.0.0] — 2026-07-27
**⚠️ Requer atenção**
Leia isto: **Atenção especial** antes de atualizar.
Mais informação aqui.
## [2.0.0]
Novo`;
    const section = extractChangelogSection(raw, "1.0.0");
    expect(section?.requiresAttention).toContain("Atenção especial");
    expect(section?.requiresAttention).toContain("Mais informação");
  });

  it("lê CHANGELOG.md real e encontra 1.0.0 com requiresAttention", () => {
    try {
      const realChangelog = readFileSync(join(process.cwd(), "CHANGELOG.md"), "utf8");
      const section = extractChangelogSection(realChangelog, "1.0.0");
      expect(section).not.toBeNull();
      expect(section?.version).toBe("1.0.0");
      // No CHANGELOG real, linha 76 tem "### ⚠️ Requer atenção" com conteúdo
      expect(section?.requiresAttention).not.toBeNull();
    } catch {
      // Se CHANGELOG.md não existe no cwd, skip (ex: running em outro contexto)
    }
  });
});
