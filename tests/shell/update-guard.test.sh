#!/usr/bin/env bash
# Prova do `hostgator-setup-kit/update.sh` num repositório git descartável, com
# `docker` e `crontab` substituídos por dublês — nada aqui toca a máquina de
# quem roda (nenhum container sobe, nenhum crontab real é escrito).
#
#   bash tests/shell/update-guard.test.sh
#
# O que está sob prova (defeitos reais achados na revisão final da branch):
#   1. Alvo ANTERIOR ao que está instalado é recusado ANTES do backup — numa
#      instalação que segue a `main`, `git describe --exact-match` é vazio e a
#      comparação de tags passa batido: sem a guarda de ancestralidade, o
#      script rebobinava a instalação para a última tag publicada.
#   2. `--force` continua sendo a saída explícita de quem quer mesmo voltar.
#   3. A imagem escolhida é GRAVADA no .env (não só exportada), sem duplicar a
#      chave a cada execução — senão o próximo `docker compose up -d` do dono
#      volta pro ":latest" e desfaz a atualização.
#   4. A linha de cron do agente entra na pasta do projeto (o agent.sh resolve
#      o projeto pelo diretório corrente, e no cron o CWD é o home).
#   5. Mesmo quando o update é recusado, o agente da tela fica instalado — é o
#      que faz o bootstrap pelo terminal ter fim.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() {  # check <descrição> <comando de verificação...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}

# ── Dublês de `docker` e `crontab` ───────────────────────────────────────────
mkdir -p "$WORK/bin"
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
case " $* " in
  # Healthcheck do update.sh: "docker compose ... exec -T app node -e ..."
  *" exec "*)   printf '{"status":"ok"}\n' ;;
  # Imagem em execução, que o agent.sh guarda para poder voltar. Precisa
  # devolver algo: com PREV_IMAGE vazio o rollback nem seria tentado, e o teste
  # do agente passaria mesmo com o defeito de volta.
  *" images "*) printf 'sha256:deadbeef\n' ;;
esac
exit 0
STUB
cat > "$WORK/bin/crontab" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = "-l" ] && { [ -f "$FAKE_CRONTAB" ] && cat "$FAKE_CRONTAB"; exit 0; }
[ "${1:-}" = "-" ] && { cat > "$FAKE_CRONTAB"; exit 0; }
exit 0
STUB
# flock não existe no macOS e o agent.sh depende dele; aqui a exclusão mútua
# não está sob prova, então o dublê só deixa passar.
cat > "$WORK/bin/flock" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
# O "app": responde ao heartbeat que ALGUÉM PEDIU uma atualização (é o que faz
# o agente sair do heartbeat e ir executar) e guarda cada corpo enviado, que é
# como a prova lê o desfecho reportado.
cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
payload=""
while [ $# -gt 0 ]; do
  [ "$1" = "-d" ] && { shift; payload="$1"; }
  shift
done
printf '%s\n' "$payload" >> "$CURL_LOG"
case "$payload" in
  *heartbeat*) printf '{"data":{"update_requested":true,"run_id":"11111111-1111-4111-8111-111111111111"}}\n200' ;;
  *)           printf '{"data":{}}\n200' ;;
esac
STUB
chmod +x "$WORK/bin/docker" "$WORK/bin/crontab" "$WORK/bin/flock" "$WORK/bin/curl"
export DOCKER_LOG="$WORK/docker.log" CURL_LOG="$WORK/curl.log"
export FAKE_CRONTAB="$WORK/crontab.txt"
export PATH="$WORK/bin:$PATH"

# ── Instalação de mentira: repo git + kit + .env ─────────────────────────────
PROJ="$WORK/deskcommcrm"
mkdir -p "$PROJ/hostgator-setup-kit" "$PROJ/supabase"
cp "$REPO_ROOT/hostgator-setup-kit/_common.sh" "$REPO_ROOT/hostgator-setup-kit/update.sh" \
   "$REPO_ROOT/hostgator-setup-kit/agent.sh" "$PROJ/hostgator-setup-kit/"
# backup.sh de mentira: deixa um rastro. É o marco "o script já começou a
# mexer" — a guarda de retrocesso só vale se abortar ANTES dele.
BACKUP_MARK="$WORK/backup-rodou"
cat > "$PROJ/hostgator-setup-kit/backup.sh" <<STUB
#!/usr/bin/env bash
touch "$BACKUP_MARK"
STUB
# shellcheck disable=SC2016  # o ${APP_IMAGE} é literal DENTRO do compose
printf 'services:\n  app:\n    image: \${APP_IMAGE:-x}\n' > "$PROJ/docker-compose.prod.yml"
printf 'select 1;\n' > "$PROJ/supabase/baseline.sql"
cat > "$PROJ/.env" <<ENV
APP_IMAGE=ghcr.io/melgarafael/deskcommcrm:latest
APP_PULL_POLICY=always
SUPABASE_DB_URL=postgresql://x/y
NEXT_PUBLIC_APP_URL=https://crm.exemplo.com.br
INTERNAL_SECRET=segredo
NUVEMSHOP_OAUTH_ENCRYPTION_KEY=chave
ENV
chmod 600 "$PROJ/.env"

cd "$PROJ" || exit 1
git init --quiet
git config user.email t@t.t; git config user.name t
git add -A
git commit --quiet -m "v0.9.0"
git tag v0.9.0
# Instalação que SEGUE A MAIN: HEAD à frente da última tag publicada.
echo topo > topo.txt; git add -A; git commit --quiet -m "topo da main"

OUTFILE="$WORK/saida.txt"
run_update() {  # run_update <args...> → saída em $OUTFILE, status em $RC
  rm -f "$BACKUP_MARK"
  bash hostgator-setup-kit/update.sh "$@" > "$OUTFILE" 2>&1
  RC=$?
}

echo "── 1. Alvo anterior ao instalado é recusado antes do backup"
run_update --to v0.9.0
check "aborta com status != 0" test "$RC" -ne 0
check "explica em português que é retrocesso" grep -q "ANTERIOR à que já está instalada" "$OUTFILE"
check "não chegou a rodar o backup" test ! -f "$BACKUP_MARK"

echo "── 2. Sem --to, a última tag publicada também é recusada se já está no HEAD"
# É o caso do defeito: o dono copia da tela o comando sem argumento nenhum.
run_update
check "aborta com status != 0" test "$RC" -ne 0
check "não chegou a rodar o backup" test ! -f "$BACKUP_MARK"
check "mesmo recusando, deixou o agente da tela instalado (com cd no diretório do projeto)" \
  grep -q "cd ${PROJ} && bash hostgator-setup-kit/agent.sh" "$FAKE_CRONTAB"

echo "── 3. --force é a saída explícita de quem quer mesmo voltar"
run_update --to v0.9.0 --force
check "passou da guarda e rodou o backup" test -f "$BACKUP_MARK"

echo "── 4. Atualização de verdade grava a imagem no .env, sem duplicar a chave"
# Estado de quem sofreu um rollback antes: o agente deixou a imagem apontando
# para um ID local e a política em "missing" (ID não se puxa do registro).
set_env_missing() { grep -v '^APP_PULL_POLICY=' .env > .env.t; echo 'APP_PULL_POLICY=missing' >> .env.t; mv .env.t .env; }
set_env_missing
git checkout --quiet main 2>/dev/null || git checkout --quiet master
echo nova > nova.txt; git add -A; git commit --quiet -m "v1.1.0"; git tag v1.1.0
git checkout --quiet v0.9.0
run_update --to v1.1.0
check "a atualização termina com sucesso" test "$RC" -eq 0
check ".env aponta para a imagem da versão instalada" grep -q '^APP_IMAGE=ghcr.io/melgarafael/deskcommcrm:1.1.0$' .env
check "a chave APP_IMAGE não duplicou" test "$(grep -c '^APP_IMAGE=' .env)" -eq 1
run_update --to v1.1.0 --force
check "segunda execução também não duplica" test "$(grep -c '^APP_IMAGE=' .env)" -eq 1
check "as outras chaves do .env sobreviveram" grep -q '^INTERNAL_SECRET=segredo$' .env
check "a política de pull volta a 'always' (senão o up -d do dono nunca mais puxa imagem)" \
  grep -q '^APP_PULL_POLICY=always$' .env
check "e sem duplicar a chave" test "$(grep -c '^APP_PULL_POLICY=' .env)" -eq 1
check ".env continua 600 (só o dono lê)" test -n "$(find .env -perm 600)"

# ── Clone RASO: a topologia que o install.sh realmente entrega ───────────────
# `install.sh` instala com `git clone --depth 1`. Num repositório raso o
# `merge-base --is-ancestor` responde "não é ancestral" para QUALQUER coisa
# fora do único commit baixado — inclusive para uma tag velha. Era o furo que
# mantinha o retrocesso vivo mesmo com a guarda: o fixture acima (git init
# completo) não tinha como pegar.
SRC="$WORK/src"
mkdir -p "$SRC"
cp -R "$PROJ/hostgator-setup-kit" "$SRC/"
mkdir -p "$SRC/supabase"; printf 'select 1;\n' > "$SRC/supabase/baseline.sql"
# shellcheck disable=SC2016  # o ${APP_IMAGE} é literal DENTRO do compose
printf 'services:\n  app:\n    image: \${APP_IMAGE:-x}\n' > "$SRC/docker-compose.prod.yml"
printf '.env\n' > "$SRC/.gitignore"
cd "$SRC" || exit 1
git init --quiet; git config user.email t@t.t; git config user.name t
git add -A; git commit --quiet -m "release antiga"; git tag v0.9.0
echo topo > topo.txt; git add -A; git commit --quiet -m "main, depois da release"

clona_raso() {  # clona_raso <destino> — igual ao install.sh: --depth 1
  git clone --depth 1 --quiet "file://$SRC" "$1"
  cat > "$1/.env" <<ENV
APP_IMAGE=ghcr.io/melgarafael/deskcommcrm:latest
APP_PULL_POLICY=always
SUPABASE_DB_URL=postgresql://x/y
NEXT_PUBLIC_APP_URL=https://crm.exemplo.com.br
INTERNAL_SECRET=segredo
NUVEMSHOP_OAUTH_ENCRYPTION_KEY=chave
ENV
  chmod 600 "$1/.env"
}

echo "── 5. Clone raso (o do install.sh): a tag velha continua sendo recusada"
RASO="$WORK/raso"
clona_raso "$RASO"
cd "$RASO" || exit 1
check "o fixture é mesmo um clone raso (senão esta prova não vale nada)" \
  test "$(git rev-parse --is-shallow-repository)" = "true"
HEAD_ANTES="$(git rev-parse HEAD)"
run_update
check "aborta com o código de recusa (3), não com falha genérica" test "$RC" -eq 3
check "explica em português que é retrocesso" grep -q "ANTERIOR à que já está instalada" "$OUTFILE"
check "não chegou a rodar o backup" test ! -f "$BACKUP_MARK"
check "NÃO rebobinou: o HEAD é o mesmo de antes" test "$(git rev-parse HEAD)" = "$HEAD_ANTES"
check "a imagem do .env continua intacta" grep -q '^APP_IMAGE=ghcr.io/melgarafael/deskcommcrm:latest$' .env
check "completou a história para poder decidir (deixou de ser raso)" \
  test "$(git rev-parse --is-shallow-repository)" = "false"

echo "── 6. Clone raso que NÃO consegue completar a história: recusa em vez de chutar"
CEGO="$WORK/cego"
clona_raso "$CEGO"
cd "$CEGO" || exit 1
git fetch --tags --quiet origin            # conhece a tag…
git remote set-url origin "$WORK/nao-existe"  # …mas perdeu o caminho de volta
HEAD_ANTES="$(git rev-parse HEAD)"
run_update
check "aborta com o código de recusa (3)" test "$RC" -eq 3
check "diz que não teve CERTEZA, em vez de agir" grep -q "consegui ter CERTEZA" "$OUTFILE"
check "não chegou a rodar o backup" test ! -f "$BACKUP_MARK"
check "NÃO rebobinou: o HEAD é o mesmo de antes" test "$(git rev-parse HEAD)" = "$HEAD_ANTES"

echo "── 7. Recusa não é falha no meio: o agente não desfaz o que nunca foi feito"
# O update.sh recusa (RC=3) e o agent.sh, antes, tratava qualquer RC!=0 como
# "quebrou": reiniciava o container, reescrevia o .env e reportava
# "failed_rolled_back" — estrago inventado, para um run que não tocou em nada.
AGENTE="$WORK/agente"
clona_raso "$AGENTE"
cd "$AGENTE" || exit 1
: > "$DOCKER_LOG"; : > "$CURL_LOG"; rm -f "$BACKUP_MARK"
bash hostgator-setup-kit/agent.sh > "$WORK/agente.out" 2>&1
check "o agente chegou a executar o update (o app de mentira pediu)" \
  grep -q '"kind":"run_progress"\|"kind":"run_result"' "$CURL_LOG"
check "NÃO reiniciou o container" test -z "$(grep -F 'up -d app' "$DOCKER_LOG" || true)"
check "NÃO reescreveu a imagem do .env" grep -q '^APP_IMAGE=ghcr.io/melgarafael/deskcommcrm:latest$' .env
check "reportou 'failed', não 'failed_rolled_back'" \
  test -n "$(grep -F '"status":"failed"' "$CURL_LOG" || true)"
check "não reportou rollback nenhum" test -z "$(grep -F 'failed_rolled_back' "$CURL_LOG" || true)"
check "o motivo em português chegou no log que a tela mostra" \
  grep -qi 'anterior' "$CURL_LOG"

echo "── 8. Instalação atrasada que não deu pra comparar: o agente diz que NÃO SABE"
# Fixture do defeito: instalação numa release antiga (v0.9.0), com a v1.1.0
# genuinamente mais nova conhecida localmente, num clone raso que não consegue
# completar a história. Se o agente só omitir a tag, o app lê o silêncio como
# "está em dia" e a instalação nunca fica sabendo da atualização.
echo mid > "$SRC/mid.txt"; git -C "$SRC" add -A; git -C "$SRC" commit --quiet -m "depois da 0.9.0"
echo nova > "$SRC/nova.txt"; git -C "$SRC" add -A; git -C "$SRC" commit --quiet -m "release nova"
git -C "$SRC" tag v1.1.0
ATRASADO="$WORK/atrasado"
git -c advice.detachedHead=false clone --depth 1 --branch v0.9.0 --quiet "file://$SRC" "$ATRASADO"
cp "$RASO/.env" "$ATRASADO/.env"; chmod 600 "$ATRASADO/.env"
cd "$ATRASADO" || exit 1
git fetch --tags --quiet origin                # conhece a v1.1.0…
git remote set-url origin "$WORK/nao-existe"   # …mas não consegue completar a história
: > "$CURL_LOG"
bash hostgator-setup-kit/agent.sh > "$WORK/agente2.out" 2>&1
check "o heartbeat diz explicitamente que não conseguiu comparar" \
  grep -q '"compare_failed":true' "$CURL_LOG"
check "e não anuncia versão nenhuma (seria oferecer o que o update.sh recusa)" \
  grep -q '"latest_version":""' "$CURL_LOG"

echo
if [ "$FAILS" -eq 0 ]; then echo "OK — todas as provas passaram."; else echo "FALHOU — $FAILS prova(s)."; fi
exit $((FAILS > 0))
