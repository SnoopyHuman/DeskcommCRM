/**
 * Extrai a seção de UMA versão do CHANGELOG.md (Keep a Changelog, pt-BR).
 *
 * Mora no app, e não em `awk` dentro do agente do host, por um motivo só:
 * aqui é função pura e testável. O agente manda o arquivo cru; quem interpreta
 * é quem exibe.
 */

export interface ChangelogSection {
  version: string;
  body: string;
  requiresAttention: string | null;
}

/** Teto do que o agente pode mandar. O CHANGELOG real tem ~4 KB. */
export const CHANGELOG_MAX_BYTES = 64_000;

/** `## [1.1.0] — 2026-08-02` e também `## [Não lançado]`. */
const VERSION_HEADING = /^##\s+\[([^\]]+)\]/;
const ATTENTION_HEADING = /^\*{0,2}⚠️?\s*Requer atenção\*{0,2}\s*$/i;

function normalize(version: string): string {
  return version.trim().replace(/^v/i, "");
}

export function extractChangelogSection(raw: string, version: string): ChangelogSection | null {
  const wanted = normalize(version);
  if (!raw || !wanted) return null;

  const lines = raw.split("\n");
  let start = -1;
  let end = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const match = VERSION_HEADING.exec(lines[i] ?? "");
    if (!match) continue;
    if (start === -1) {
      if (normalize(match[1] ?? "") === wanted) start = i + 1;
    } else {
      end = i;
      break;
    }
  }

  if (start === -1) return null;

  const bodyLines = lines.slice(start, end);
  return {
    version: wanted,
    body: bodyLines.join("\n").trim(),
    requiresAttention: extractAttention(bodyLines),
  };
}

/**
 * O bloco de atenção vai do heading até o próximo heading de qualquer nível.
 * Separado do corpo porque a tela o mostra ACIMA do botão — quem precisa agir
 * à mão não pode descobrir isso rolando a página depois de já ter clicado.
 */
function extractAttention(bodyLines: string[]): string | null {
  const start = bodyLines.findIndex((line) => ATTENTION_HEADING.test(line.trim()));
  if (start === -1) return null;

  const rest = bodyLines.slice(start + 1);
  const nextHeading = rest.findIndex((line) => /^#{2,4}\s/.test(line) || /^\*\*/.test(line.trim()));
  const block = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  const text = block.join("\n").trim();
  return text || null;
}
