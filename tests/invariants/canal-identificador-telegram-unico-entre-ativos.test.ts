import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * 0165 · o identificador do bot Telegram é único entre os canais ATIVOS.
 *
 * Cobrado no Postgres descartável que nasce do `supabase/baseline.sql` — o
 * arquivo que o self-hoster de fato aplica. Migration que existe só em
 * `migrations/` não chega a ele.
 *
 * ─── O que estas asserções protegem ─────────────────────────────────────────
 * `telegram_bot_id` é o terceiro identificador de canal a ganhar essa trava —
 * depois de `meta_phone_number_id` (0087/0165) e `zernio_account_id`
 * (0131/0165), que nasceram SEM ela e abriram a issue #236: três consultas de
 * `lib/channels/` resolviam a sessão por esses identificadores num client de
 * service role (que bypassa RLS), e com duas linhas casando o `maybeSingle()`
 * devolve `data: null` + `PGRST116` — os resolvedores caíam no `.env`
 * (mensagem saindo pela conta de OUTRA instalação) e a ingestão do canal
 * oficial descartava a mensagem recebida para as DUAS organizações.
 *
 * O risco é o mesmo aqui, plataforma nova: dois bots do Telegram só se
 * distinguem pelo `bot_id` que a Bot API embute no token — se duas
 * organizações cadastrarem o mesmo bot (ou reusarem token por engano), quem
 * resolve credencial por `telegram_bot_id` sem esta trava herda exatamente a
 * mesma ambiguidade cross-tenant.
 *
 * As asserções são de COMPORTAMENTO: "existe um índice chamado X" prova que
 * alguém escreveu o nome; o que o produto precisa é que a segunda linha seja
 * RECUSADA — e com o nome da trava no erro, senão "rejeitou" não distingue esta
 * trava de um CHECK, de uma FK ou da RLS.
 */

function novaOrg(slug: string): string {
  sql(`
    insert into public.organizations (slug, legal_name, display_name)
    values ('${slug}', 'inv 0165 telegram', 'inv 0165 telegram');
  `);
  return sql(`select id from public.organizations where slug = '${slug}'`).trim();
}

function insertSession(org: string, cols: Record<string, string>): string {
  const nomes = ["organization_id", "webhook_secret_encrypted", ...Object.keys(cols)];
  const vals = [`'${org}'`, `'\\x00'::bytea`, ...Object.values(cols)];
  return sql(`
    insert into public.channel_sessions (${nomes.join(", ")})
    values (${vals.join(", ")});
    select 'ok';
  `);
}

function erroDe(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    return String(err.stderr ?? "") + String(err.message ?? "");
  }
  throw new Error("o INSERT passou — a trava não existe neste banco");
}

describe("0165 · a colisão de telegram_bot_id é impossível, não improvável", () => {
  it("duas ORGANIZAÇÕES não podem ter o mesmo telegram_bot_id ativo", () => {
    const a = novaOrg(`inv-0165-tg-a-${Date.now()}`);
    const b = novaOrg(`inv-0165-tg-b-${Date.now()}`);
    insertSession(a, { provider: `'telegram'`, telegram_bot_id: `'0165-bot'` });

    const erro = erroDe(() =>
      insertSession(b, { provider: `'telegram'`, telegram_bot_id: `'0165-bot'` }),
    );
    expect(erro).toContain("channel_sessions_telegram_bot_id_ativo_unique");
  });

  it("canal ARQUIVADO libera o telegram_bot_id — senão excluir e reconectar trava", () => {
    // Mesmo precedente da 0107 aplicado ao terceiro identificador: trava total
    // transformaria "excluí o canal e vou reconectar o mesmo bot" em 23505 na
    // linha nova. É por isso que o índice tem de ser PARCIAL, filtrando
    // `archived_at is null`.
    const org = novaOrg(`inv-0165-tg-arq-${Date.now()}`);
    insertSession(org, {
      provider: `'telegram'`,
      telegram_bot_id: `'0165-tg-arq'`,
      archived_at: `now()`,
    });
    const out = insertSession(org, { provider: `'telegram'`, telegram_bot_id: `'0165-tg-arq'` });
    const linhas = out.split("\n");
    expect(linhas[linhas.length - 1]).toBe("ok");
  });
});

describe("0165 · o recorte do índice de telegram_bot_id é o mesmo que o código consulta", () => {
  it("channel_sessions_telegram_bot_id_ativo_unique é ÚNICO e parcial em archived_at is null", () => {
    // Vale como asserção estrutural (a de comportamento está acima) porque a
    // migration só é auto-curativa enquanto o predicado for este: um índice
    // TOTAL quebraria o reconectar-o-mesmo-bot da 0107, e um índice não-único
    // passaria os INSERTs sem ninguém perceber até a próxima credencial sair
    // pela conta errada.
    const def = sql(`select indexdef from pg_indexes
                      where schemaname = 'public'
                        and indexname = 'channel_sessions_telegram_bot_id_ativo_unique'`);
    expect(def).toContain("CREATE UNIQUE INDEX");
    expect(def).toContain("(telegram_bot_id)");
    expect(def).toContain("archived_at IS NULL");
  });
});
