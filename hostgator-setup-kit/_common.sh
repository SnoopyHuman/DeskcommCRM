#!/usr/bin/env bash
# Helpers compartilhados pelos scripts do kit. Sourced, não executado direto.
set -euo pipefail

COMPOSE="docker-compose.prod.yml"

c_red() { printf '\033[31m%s\033[0m\n' "$*"; }
c_grn() { printf '\033[32m%s\033[0m\n' "$*"; }
c_ylw() { printf '\033[33m%s\033[0m\n' "$*"; }
die()   { c_red "✖ $*"; exit 1; }
step()  { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }

# Vai pro diretório do projeto (onde está o compose) e carrega o .env.
enter_project() {
  if [ -f "$COMPOSE" ]; then :;
  elif [ -f "deskcommcrm/$COMPOSE" ]; then cd deskcommcrm;
  else die "Não achei $COMPOSE. Rode a partir da pasta do projeto."; fi
  [ -f .env ] || die "Falta o .env (rode install.sh primeiro)."
  set -a; . ./.env; set +a
  PROJECT_DIR="$(pwd)"
}

# psql efêmero via container (não exige psql no host).
psql_run() { docker run --rm -i postgres:17-alpine psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 "$@"; }

# Grava (ou reescreve) uma chave no .env — sem duplicar linha se ela já existe.
#   set_env_var .env APP_IMAGE ghcr.io/…:1.1.0
#
# É o que faz uma escolha SOBREVIVER ao processo que a fez. `export APP_IMAGE=…`
# vale só enquanto o script roda: o docker-compose.prod.yml lê a imagem do .env,
# então um `docker compose up -d` rodado à mão pelo dono semanas depois (comando
# documentado no README) voltaria pro APP_IMAGE gravado no install (":latest") e
# DESFARIA a atualização — app do topo da main sobre o banco da versão
# instalada, exatamente o modo de falha pelo qual o Watchtower foi descartado.
set_env_var() {
  local envfile="$1" key="$2" value="$3" tmp
  [ -f "$envfile" ] || return 0
  tmp="${envfile}.tmp.$$"
  # "|| true": com pipefail, grep -v que filtra TODAS as linhas (arquivo de uma
  # linha só) sai 1 e derrubaria o script por set -e antes do append.
  { grep -vE "^${key}=" "$envfile" || true; } > "$tmp"
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  chmod 600 "$tmp"   # o .env tem segredos: o tmp nasce com o mesmo rigor
  mv "$tmp" "$envfile"
}

# Resolve o UUID de um usuário pelo e-mail (admin API do Supabase).
owner_id_by_email() {
  local email="$1"
  curl -fsS "${NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users?filter=email.eq.${email}" \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" 2>/dev/null \
    | grep -o '"id":"[0-9a-f-]\{36\}"' | head -1 | sed 's/.*:"//;s/"//'
}

# Ativa (idempotente) o cron que dispara o drain de eventos a cada minuto. SEM
# isso, nenhuma automação/webhook roda num self-host: neste kit os workers são
# lidos por cron, não por trigger→HTTP nem fila gerenciada (doutrina do
# projeto: trigger Postgres nunca faz HTTP). Chamada por install.sh e
# update.sh — re-rodar não duplica a linha do crontab.
setup_event_log_drain_cron() {
  command -v crontab >/dev/null 2>&1 || { c_ylw "⚠ 'crontab' não encontrado — instale o pacote 'cron' e rode de novo pra ativar as automações."; return 0; }

  local secret="${INTERNAL_CRON_SECRET:-}"
  [ -n "$secret" ] || secret="${INTERNAL_SECRET:-}"
  [ -n "$secret" ] || { c_ylw "⚠ falta INTERNAL_SECRET/INTERNAL_CRON_SECRET — não ativei o cron das automações."; return 0; }
  [ -n "${NEXT_PUBLIC_APP_URL:-}" ] || { c_ylw "⚠ falta NEXT_PUBLIC_APP_URL — não ativei o cron das automações."; return 0; }

  local first_time=1
  if crontab -l 2>/dev/null | grep -q 'event-log-drain'; then first_time=0; fi

  local cron_line="* * * * * curl -fsS -H \"Authorization: Bearer ${secret}\" \"${NEXT_PUBLIC_APP_URL}/api/v1/cron/event-log-drain\" >/dev/null 2>&1"
  # "|| true": com pipefail ativo, grep -v sem match nenhum (crontab vazio ou
  # sem a linha ainda) sai com status 1 e derrubaria o subshell por set -e
  # ANTES do echo do novo cron_line — neutralizamos aqui, de propósito.
  ( crontab -l 2>/dev/null | grep -v 'event-log-drain' || true; echo "$cron_line" ) | crontab -
  c_grn "✓ automações ativas (cron do event-log-drain, a cada minuto)"

  if [ "$first_time" = 1 ]; then
    # 1ª ativação do cron (inclusive numa instalação já existente que nunca
    # teve o drain rodando): pode haver eventos 'pending' antigos acumulados.
    # Se o 1º drain os processasse, dispararia efeitos colaterais atrasados
    # (ex.: webhook de dias/semanas atrás) — surpresa indesejada pro dono do
    # CRM. Marcamos como 'done' só os realmente velhos (>7 dias); os recentes
    # continuam 'pending' e processam normalmente no próximo drain.
    step "Higienizando eventos pendentes antigos (1ª ativação do cron)"
    psql_run -c "update event_log set status='done', updated_at=now() where status='pending' and created_at < now() - interval '7 days';" \
      >/dev/null 2>&1 \
      && c_grn "✓ eventos pendentes com mais de 7 dias marcados como concluídos" \
      || c_ylw "⚠ não consegui higienizar eventos antigos — confira manualmente a tabela event_log se necessário."
  fi
}

# Ativa (idempotente) o cron do agente de atualização: a cada 5 minutos ele
# avisa o app da versão instalada e, se alguém clicou em "Atualizar agora" na
# tela, roda o update.sh sozinho. É o que faz o botão da tela existir de
# verdade — sem cron, a tela mostra "atualização automática indisponível" pra
# sempre. Chamada por install.sh e update.sh (bloco 7) — re-rodar não duplica
# a linha do crontab.
setup_update_agent_cron() {
  command -v crontab >/dev/null 2>&1 || { c_ylw "⚠ 'crontab' não encontrado — o botão de atualizar pela tela não vai funcionar."; return 0; }
  local secret="${INTERNAL_CRON_SECRET:-${INTERNAL_SECRET:-}}"
  [ -n "$secret" ] || { c_ylw "⚠ falta INTERNAL_SECRET — não ativei o agente de atualização."; return 0; }
  [ -n "${NEXT_PUBLIC_APP_URL:-}" ] || { c_ylw "⚠ falta NEXT_PUBLIC_APP_URL — não ativei o agente de atualização."; return 0; }

  # `cd` explícito: o agent.sh chama enter_project(), que acha o projeto pelo
  # DIRETÓRIO CORRENTE. No cron o CWD é o home do dono do crontab — sem o cd,
  # a linha só funciona por acidente (instalação padrão em /root/deskcommcrm) e
  # morre calada a cada 5 minutos em qualquer REPO_DIR customizado ou /opt.
  local cron_line="*/5 * * * * cd ${PROJECT_DIR} && bash hostgator-setup-kit/agent.sh >/dev/null 2>&1"
  # "|| true": com pipefail, grep -v sem match sai 1 e derrubaria o subshell.
  ( crontab -l 2>/dev/null | grep -v 'hostgator-setup-kit/agent.sh' || true; echo "$cron_line" ) | crontab -
  c_grn "✓ atualização pela tela ativa (agente a cada 5 minutos)"
}

# Garante a chave de cifra dos segredos (webhooks/Nuvemshop) e a semeia no
# banco (private.app_secrets, migration 0041). Idempotente: reusa a chave do
# .env se existir (trocá-la invalidaria dados já cifrados); gera se ausente e
# appenda ao .env. Chamada por install.sh e update.sh APÓS aplicar o baseline.
ensure_encryption_key() {
  local envfile="${1:-.env}"
  local key="${NUVEMSHOP_OAUTH_ENCRYPTION_KEY:-}"
  if [ -z "$key" ] && [ -f "$envfile" ]; then
    key="$(grep -E '^NUVEMSHOP_OAUTH_ENCRYPTION_KEY=' "$envfile" | head -1 | cut -d= -f2- || true)"
  fi
  if [ -z "$key" ]; then
    key="$(openssl rand -hex 32)"
    printf '\nNUVEMSHOP_OAUTH_ENCRYPTION_KEY=%s\n' "$key" >> "$envfile"
    c_grn "✓ chave de cifra dos segredos gerada e gravada no .env"
  fi
  export NUVEMSHOP_OAUTH_ENCRYPTION_KEY="$key"

  # Semeia no banco — é de lá que as funções de cifra leem (Supabase não
  # permite configurar a chave via parâmetro de banco).
  psql_run -c "insert into private.app_secrets (name, value) values ('nuvemshop_oauth_key', '${key}') on conflict (name) do update set value = excluded.value, updated_at = now();" \
    >/dev/null 2>&1 \
    && c_grn "✓ chave de cifra ativa no banco (segredos de webhook são guardados cifrados)" \
    || c_ylw "⚠ não consegui semear a chave de cifra no banco — segredos de webhook não poderão ser salvos até rodar update.sh de novo."
}
