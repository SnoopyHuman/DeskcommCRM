#!/usr/bin/env bash
# Atualiza o DeskcommCRM na VPS: código novo + banco + app — com BACKUP antes e
# CHECAGEM DE SAÚDE depois. Um comando só, pensado pra quem não é técnico:
#
#   bash hostgator-setup-kit/update.sh
#
# Flags:
#   --force        atualiza mesmo se o git disser que já está na última versão
#   --skip-backup  pula o backup automático (não recomendado)
#   --to <tag>     instala essa tag em vez da mais recente publicada
source "$(dirname "$0")/_common.sh"
enter_project

FORCE=""; SKIP_BACKUP=""; TARGET_TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --skip-backup) SKIP_BACKUP=1 ;;
    --to) shift; TARGET_TAG="$1" ;;
  esac
  shift
done

# ── 1. Tem atualização mesmo? ────────────────────────────────────────────────
step "Procurando atualizações"
git fetch --tags --quiet origin 2>/dev/null || c_ylw "⚠ não consegui falar com o GitHub — sigo com o código que já está aqui."
[ -n "$TARGET_TAG" ] || TARGET_TAG="$(git tag -l 'v*' --sort=-v:refname | head -1)"
[ -n "$TARGET_TAG" ] || die "Não encontrei nenhuma versão publicada para instalar."
CURRENT_TAG="$(git describe --tags --exact-match HEAD 2>/dev/null || true)"
if [ "$CURRENT_TAG" = "$TARGET_TAG" ] && [ -z "$FORCE" ]; then
  c_grn "✓ Você já está na versão mais recente ($TARGET_TAG). Nada a atualizar."
  exit 0
fi
c_ylw "Vou atualizar para a versão $TARGET_TAG com segurança."

# ── 2. Backup de segurança ANTES de tocar no banco ───────────────────────────
if [ -z "$SKIP_BACKUP" ]; then
  step "Backup de segurança (antes de mexer no banco)"
  if bash "$(dirname "$0")/backup.sh"; then
    c_grn "✓ backup feito — se algo der errado, dá pra restaurar (restore.sh)."
  else
    c_ylw "⚠ o backup falhou. A atualização NÃO apaga dados (só reorganiza os contatos),"
    c_ylw "  mas o ideal é ter backup. Ctrl+C pra parar e investigar; continuo em 8s…"
    sleep 8
  fi
fi
# Avisa o agente do host (se for ele quem está dirigindo) — é o que faz a tela
# de atualização avançar passo a passo enquanto o app ainda está de pé.
[ -n "${DESKCOMM_AGENT_REPORT:-}" ] && eval "${DESKCOMM_AGENT_REPORT_CMD}" backup

# ── 3. Código novo ───────────────────────────────────────────────────────────
step "Baixando o código novo"
if ! git checkout --quiet "$TARGET_TAG" 2>&1; then
  die "Não consegui trocar para a versão $TARGET_TAG (parece haver mudanças locais que divergem).
     Rode 'git status' pra ver, ou peça ajuda. NÃO mexi no banco — está tudo como estava."
fi
[ -n "${DESKCOMM_AGENT_REPORT:-}" ] && eval "${DESKCOMM_AGENT_REPORT_CMD}" codigo

# ── 4. Banco: schema + correções de dados (schema ANTES do app) ──────────────
# O baseline é idempotente e auto-curativo. Re-aplicar numa base que JÁ existe
# gera erros do tipo "já existe" / "multiple primary keys" — isso é ESPERADO e
# inofensivo (são objetos que já estavam lá). Filtramos esse ruído e só
# mostramos problemas de verdade.
step "Atualizando o banco de dados"
if [ -f supabase/baseline.sql ]; then
  # Extensões que o schema exige (idempotente; iguais ao install.sh).
  docker run --rm postgres:17-alpine psql "$SUPABASE_DB_URL" -c \
    "create extension if not exists vector with schema public; create extension if not exists citext with schema public; create extension if not exists pg_trgm with schema public;" \
    >/dev/null 2>&1 || true

  raw="$(docker run --rm -i -v "$PROJECT_DIR/supabase/baseline.sql:/b.sql:ro" \
        postgres:17-alpine psql "$SUPABASE_DB_URL" -f /b.sql 2>&1 || true)"

  # Erros benignos ao re-aplicar sobre uma base existente:
  benign='already exists|multiple primary keys|multiple default values|is already a member|already a partition'
  unexpected="$(printf '%s\n' "$raw" | grep -iE 'ERROR|FATAL' | grep -viE "$benign" || true)"

  if [ -n "$unexpected" ]; then
    c_ylw "⚠ Apareceram avisos no banco que NÃO são os esperados:"
    printf '%s\n' "$unexpected" | head -20
    c_ylw "  O app pode ainda funcionar. Se algo estiver errado, restaure o backup (restore.sh)."
  else
    c_grn "✓ banco atualizado (e conversas reorganizadas, se havia bagunça)."
  fi
else
  c_ylw "⚠ supabase/baseline.sql não encontrado — pulei a parte do banco."
fi
[ -n "${DESKCOMM_AGENT_REPORT:-}" ] && eval "${DESKCOMM_AGENT_REPORT_CMD}" banco

# ── 5. App novo ──────────────────────────────────────────────────────────────
step "Baixando a versão nova do app e reiniciando"
# Imagem da TAG publicada (não "latest" solto): garante que o código (checkout
# acima) e a imagem do container sejam sempre da mesma versão.
export APP_IMAGE="ghcr.io/melgarafael/deskcommcrm:${TARGET_TAG#v}"
docker compose -f "$COMPOSE" pull
docker compose -f "$COMPOSE" up -d

# ── 6. O app voltou no ar? ───────────────────────────────────────────────────
step "Conferindo se o app voltou no ar"
ok=""
for _ in $(seq 1 20); do
  out="$(docker compose -f "$COMPOSE" exec -T app node -e \
    "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>r.text()).then(t=>{console.log(t);process.exit(0)}).catch(()=>process.exit(1))" \
    2>/dev/null || echo '')"
  printf '%s' "$out" | grep -q '"status":"ok"' && { ok=1; break; }
  sleep 3
done
if [ -n "$ok" ]; then
  c_grn "✓ Atualização concluída — app no ar e saudável."
else
  c_ylw "⚠ Atualizei, mas o app não respondeu 'ok'. Veja os logs:"
  c_ylw "  docker compose -f $COMPOSE logs --tail=50 app"
  # Código de saída != 0: é o que o agent.sh usa pra saber que precisa voltar
  # pra imagem anterior (guardada por ele ANTES do pull). Sem isso, não existe
  # rede de proteção — o app novo, quebrado, ficaria no ar sem ninguém saber.
  exit 1
fi

# ── 7. Automações (cron do drain de eventos + agente de atualização) ────────
step "Conferindo as automações"
ensure_encryption_key .env
setup_event_log_drain_cron
setup_update_agent_cron
