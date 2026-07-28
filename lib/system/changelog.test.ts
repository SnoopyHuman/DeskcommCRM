import { describe, expect, it } from "vitest";

import { extractChangelogSection } from "./changelog";

const CHANGELOG = `# Changelog

Todas as mudanças relevantes deste projeto são documentadas aqui.

## [Não lançado]

## [1.1.0] — 2026-08-02

**⚠️ Requer atenção**

Se você usa número próprio no WhatsApp, reconecte depois de atualizar.

### Adicionado

- Botão de atualizar pela própria tela.

## [1.0.0] — 2026-07-27

Primeira versão marcada do DeskcommCRM.
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

  it("extrai o bloco de atenção separado do corpo", () => {
    const section = extractChangelogSection(CHANGELOG, "1.1.0");
    expect(section?.requiresAttention).toContain("reconecte depois de atualizar");
  });

  it("devolve null no bloco de atenção quando a versão não tem um", () => {
    expect(extractChangelogSection(CHANGELOG, "1.0.0")?.requiresAttention).toBeNull();
  });

  it("para no próximo heading de versão, não engole o resto do arquivo", () => {
    const section = extractChangelogSection(CHANGELOG, "1.0.0");
    expect(section?.body).toContain("Primeira versão marcada");
    expect(section?.body).not.toContain("[Não lançado]");
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
});
