#!/usr/bin/env bash
#
# Testa os validadores do install.sh — as guardas que impedem alguém de avançar
# a instalação com um dado errado. Só casos que NÃO dependem de rede: formato,
# papel da chave, projeto cruzado, Direct-connection e senha não codificada.
# As checagens online (curl/psql) são provadas na instalação real.
#
#   bash hostgator-setup-kit/test-validators.sh
#
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

INSTALL_SH_LIB=1 . ./install.sh
set +e   # o install.sh liga `set -e`; aqui esperamos validadores falharem de propósito

fail=0
# ok <descrição> <pass|reject> <validador> <valor> [trecho esperado na mensagem]
#
# O trecho esperado não é firula: sem ele o teste passa por acaso. Provado —
# ao remover o guard da Direct connection, a URL seguia até o psql e era
# rejeitada por *falha de conexão*, com o teste ainda verde. Rejeição só conta
# quando é pelo motivo certo, e é a mensagem que diz o motivo à pessoa.
ok() {
  local desc="$1" expect="$2" fn="$3" val="${4-}" want="${5-}"
  local out rc
  if out="$("$fn" "$val" 2>&1)"; then rc=0; else rc=$?; fi
  if [ "$expect" = pass ]; then
    if [ $rc -eq 0 ]; then printf '  ✓ %s\n' "$desc"
    else printf '  ✗ %s  (esperava aceitar, rejeitou: %s)\n' "$desc" "$(printf '%s' "$out" | head -1)"; fail=1; fi
    return
  fi
  if [ $rc -eq 0 ]; then
    printf '  ✗ %s  (esperava rejeitar, aceitou)\n' "$desc"; fail=1; return
  fi
  if [ -n "$want" ] && ! printf '%s' "$out" | grep -qi -- "$want"; then
    printf '  ✗ %s  (rejeitou, mas pelo motivo errado)\n     esperava falar de: %s\n     disse: %s\n' \
      "$desc" "$want" "$(printf '%s' "$out" | head -1)"; fail=1; return
  fi
  printf '  ✓ %s\n' "$desc"
}

# A anon/service_role e a db_url comparam contra o projeto declarado.
NEXT_PUBLIC_SUPABASE_URL="https://abcdefghijklmnop.supabase.co"

# JWT falso: header.payload.assinatura, payload com role e ref.
mkjwt() {
  local payload; payload="$(printf '{"iss":"supabase","ref":"%s","role":"%s"}' "$2" "$1" \
    | base64 | tr -d '\n' | tr '+/' '-_' | tr -d '=')"
  printf 'eyJhbGciOiJIUzI1NiJ9.%s.assinatura' "$payload"
}

echo "domínio"
ok "aceita subdomínio"        pass   v_domain "crm.empresa.com.br"
ok "rejeita com https://"     reject v_domain "https://crm.empresa.com.br"  "sem https"
ok "rejeita com caminho"      reject v_domain "crm.empresa.com.br/app"      "sem barra"
ok "rejeita sem ponto"        reject v_domain "localhost"                   "falta o ponto"

echo "e-mail"
ok "aceita e-mail válido"     pass   v_email "voce@empresa.com.br"
ok "rejeita sem @"            reject v_email "voce.empresa.com.br"          "inválido"

echo "chaves do Supabase (formato/papel/projeto)"
ok "rejeita service_role no campo anon" reject v_anon    "$(mkjwt service_role abcdefghijklmnop)" "preciso da 'anon'"
ok "rejeita anon no campo service_role" reject v_service "$(mkjwt anon abcdefghijklmnop)"         "preciso da 'service_role'"
ok "rejeita chave de outro projeto"     reject v_anon    "$(mkjwt anon zzzzzzzzzzzzzzzz)"         "OUTRO projeto"
ok "rejeita texto que não é chave"      reject v_anon    "minha-chave-secreta"                    "não parece uma chave"

echo "connection string"
ok "rejeita [YOUR-PASSWORD] não trocado" reject v_db_url "postgresql://postgres.abcdefghijklmnop:[YOUR-PASSWORD]@aws-1-us-west-2.pooler.supabase.com:5432/postgres" "troque isso pela senha"
ok "rejeita Direct connection (IPv6)"    reject v_db_url "postgresql://postgres:senha@db.abcdefghijklmnop.supabase.co:5432/postgres"                                "Session pooler"
ok "rejeita string de outro projeto"     reject v_db_url "postgresql://postgres.zzzzzzzzzzzzzzzz:senha@aws-1-us-west-2.pooler.supabase.com:5432/postgres"          "mesmo projeto"
ok "rejeita o que não é URL de Postgres" reject v_db_url "aws-1-us-west-2.pooler.supabase.com"                                                                     "começa com postgresql"

echo "chaves de IA e senha"
ok "rejeita chave Anthropic com prefixo errado" reject v_anthropic "sk-proj-abc123" "começa com 'sk-ant-'"
ok "rejeita chave OpenAI com prefixo errado"    reject v_openai    "minha-chave"    "começa com 'sk-'"
ok "aceita OpenAI vazia (é opcional)"           pass   v_openai    ""
ok "rejeita senha curta"                        reject v_password  "1234567"        "muito curta"
ok "aceita senha de 8+"                         pass   v_password  "12345678"

echo "leitura do .env (load_env)"
. ./_common.sh
set +e
TMP="$(mktemp -d)"
cat > "$TMP/.env" <<'EOF'
# comentário deve ser ignorado
APP_NAME='Loja do João'
SENHA_COM_HASH='a#b'
SENHA_COM_CIFRAO='p$ass'
COM_ASPAS_DUPLAS="valor com espaço"
SEM_ASPAS=simples
LEGADO_SEM_ASPAS=Loja Antiga
linha sem igual
EOF
( load_env "$TMP/.env"
  eq() { if [ "$2" = "$3" ]; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s  esperava [%s] obteve [%s]\n' "$1" "$3" "$2"; exit 1; fi; }
  eq "nome com espaço"            "$APP_NAME"            "Loja do João"
  eq "senha com # não trunca"     "$SENHA_COM_HASH"      'a#b'
  eq "senha com \$ não expande"    "$SENHA_COM_CIFRAO"    'p$ass'
  eq "aspas duplas"               "$COM_ASPAS_DUPLAS"    "valor com espaço"
  eq "sem aspas"                  "$SEM_ASPAS"           "simples"
  eq "legado sem aspas c/ espaço" "$LEGADO_SEM_ASPAS"    "Loja Antiga"
) || fail=1
rm -rf "$TMP"

echo
if [ "$fail" = 0 ]; then echo "todos os validadores passaram"; else echo "FALHOU"; fi
exit "$fail"
