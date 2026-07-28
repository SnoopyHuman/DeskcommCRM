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
/** Casa tanto com heading (`### ⚠️ Requer atenção`) quanto com negrito (`**⚠️ Requer atenção**`). */
const ATTENTION_HEADING = /^(#{2,4}\s+)?(\*{1,2})?⚠️?\s*Requer atenção(\*{1,2})?$/i;

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
  const body = cleanBody(bodyLines.join("\n").trim());
  return {
    version: wanted,
    body,
    requiresAttention: extractAttention(bodyLines),
  };
}

/**
 * Limpa referências de link do final do corpo (formato `[algo]: http://...`).
 * Isso evita que o rodapé do arquivo apareça na seção antes do botão "Atualizar".
 */
function cleanBody(body: string): string {
  const lines = body.split("\n");
  // Remove linhas de referência de link do final: `[algo]: http...`
  while (lines.length > 0) {
    const lastLine = lines[lines.length - 1];
    if (lastLine && /^\[.+\]:\s+https?:\/\//.test(lastLine)) {
      lines.pop();
    } else {
      break;
    }
  }
  return lines.join("\n").trim();
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
  // Termina apenas em heading de verdade, não em negrito aleatório no meio do aviso.
  const nextHeading = rest.findIndex((line) => /^#{2,4}\s/.test(line));
  const block = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  const text = cleanBody(block.join("\n").trim());
  return text || null;
}
