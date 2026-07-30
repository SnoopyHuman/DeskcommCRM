#!/usr/bin/env bash
# Atualiza o DeskcommCRM na VPS: código novo + banco + app — com BACKUP antes e
# CHECAGEM DE SAÚDE depois. Um comando só, pensado pra quem não é técnico:
#
#   bash hostgator-setup-kit/update.sh
#
# Flags:
#   --force        atualiza mesmo se o git disser que já está na última versão
#   --skip-backup  pula o backup automático (não recomendado)
source "$(dirname "$0")/_common.sh"
enter_project

FORCE=""; SKIP_BACKUP=""
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    --skip-backup) SKIP_BACKUP=1 ;;
  esac
done

# ── 1. Tem atualização mesmo? ────────────────────────────────────────────────
step "Procurando atualizações"
git fetch --quiet origin 2>/dev/null || c_ylw "⚠ não consegui falar com o GitHub — sigo com o código que já está aqui."
LOCAL="$(git rev-parse HEAD 2>/dev/null || echo '?')"
REMOTE="$(git rev-parse '@{u}' 2>/dev/null || git rev-parse origin/main 2>/dev/null || echo '?')"
# O código estar em dia NÃO significa que o app está: quem roda é a imagem.
# Uma atualização interrompida depois do `git pull` (queda de rede, falta de
# memória no meio do docker pull) deixa o repositório novo e a imagem velha — e
# a partir dali TODO update.sh respondia "já está na versão mais recente",
# prendendo o CRM na versão antiga sem nenhuma saída visível para o dono.
# Também cobre imagem republicada sem commit novo (rebuild de segurança).
image_desatualizada() {
  local img="${APP_IMAGE:-ghcr.io/melgarafael/deskcommcrm:latest}" local_d remote_d
  local_d="$(docker image inspect "$img" --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' 2>/dev/null | sed 's/.*@//')"
  [ -z "$local_d" ] && return 0                 # nem baixada ainda → atualizar
  remote_d="$(docker buildx imagetools inspect "$img" 2>/dev/null | awk '/^Digest:/{print $2; exit}')"
  [ -z "$remote_d" ] && return 1                # sem como consultar → não forçar
  [ "$local_d" != "$remote_d" ]
}

if [ "$LOCAL" = "$REMOTE" ] && [ -z "$FORCE" ] && ! image_desatualizada; then
  c_grn "✓ Você já está na versão mais recente. Nada a atualizar."
  exit 0
fi
if [ "$LOCAL" != "$REMOTE" ]; then
  c_ylw "Há uma versão nova. Vou atualizar com segurança."
else
  c_ylw "O código já está em dia, mas o app está rodando uma imagem antiga. Vou atualizar a imagem."
fi

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

# ── 3. Código novo ───────────────────────────────────────────────────────────
step "Baixando o código novo"
if ! git pull --ff-only 2>&1; then
  die "Não consegui atualizar o código automaticamente (parece haver mudanças locais que divergem).
     Rode 'git status' pra ver, ou peça ajuda. NÃO mexi no banco — está tudo como estava."
fi

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

# ── 5. App novo ──────────────────────────────────────────────────────────────
step "Baixando a versão nova do app e reiniciando"
docker compose -f "$COMPOSE" pull
docker compose -f "$COMPOSE" up -d

# O Caddyfile entra no container por bind mount de UM ARQUIVO, e bind mount de
# arquivo fica preso ao inode. O `git pull` não edita o arquivo: escreve outro e
# renomeia, gerando inode novo — o container continua lendo o antigo, para
# sempre. Medido nesta VPS: host inode 3283869, container 3271833, com o
# conteúdo velho lá dentro.
#
# Sem este force-recreate, TODA mudança de proxy enviada numa atualização
# (inclusive correção de segurança na borda) some em silêncio: o update diz
# "concluída" e a configuração antiga segue valendo.
docker compose -f "$COMPOSE" up -d --force-recreate --no-deps caddy >/dev/null 2>&1 \
  && c_grn "✓ proxy recarregado com a configuração desta versão" \
  || c_ylw "⚠ não consegui recriar o proxy — rode: docker compose -f $COMPOSE up -d --force-recreate caddy"

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
  c_ylw "⚠ Atualizei, mas o app ainda não respondeu 'ok'. Veja os logs:"
  c_ylw "  docker compose -f $COMPOSE logs --tail=50 app"
fi

# ── 7. Automações (cron do drain de eventos) ─────────────────────────────────
step "Conferindo as automações"
ensure_encryption_key .env
setup_event_log_drain_cron
