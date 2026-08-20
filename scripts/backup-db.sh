#!/usr/bin/env bash
# Backup do Postgres (Supabase) do DeskcommCRM — schema public completo
# (CRM + harness do agente). Roda no host ou num cron da VPS:
#   0 3 * * * /path/repo/scripts/backup-db.sh /var/backups/deskcomm
# Requer: pg_dump no PATH (major compatível) e SUPABASE_DB_ADMIN_URL ou
# SUPABASE_DB_URL no ambiente ou no .env.kit/.env.local/.env.
set -euo pipefail

DIR="${1:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Lê UMA chave do .env.kit/.env.local/.env, tirando as aspas que o `envq` do kit
# escreve — sem isso a string chega ao pg_dump com dois caracteres a mais e a
# conexão é recusada, justamente na instalação de VPS que este cron atende.
# `.env.kit` primeiro: é o arquivo que o kit lê e o compose NÃO entrega aos
# contêineres (hostgator-setup-kit/_common.sh → enter_project).
ler_do_env() {
  local chave="$1" f v
  for f in "$ROOT/.env.kit" "$ROOT/.env.local" "$ROOT/.env"; do
    [ -f "$f" ] || continue
    v="$(grep -E "^${chave}=" "$f" | head -1 | cut -d= -f2- || true)"
    case "$v" in \"*\"|\'*\') v="${v:1:${#v}-2}" ;; esac
    [ -n "$v" ] && { printf '%s' "$v"; return 0; }
  done
  return 0
}

# ── Qual conexão dumpar: a do DONO quando existe ─────────────────────────────
# `pg_dump` despeja só o que a role ENXERGA. Com a role menor do app — a que
# `docs/deploy-selfhost/README.md` §2 manda pôr em SUPABASE_DB_URL quando o
# Postgres é próprio — o dump sai PARCIAL e sai VERDE. Falha silenciosa de
# backup é a pior das falhas: ela só aparece na hora de restaurar. É a mesma
# resolução de `url_do_schema` (hostgator-setup-kit/_common.sh): a do dono
# quando declarada, a de sempre quando não — então quem já tem este cron
# rodando, e não declarou nada, não muda de comportamento.
URL="${SUPABASE_DB_ADMIN_URL:-}"
[ -n "$URL" ] || URL="$(ler_do_env SUPABASE_DB_ADMIN_URL)"
[ -n "$URL" ] || URL="${SUPABASE_DB_URL:-}"
[ -n "$URL" ] || URL="$(ler_do_env SUPABASE_DB_URL)"
[ -n "$URL" ] || { echo "FATAL: nem SUPABASE_DB_ADMIN_URL nem SUPABASE_DB_URL (env ou .env.kit/.env.local/.env)" >&2; exit 1; }

mkdir -p "$DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$DIR/deskcomm-$STAMP.dump"
pg_dump "$URL" --format=custom --schema=public --no-owner --no-privileges --file="$OUT"
echo "backup ok: $OUT ($(du -h "$OUT" | cut -f1))"

# retenção: apaga dumps mais velhos que RETENTION_DAYS
find "$DIR" -name 'deskcomm-*.dump' -mtime +"$RETENTION_DAYS" -delete
echo "retenção aplicada (${RETENTION_DAYS}d)"
