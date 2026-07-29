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
# Healthcheck do update.sh: "docker compose ... exec -T app node -e ..."
case " $* " in
  *" exec "*) printf '{"status":"ok"}\n' ;;
esac
exit 0
STUB
cat > "$WORK/bin/crontab" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = "-l" ] && { [ -f "$FAKE_CRONTAB" ] && cat "$FAKE_CRONTAB"; exit 0; }
[ "${1:-}" = "-" ] && { cat > "$FAKE_CRONTAB"; exit 0; }
exit 0
STUB
chmod +x "$WORK/bin/docker" "$WORK/bin/crontab"
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
check ".env continua 600 (só o dono lê)" test -n "$(find .env -perm 600)"

echo
if [ "$FAILS" -eq 0 ]; then echo "OK — todas as provas passaram."; else echo "FALHOU — $FAILS prova(s)."; fi
exit $((FAILS > 0))
