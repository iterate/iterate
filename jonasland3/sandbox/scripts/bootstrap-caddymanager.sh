#!/bin/sh
set -eu

BASE_URL="${CADDYMANAGER_BOOTSTRAP_BASE_URL:-http://127.0.0.1:8501}"
USERNAME="${CADDYMANAGER_BOOTSTRAP_USER:-admin}"
PASSWORD="${CADDYMANAGER_BOOTSTRAP_PASS:-caddyrocks}"

login_payload=$(printf '{"username":"%s","password":"%s"}' "$USERNAME" "$PASSWORD")
token="$(
  curl -fsS -X POST "${BASE_URL}/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -d "$login_payload" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);process.stdout.write(j.token||"")}catch{process.stdout.write("")}})'
)"

if [ -z "$token" ]; then
  echo "caddymanager bootstrap: unable to login, skipping seed"
  exit 0
fi

server_count="$(
  curl -fsS "${BASE_URL}/api/v1/caddy/servers" \
    -H "Authorization: Bearer ${token}" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);process.stdout.write(String(j.count ?? 0))}catch{process.stdout.write("0")}})'
)"

if [ "${server_count}" != "0" ]; then
  echo "caddymanager bootstrap: servers already exist, skipping seed"
  exit 0
fi

create_payload='{"name":"local-caddy","apiUrl":"http://127.0.0.1","apiPort":2019,"adminApiPath":"/config/","active":true,"pullExistingConfig":true}'
curl -fsS -X POST "${BASE_URL}/api/v1/caddy/servers" \
  -H "Authorization: Bearer ${token}" \
  -H "Content-Type: application/json" \
  -d "${create_payload}" >/dev/null

echo "caddymanager bootstrap: seeded local-caddy server"
