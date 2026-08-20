#!/usr/bin/env bash
#
# Sobe (ou derruba) os serviços externos da jornada de instalação FRESCA — o
# rig de `tests/e2e/vps-fresh-onboarding.spec.ts`.
#
#   bash scripts/e2e-rig-fresco.sh up     # sobe e ESPERA ficar pronto
#   bash scripts/e2e-rig-fresco.sh down   # derruba e apaga os volumes
#
# ═══ A FIAÇÃO SAI DO `.env.e2e`, NUNCA DAQUI ═══
#
# Porta do WAHA, porta do Redis-HTTP, chave de API e token são LIDOS do
# `.env.e2e` — o mesmo arquivo que o app sob teste carrega. Redigitar qualquer
# um deles neste script criaria a terceira redação do mesmo segredo, e as duas
# anteriores já divergiram: `INTERNAL_SECRET` valia uma coisa no servidor e
# outra no processo de teste, e o sintoma foram 8 specs em 401 (ver o passo
# "Publicar o .env.e2e" em .github/workflows/e2e.yml).
#
# Consequência prática: mudar a porta do WAHA em `scripts/gerar-env-e2e.sh`
# move o contêiner junto, sem tocar em mais nada.
set -euo pipefail

cd "$(dirname "$0")/.."

ACAO="${1:-up}"
ARQ_ENV=".env.e2e"
PROJETO="deskcomm-e2e-fresco"
COMPOSE=(docker compose -p "$PROJETO" -f docker-compose.e2e.yml)

if [ ! -f "$ARQ_ENV" ]; then
  echo "==> Falta o $ARQ_ENV — rode 'pnpm e2e:env' (precisa do Supabase local de pé)." >&2
  exit 1
fi

# Lê UMA chave do .env.e2e. Não usa `source`: o arquivo é dado, não script — um
# valor com crase ou `$` viraria execução.
ler() { grep -E "^$1=" "$ARQ_ENV" | head -n1 | cut -d= -f2- ; }

# Porta publicada no host, extraída da própria URL que o app vai chamar. Se as
# duas divergissem, o app bateria numa porta onde não há nada e a spec
# reprovaria como se o produto estivesse quebrado.
porta_de() { printf '%s\n' "$1" | sed -E 's#^https?://[^:/]+:([0-9]+).*#\1#' ; }

sha512_de() {
  if command -v sha512sum >/dev/null 2>&1; then printf '%s' "$1" | sha512sum | cut -d' ' -f1
  else printf '%s' "$1" | shasum -a 512 | cut -d' ' -f1
  fi
}

E2E_WAHA_PORT="$(porta_de "$(ler WAHA_API_BASE_URL)")"
E2E_SRH_PORT="$(porta_de "$(ler UPSTASH_REDIS_REST_URL)")"
# O WAHA guarda o HASH e compara com o plaintext que o app manda em X-Api-Key.
# Derivar aqui é o que impede o par de sair de sincronia.
WAHA_API_KEY_SHA512="$(sha512_de "$(ler WAHA_API_KEY)")"
SRH_TOKEN="$(ler UPSTASH_REDIS_REST_TOKEN)"
WAHA_WEBHOOK_BASE_URL="$(ler WAHA_WEBHOOK_BASE_URL)"
# Nenhuma spec desta jornada recebe webhook do WAHA (J1 vai até o QR aparecer),
# mas o contêiner exige o segredo para subir. Valor fixo e público de propósito.
WAHA_HMAC_SECRET="e2e-rig-nao-e-segredo"
# O `docker-compose.prod.yml` inteiro é interpolado mesmo quando só três
# serviços dele são usados. Sem estas duas, o Compose avisa em toda invocação
# sobre variáveis do Caddy — que não sobe aqui.
DOMAIN="e2e.invalid"
ACME_EMAIL="e2e@invalid"
export E2E_WAHA_PORT E2E_SRH_PORT WAHA_API_KEY_SHA512 SRH_TOKEN \
       WAHA_WEBHOOK_BASE_URL WAHA_HMAC_SECRET DOMAIN ACME_EMAIL

for nome in E2E_WAHA_PORT E2E_SRH_PORT SRH_TOKEN; do
  if [ -z "${!nome}" ]; then
    echo "==> $ARQ_ENV não tem como derivar $nome — o gerador mudou de forma?" >&2
    exit 1
  fi
done

if [ "$ACAO" = "down" ]; then
  "${COMPOSE[@]}" down -v --remove-orphans
  exit 0
fi

# Quando a jornada reprova, a primeira pergunta é sempre "o transporte estava
# vivo?". Sem isto a resposta morre com o runner e a próxima sessão gasta um run
# inteiro adivinhando — que é exatamente o custo que o comentário do 429 de
# `olhar-telas-do-epico` documenta no e2e.yml.
if [ "$ACAO" = "logs" ]; then
  "${COMPOSE[@]}" ps
  "${COMPOSE[@]}" logs --tail 120
  exit 0
fi

if [ "$ACAO" != "up" ]; then
  echo "==> Ação desconhecida: $ACAO (use 'up', 'down' ou 'logs')." >&2
  exit 1
fi

echo "==> WAHA em :$E2E_WAHA_PORT · Redis-HTTP em :$E2E_SRH_PORT"
"${COMPOSE[@]}" up -d --wait --wait-timeout 300

# ⚠️ `--wait` NÃO PROVA QUE O `srh` ATENDE, e a armadilha é silenciosa.
#
# MEDIDO: `docker inspect …-srh-1 --format '{{json .Config.Healthcheck}}'`
# devolve `null` — a imagem pinada por digest não declara healthcheck nenhum, e
# o `--wait` do Compose trata contêiner SEM healthcheck como pronto assim que
# ele está *running*. O Compose imprime "Healthy" e isso não significa que
# alguém respondeu.
#
# Um `up` que devolve antes de o srh atender faz o primeiro `INCR` do limitador
# cair no fallback em memória — sem barulho, e o rig deixaria de exercitar o
# Redis que ele existe para exercitar.
#
# O probe é `POST /pipeline`, e não `GET /ping`: MEDIDO neste digest, o srh
# responde **404** a `/ping`, `/set/k/v` e `/get/k` ("SRH: Endpoint not found.
# SRH might not support this feature yet.") e **200** a
# `POST /pipeline [["PING"]]` → `[{"result":"PONG"}]`. É a forma que o
# `@upstash/redis` usa, então o probe exercita o mesmo caminho do produto.
for _ in $(seq 1 60); do
  codigo="$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST -H "Authorization: Bearer $SRH_TOKEN" \
    -H 'Content-Type: application/json' -d '[["PING"]]' \
    "http://127.0.0.1:$E2E_SRH_PORT/pipeline" || true)"
  [ "$codigo" = "200" ] && break
  sleep 2
done
if [ "${codigo:-}" != "200" ]; then
  echo "==> O Redis-HTTP não respondeu 200 em POST /pipeline (último: ${codigo:-sem resposta})." >&2
  "${COMPOSE[@]}" logs srh redis | tail -40 >&2
  exit 1
fi

echo "==> Rig pronto (WAHA + Redis + Redis-HTTP)."
