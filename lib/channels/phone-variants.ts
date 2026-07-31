/**
 * Variantes de um número para **BUSCA** de contato — nunca para escrita.
 *
 * ─── O problema, medido contra a WABA real em 2026-07-29 ─────────────────────
 * A mesma pessoa chega com identificadores diferentes dependendo da direção:
 *
 *   envio (funcionou)        5531998966398   13 dígitos
 *   `wa_id` do inbound        553198966398   12 dígitos, sem o nono
 *
 * É o nono dígito brasileiro: o `wa_id` do WhatsApp para celulares registrados antes
 * da mudança omite o `9`. Sem tratar, o contato que recebe uma mensagem e o contato
 * que responde viram DOIS — conversa partida, histórico do lead fragmentado, e
 * silencioso: ninguém percebe até ver dois cadastros com o mesmo nome.
 *
 * ─── Por que VARIANTE e não normalização ────────────────────────────────────
 * Normalizar na entrada (todo 12 vira 13) uniformiza o dado e **pode fundir dois
 * contatos reais**: um fixo legítimo de 12 dígitos viraria um celular inexistente, e
 * a fusão não tem volta. Gerar variantes só amplia a BUSCA — nenhuma escrita muda,
 * nenhum dado é reinterpretado, e errar custa no máximo um `select` a mais.
 *
 * A regra é conservadora de propósito: só gera variante quando o número tem cara de
 * celular brasileiro. Fixo, número curto e qualquer país que não o Brasil saem com
 * uma variante só — a original.
 */

/** Só dígitos, sem `+`. */
function digitsOf(raw: string): string {
  return raw.replace(/\D/g, "");
}

/**
 * Formas pelas quais este número pode estar gravado. A primeira é sempre a original;
 * a segunda (quando existe) é a contraparte com/sem o nono dígito.
 *
 * Devolve E.164 **com `+`**, que é como `contacts.phone_number` guarda.
 */
export function phoneLookupVariants(raw: string): string[] {
  const d = digitsOf(raw);
  if (d.length === 0) return [];

  const original = `+${d}`;
  // Fora do Brasil o nono dígito não existe — variante única, sem inventar regra.
  if (!d.startsWith("55")) return [original];

  const ddd = d.slice(2, 4);
  const local = d.slice(4);
  // DDD brasileiro válido começa em 1 (11..99). Fora disso não arriscamos nada.
  if (ddd.length !== 2 || !/^[1-9][0-9]$/.test(ddd)) return [original];

  // 12 dígitos: 55 + DDD + 8 locais. Celular antigo perdeu o 9 → a variante o devolve.
  // Só quando o local começa em 6-9, que é a faixa de celular; 2-5 é fixo e fica fora.
  if (local.length === 8) {
    if (!/^[6-9]/.test(local)) return [original];
    return [original, `+55${ddd}9${local}`];
  }

  // 13 dígitos: 55 + DDD + 9 locais começando em 9 → a variante remove o nono.
  //
  // A checagem do que SOBRA é o que torna esta direção tão prudente quanto a outra.
  // Sem ela, um `9` grudado num número de fixo (5531 9 3234-5678) geraria a variante
  // 553132345678 — que é o fixo REAL de outra pessoa. Regra generosa na volta desfaz
  // a cautela da ida, e a fusão de dois contatos não tem retorno.
  if (local.length === 9 && local.startsWith("9") && /^[6-9]/.test(local.slice(1))) {
    return [original, `+55${ddd}${local.slice(1)}`];
  }

  return [original];
}

/**
 * Os dois números são a MESMA pessoa, considerando o nono dígito?
 *
 * Útil para asserção e para decidir merge — nunca para reescrever o dado gravado.
 */
export function samePhone(a: string, b: string): boolean {
  const va = new Set(phoneLookupVariants(a));
  return phoneLookupVariants(b).some((v) => va.has(v));
}
