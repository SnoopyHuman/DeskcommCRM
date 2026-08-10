import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * ISOLAMENTO RLS DE `demandas` E `demanda_conversas` — o gate que faltou entrar
 * junto com a entidade (migrations 0136 + 0138).
 *
 * ## Por que este arquivo existe, e por que ele é catraca e não zelo
 *
 * `tests/invariants/rls-isolation.test.ts` guarda o isolamento por uma **lista
 * fixa**, e o cabeçalho dela diz a consequência com todas as letras: *"tabela
 * tenant-aware nova que NÃO entrar aqui passa verde sem RLS. Não existe
 * varredura genérica"*. As duas tabelas da unidade de demanda entraram no schema
 * sem entrar na lista — medido no `origin/main` 61cc8025: `grep -c demandas`
 * em `rls-isolation.test.ts` devolve 0, e a suíte inteira fica verde.
 *
 * A tabela existe há um PR e já é lida por três superfícies (painel de atrito,
 * Radar, painel do inbox). O que ela guarda é o que o cliente pediu e ainda não
 * foi resolvido, com o próximo passo escrito ao lado — vazar isso é entregar a
 * lista de pendências do vizinho, com nome do contato via `demanda_conversas`.
 *
 * ## O que este arquivo mede que o catálogo NÃO mede
 *
 * Conferir `relrowsecurity` e a existência de uma policy que cite
 * `fn_user_org_ids` **não** prova isolamento: uma policy
 * `organization_id in (select * from fn_user_org_ids()) or true` satisfaz as
 * duas conferências de catálogo e devolve a org inteira do vizinho. Por isso
 * aqui se conta LINHA, sob o mesmo caminho de auth que a produção usa
 * (`set role authenticated` + `request.jwt.claims`), que é o caminho da anon key
 * que vai para o browser.
 *
 * Arquivo NOVO de propósito: `tests/invariants/**` é congelado por
 * `loop/hooks/freeze-invariants.sh` (acrescentar é permitido, modificar não).
 *
 * ## Sabotagem que o prova (medida)
 *
 * `supabase/baseline.sql:9397` — `using (organization_id in (select * from
 * public.fn_user_org_ids()))` trocado por `using (... or true)`: o caso
 * "org A lê 0 linhas de demandas da org B" fica VERMELHO e os demais seguem
 * verdes (o `with check` não foi tocado). Restaurado byte a byte depois.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — run this suite via `pnpm test:db` (scripts/test-db.sh)",
  );
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

// Namespace próprio (d0d0…): os arquivos de invariante rodam em paralelo contra
// o MESMO banco, e reaproveitar as orgs de outro arquivo faria uma corrida
// aparecer como teste instável.
const ORG_A = "d0d0aaaa-0000-4000-8000-000000000001";
const ORG_B = "d0d0bbbb-0000-4000-8000-000000000002";
const USER_A = "d0d0aaaa-1111-4000-8000-000000000001";
const USER_B = "d0d0bbbb-1111-4000-8000-000000000002";
const SESS_A = "d0d0aaaa-2222-4000-8000-000000000001";
const SESS_B = "d0d0bbbb-2222-4000-8000-000000000002";
const CONT_A = "d0d0aaaa-3333-4000-8000-000000000001";
const CONT_B = "d0d0bbbb-3333-4000-8000-000000000002";
const CONV_A = "d0d0aaaa-4444-4000-8000-000000000001";
const CONV_B = "d0d0bbbb-4444-4000-8000-000000000002";
const DEM_A = "d0d0aaaa-5555-4000-8000-000000000001";
const DEM_B = "d0d0bbbb-5555-4000-8000-000000000002";

/** SELECT como `authenticated` com o claim `sub` — o caminho real do PostgREST. */
function countAs(userId: string, countQuery: string): number {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${countQuery}
  `);
  const linhas = out.split("\n");
  const ultima = linhas[linhas.length - 1];
  if (ultima === undefined || !/^\d+$/.test(ultima)) {
    throw new Error(`saída inesperada do psql: ${out}`);
  }
  return Number(ultima);
}

/**
 * DML como `authenticated`. Recusa da RLS (42501 / with-check) conta como 0
 * linhas — que é exatamente o que o invariante mede. Outro erro sobe.
 */
function writeCountAs(userId: string, dml: string): number {
  try {
    const out = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
      with w as (${dml} returning 1) select count(*) from w;
    `);
    const linhas = out.split("\n");
    const ultima = linhas[linhas.length - 1];
    if (ultima === undefined || !/^\d+$/.test(ultima)) {
      throw new Error(`saída inesperada do psql: ${out}`);
    }
    return Number(ultima);
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    if (stderr.includes("row-level security")) return 0;
    throw err;
  }
}

function semeia(
  org: string,
  user: string,
  sess: string,
  contato: string,
  conversa: string,
  demanda: string,
  tag: string,
): string {
  // Sem PII real (LGPD): só e-mail/nome sintéticos.
  return `
    insert into auth.users (id, email) values ('${user}', 'demanda-rls-${tag}@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${org}', 'demanda-rls-${tag}', 'Demanda RLS ${tag}', 'Demanda ${tag}')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${user}', '${org}', 'agent', now())
      on conflict do nothing;
    do $s$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${sess}', '${org}', 'demanda-rls-${tag}', '\\x00'::bytea);
    exception when unique_violation then null; end $s$;
    insert into public.contacts (id, organization_id, display_name)
      values ('${contato}', '${org}', 'Contato demanda RLS ${tag}')
      on conflict (id) do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${conversa}', '${org}', '${contato}', '${sess}', 'open')
      on conflict (id) do nothing;
    -- Semeada EXPLICITAMENTE, e não pela mensagem inbound que dispararia
    -- \`trg_demanda_abre_no_inbound\`: um seed que depende do efeito colateral de
    -- outra peça vira verde por engano no dia em que essa peça mudar, e o
    -- sintoma seria "o isolamento parou de ser testado", em silêncio.
    insert into public.demandas
      (id, organization_id, contact_id, origem, estado, dono_kind, proximo_passo)
      values ('${demanda}', '${org}', '${contato}', 'inbound', 'aberta', 'ia',
              'ligar para o cliente ${tag}')
      on conflict (id) do nothing;
    insert into public.demanda_conversas (organization_id, demanda_id, conversation_id)
      values ('${org}', '${demanda}', '${conversa}')
      on conflict do nothing;
  `;
}

beforeAll(() => {
  sql(
    semeia(ORG_A, USER_A, SESS_A, CONT_A, CONV_A, DEM_A, "a") +
      semeia(ORG_B, USER_B, SESS_B, CONT_B, CONV_B, DEM_B, "b"),
  );
});

describe("isolamento RLS da unidade de demanda", () => {
  it("guarda de vacuidade: as duas orgs realmente têm demanda no banco", () => {
    // Sem isto, "org A lê 0 linhas da org B" passaria por não existir linha
    // nenhuma da org B — o verde mais caro que existe.
    const orgs = Number(
      sql(
        `select count(distinct organization_id) from public.demandas
          where organization_id in ('${ORG_A}','${ORG_B}');`,
      ),
    );
    expect(orgs).toBe(2);
  });

  it("org A lê ZERO demandas da org B", () => {
    expect(
      countAs(USER_A, `select count(*) from public.demandas where organization_id = '${ORG_B}';`),
    ).toBe(0);
  });

  it("org A continua lendo as PRÓPRIAS demandas (controle positivo)", () => {
    // Sem este caso, uma policy `using (false)` daria verde no caso acima e
    // teria quebrado o produto inteiro sem nenhum teste reclamar.
    expect(
      countAs(USER_A, `select count(*) from public.demandas where organization_id = '${ORG_A}';`),
    ).toBeGreaterThanOrEqual(1);
  });

  it("org A lê ZERO vínculos demanda↔conversa da org B", () => {
    expect(
      countAs(
        USER_A,
        `select count(*) from public.demanda_conversas where organization_id = '${ORG_B}';`,
      ),
    ).toBe(0);
  });

  it("org A continua lendo os PRÓPRIOS vínculos (controle positivo)", () => {
    expect(
      countAs(
        USER_A,
        `select count(*) from public.demanda_conversas where organization_id = '${ORG_A}';`,
      ),
    ).toBeGreaterThanOrEqual(1);
  });

  it("org A não CRIA demanda na org B (with check, não só using)", () => {
    expect(
      writeCountAs(
        USER_A,
        `insert into public.demandas (organization_id, contact_id, origem, estado, dono_kind)
           values ('${ORG_B}', '${CONT_B}', 'manual', 'aberta', 'ia')`,
      ),
    ).toBe(0);
  });

  it("org A não escreve o próximo passo de uma demanda da org B", () => {
    // O caminho da rota PATCH usa service role com filtro explícito de org; este
    // caso guarda o OUTRO caminho — a anon key que vai para o browser falando
    // direto com o PostgREST, onde a única defesa é a policy.
    const escritas = writeCountAs(
      USER_A,
      `update public.demandas set proximo_passo = 'invadido' where id = '${DEM_B}'`,
    );
    expect(escritas).toBe(0);
    // E o dado do vizinho continua o que era — medido pelo superusuário, porque
    // "0 linhas escritas" e "escreveu e a leitura foi filtrada" são estados
    // diferentes que o PostgREST devolve iguais.
    expect(sql(`select proximo_passo from public.demandas where id = '${DEM_B}';`)).toBe(
      "ligar para o cliente b",
    );
  });
});
