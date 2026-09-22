-- 0381 — vocabulário do canal Telegram (Bot API nativa) em channel_sessions e conversations.
--
-- Canal NATIVO, não intermediário: ao contrário de zernio/zernio_social (que
-- dependem de um BSP terceiro), o bot fala direto com a Bot API do Telegram —
-- por isso o vocabulário entra junto de waha/meta_cloud no CHECK de
-- `channel_sessions`, e `telegram` entra à mão em `conversations.channel`
-- (não via `SOCIAL_NETWORKS[].inbox`, que continua reservado ao caminho
-- Zernio; ver `lib/channels/canais-de-conversa.ts`).
--
-- `telegram_bot_id`: o id numérico do bot, devolvido por `getMe` — identifica
-- QUAL bot está conectado, não o cliente que escreve. `telegram_bot_token_encrypted`:
-- o token de autenticação da Bot API, cifrado como `meta_token_encrypted` e
-- `zernio_token_encrypted`, mesmo padrão de `fn_encrypt_oauth`.
--
-- Idempotente e auto-curativa (doutrina de migrations): as duas colunas
-- nascem nullable, então nenhuma linha existente as viola; os dois CHECKs de
-- `channel_sessions` são RECRIADOS (drop + add) porque aqui eles precisam
-- MUDAR — um clone que já tem cinco providers ficaria com a constraint antiga
-- e recusaria a sessão nova em silêncio, que é o pior desfecho possível: o
-- `update.sh` passa verde e o canal não conecta. Mesmo raciocínio para
-- `conversations_channel_check`.
--
-- Nenhum dado a deduplicar antes das constraints: toda linha pré-existente
-- tem provider fora de 'telegram' e já satisfaz o ramo correspondente.
--
-- Índice único parcial `channel_sessions_telegram_bot_id_ativo_unique`, mesmo
-- desenho de `channel_sessions_meta_phone_number_id_ativo_unique` (issue
-- #236): dois bots diferentes não podem resolver para a mesma organização por
-- acidente, e `archived_at is null` libera o identificador quando o canal é
-- desconectado e reconectado (precedente da 0107).

alter table public.channel_sessions
  add column if not exists telegram_bot_id text,
  add column if not exists telegram_bot_token_encrypted bytea;

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  check (provider = any (array['waha'::text, 'meta_cloud'::text, 'zernio'::text, 'wacalls'::text, 'zernio_social'::text, 'telegram'::text]));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha'       and waha_session_name    is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    (provider in ('zernio', 'zernio_social') and zernio_account_id is not null) or
    (provider = 'wacalls'    and wacalls_session_id    is not null) or
    (provider = 'telegram'   and telegram_bot_id       is not null)
  );

comment on column public.channel_sessions.telegram_bot_id is
  'Id numérico do bot conectado, devolvido por getMe — identifica QUAL bot está conectado, não o cliente que escreve. É o que endereça envio e webhook. Espelhado em lib/channels/session-ref.ts.';

alter table public.conversations drop constraint if exists conversations_channel_check;
alter table public.conversations add constraint conversations_channel_check
  check (channel in ('whatsapp', 'instagram', 'facebook', 'telegram'));

-- Dedup antes da trava, mesmo padrão da 0165: se algum clone já tiver duas
-- linhas ativas com o mesmo telegram_bot_id (não deveria, mas o update.sh
-- precisa ser auto-curativo), a mais nova ganha um sufixo e libera o índice.
with dup as (
  select id, row_number() over (
           partition by telegram_bot_id
           order by created_at
         ) as rn
    from public.channel_sessions
   where archived_at is null
     and telegram_bot_id is not null
)
update public.channel_sessions s
   set telegram_bot_id = s.telegram_bot_id || '-conflito-' || s.id::text
  from dup
 where dup.id = s.id and dup.rn > 1;

create unique index if not exists channel_sessions_telegram_bot_id_ativo_unique
  on public.channel_sessions (telegram_bot_id)
  where archived_at is null and telegram_bot_id is not null;
