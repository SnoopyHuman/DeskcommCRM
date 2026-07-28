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
  const attention = findAttentionRange(bodyLines);

  // `body` é a seção MENOS o bloco de atenção (heading + texto). Sem isto, o
  // mesmo aviso aparece duas vezes na tela: uma na caixa destacada (que é o
  // ponto do bloco separado) e outra dentro de "O que muda" — pior ainda,
  // pra quem precisa agir à mão, porque some a diferença entre "aviso" e
  // "changelog geral".
  const bodyWithoutAttention = attention
    ? [...bodyLines.slice(0, attention.start), ...bodyLines.slice(attention.end)]
    : bodyLines;
  const body = cleanBody(bodyWithoutAttention.join("\n").trim());

  const requiresAttention = attention
    ? cleanBody(bodyLines.slice(attention.start + 1, attention.end).join("\n").trim()) || null
    : null;

  return { version: wanted, body, requiresAttention };
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
 * `body`/`requiresAttention` chegam à tela como Markdown cru (o CHANGELOG.md
 * real usa heading, negrito, itálico, crase e lista em quase toda linha).
 * Sem renderizador de Markdown instalado no projeto (checado: sem
 * `react-markdown`/`marked`/`remark`/`markdown-to-jsx` no `package.json` nem
 * em uso em nenhuma tela) — instalar um pra meia dúzia de linhas de
 * changelog seria dependência nova pra pouco ganho. Isto vira texto legível
 * (não JSX rico): heading e ênfase somem mantendo o conteúdo, lista vira
 * bullet visível.
 */
export function markdownParaTextoSimples(texto: string): string {
  return texto
    .split("\n")
    .map((linha) => {
      let l = linha.replace(/^#{1,6}\s+/, "");
      l = l.replace(/^[-*]\s+/, "• ");
      l = l.replace(/\*\*([^*]+)\*\*/g, "$1");
      l = l.replace(/__([^_]+)__/g, "$1");
      l = l.replace(/`([^`]+)`/g, "$1");
      // Ênfase de asterisco/underscore só conta fora de palavra — do
      // contrário identificadores como `fn_user_org_ids()` (comum no
      // CHANGELOG real, que cita nomes de função) perdem os `_` internos
      // pra virar "fnuserorg_ids()". Mesma regra do CommonMark: delimitador
      // não pode colar em letra/dígito por fora.
      l = l.replace(/(?<!\*)(?<!\w)\*([^*\n]+)\*(?!\*)(?!\w)/g, "$1");
      l = l.replace(/(?<!_)(?<!\w)_([^_\n]+)_(?!_)(?!\w)/g, "$1");
      return l;
    })
    .join("\n");
}

/**
 * Acha onde o bloco de atenção começa (a linha do heading/negrito) e termina
 * (o próximo heading de verdade, não negrito aleatório no meio do aviso) —
 * em índices de `bodyLines`, pra quem chama poder tanto extrair o texto
 * quanto EXCLUIR o intervalo do corpo geral.
 */
function findAttentionRange(bodyLines: string[]): { start: number; end: number } | null {
  const start = bodyLines.findIndex((line) => ATTENTION_HEADING.test(line.trim()));
  if (start === -1) return null;

  const rest = bodyLines.slice(start + 1);
  const nextHeading = rest.findIndex((line) => /^#{2,4}\s/.test(line));
  const end = nextHeading === -1 ? bodyLines.length : start + 1 + nextHeading;
  return { start, end };
}
