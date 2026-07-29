#!/usr/bin/env bash
# Agente de atualização: roda por cron a cada 5 minutos no HOST.
#
# Ele NÃO recebe comandos do app — recebe um booleano. Anuncia a versão
# instalada, lê na resposta se alguém clicou em "Atualizar agora" na tela e, se
# sim, roda o update.sh da tag publicada. É o que mantém o CRM em container sem
# nenhum acesso ao Docker do host.
source "$(dirname "$0")/_common.sh"
enter_project

SECRET="${INTERNAL_CRON_SECRET:-${INTERNAL_SECRET:-}}"
[ -n "$SECRET" ] || exit 0
[ -n "${NEXT_PUBLIC_APP_URL:-}" ] || exit 0

API="${NEXT_PUBLIC_APP_URL}/api/v1/system/agent"
LOCK="${PROJECT_DIR}/.update.lock"
LOG="${PROJECT_DIR}/.update.log"
# Log PERSISTENTE (append) de falha de comunicação com o app — distinto do
# .update.log acima, que é sobrescrito a cada corrida do update.sh. Um POST que
# falha em silêncio é o pior modo de falha desta feature (o sintoma vira "o
# botão não aparece" e ninguém sabe por quê); tudo que não for 2xx cai aqui.
ERRLOG="${PROJECT_DIR}/.update-agent.log"

post() {  # post <json> → corpo da resposta em 2xx; VAZIO em qualquer falha
  # (quem chama, ex. o laço de retry do run_result, usa "saiu vazio" como sinal
  # de falha — por isso o corpo só é impresso no ramo de sucesso). Falha
  # (não-2xx OU erro de rede) vai inteira, com timestamp, pro $ERRLOG.
  local out http_code body
  out="$(curl -sS -X POST "$API" \
    -H "Authorization: Bearer ${SECRET}" \
    -H 'Content-Type: application/json' \
    --max-time 20 -d "$1" \
    -w $'\n%{http_code}' 2>&1)"
  http_code="${out##*$'\n'}"
  body="${out%$'\n'*}"
  case "$http_code" in
    2[0-9][0-9])
      printf '%s' "$body"
      ;;
    *)
      # "|| true": com set -e (herdado do _common.sh), um erro aqui (disco
      # cheio, permissão) não pode derrubar o script — perder só o log é
      # melhor que abortar a atualização por causa do PRÓPRIO log de erro.
      printf '%s [agent] POST %s -> %s\n' "$(date -u +%FT%TZ)" "$API" "$out" >> "$ERRLOG" || true
      # mantém só as últimas ~200 linhas: falha persistente não deve encher o disco
      { tail -n 200 "$ERRLOG" > "${ERRLOG}.tmp" && mv "${ERRLOG}.tmp" "$ERRLOG"; } 2>/dev/null || true
      ;;
  esac
}

json_field() {  # json_field <corpo> <campo> — sem jq, que pode não existir no VPS
  printf '%s' "$1" | tr ',' '\n' | grep -o "\"$2\":[^,}]*" | head -1 | cut -d: -f2- | tr -d '" '
}

# ── 1. Que versão está instalada e qual é a última publicada? ────────────────
git fetch --tags --quiet origin 2>/dev/null || true

CURRENT_TAG="$(git describe --tags --exact-match HEAD 2>/dev/null || true)"
CURRENT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo '?')"
LATEST_TAG="$(git tag -l 'v*' --sort=-v:refname | head -1)"

if [ -n "$CURRENT_TAG" ]; then
  CURRENT="$CURRENT_TAG"; OFF_RELEASE=false
else
  CURRENT="$CURRENT_SHA";  OFF_RELEASE=true
fi

CHANGELOG=""
if [ -n "$LATEST_TAG" ] && [ "$LATEST_TAG" != "$CURRENT" ]; then
  # iconv -c: `head -c` corta em byte fixo, e o CHANGELOG tem emoji/acento
  # multi-byte (UTF-8) — um corte no meio de um caractere quebraria o JSON de
  # um jeito bem mais difícil de rastrear. -c descarta o byte incompleto do
  # final, sem depender de o corte cair "certo".
  CHANGELOG="$(git show "${LATEST_TAG}:CHANGELOG.md" 2>/dev/null \
    | head -c 60000 \
    | iconv -f UTF-8 -t UTF-8 -c 2>/dev/null || true)"
fi

# Escapa para JSON sem depender de jq: barra invertida, aspas, \r (CRLF vira
# LF), tab (viraria um caractere de controle cru dentro da string — JSON
# proíbe) e quebra de linha real (\n literal, via ORS do awk).
esc() {
  printf '%s' "$1" \
    | sed 's/\\/\\\\/g; s/"/\\"/g; s/\r//g' \
    | awk 'BEGIN{ORS="\\n"}{gsub(/\t/,"\\t"); print}'
}

BODY="{\"kind\":\"heartbeat\",\"current_version\":\"${CURRENT}\",\"current_sha\":\"${CURRENT_SHA}\",\"off_release\":${OFF_RELEASE},\"latest_version\":\"${LATEST_TAG}\",\"changelog\":\"$(esc "$CHANGELOG")\"}"
RESP="$(post "$BODY")"

[ "$(json_field "$RESP" update_requested)" = "true" ] || exit 0
RUN_ID="$(json_field "$RESP" run_id)"
[ -n "$RUN_ID" ] || exit 0

# ── 2. Alguém pediu. Uma atualização por vez. ────────────────────────────────
exec 9>"$LOCK"
flock -n 9 || exit 0

report() { post "{\"kind\":\"run_progress\",\"run_id\":\"${RUN_ID}\",\"step\":\"$1\"}" >/dev/null; }

# Guarda a imagem em execução ANTES de puxar a nova: é por onde a gente volta
# se o app novo não subir.
PREV_IMAGE="$(docker compose -f "$COMPOSE" images -q app 2>/dev/null | head -1)"

# update.sh roda num processo bash SEPARADO (via `bash arquivo`, não `source`).
# report() chama post(), que por sua vez lê $API/$SECRET/$ERRLOG, e o próprio
# corpo de report() referencia $RUN_ID — nada disso atravessa pro processo
# filho sem export explícito: sem isto, o report() "funciona" (não quebra a
# atualização) mas todo run_progress falha calado (achado rodando de verdade:
# 1ª tentativa deu "post: comando não encontrado"; corrigido isso, a 2ª deu
# 422 "Invalid UUID" — RUN_ID chegava vazio no filho). `declare -f` também
# precisa incluir post, não só report.
export API SECRET ERRLOG RUN_ID
set +e
DESKCOMM_AGENT_REPORT=1 \
DESKCOMM_AGENT_PREV_IMAGE="$PREV_IMAGE" \
DESKCOMM_AGENT_REPORT_CMD="$(declare -f post report); report" \
  bash "$(dirname "$0")/update.sh" --to "$LATEST_TAG" >"$LOG" 2>&1
RC=$?
set -e

# ── 3. O app voltou? Se não, volta a imagem anterior. ───────────────────────
STATUS="success"
if [ $RC -ne 0 ]; then
  STATUS="failed"
  if [ -n "$PREV_IMAGE" ]; then
    APP_IMAGE="$PREV_IMAGE" APP_PULL_POLICY=missing \
      docker compose -f "$COMPOSE" up -d app >>"$LOG" 2>&1 && STATUS="failed_rolled_back"
  fi
fi

TAIL="$(tail -40 "$LOG" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\r//g' | awk 'BEGIN{ORS="\\n"}{gsub(/\t/,"\\t"); print}')"

# O app acabou de reiniciar: insiste por ~2 min antes de desistir.
for _ in $(seq 1 12); do
  OUT="$(post "{\"kind\":\"run_result\",\"run_id\":\"${RUN_ID}\",\"status\":\"${STATUS}\",\"log_tail\":\"${TAIL}\"}")"
  [ -n "$OUT" ] && break
  sleep 10
done
