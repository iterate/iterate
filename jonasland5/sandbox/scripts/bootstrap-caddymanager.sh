#!/bin/sh
set -eu

BASE_URL="${CADDYMANAGER_BOOTSTRAP_BASE_URL:-http://127.0.0.1:8501}"
USERNAME="${CADDYMANAGER_BOOTSTRAP_USER:-admin}"
PASSWORD="${CADDYMANAGER_BOOTSTRAP_PASS:-caddyrocks}"
TARGET_SERVER_NAME="${CADDYMANAGER_TARGET_SERVER_NAME:-local-caddy}"
TARGET_API_URL="${CADDYMANAGER_TARGET_API_URL:-http://127.0.0.1}"
TARGET_API_PORT="${CADDYMANAGER_TARGET_API_PORT:-2019}"
TARGET_ADMIN_API_PATH="${CADDYMANAGER_TARGET_ADMIN_API_PATH:-/config/}"
MAX_ATTEMPTS="${CADDYMANAGER_BOOTSTRAP_MAX_ATTEMPTS:-120}"
SLEEP_SECONDS="${CADDYMANAGER_BOOTSTRAP_SLEEP_SECONDS:-1}"
export TARGET_SERVER_NAME

json_value() {
  node -e "const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));const v=(()=>{${1}})();process.stdout.write(v===undefined||v===null?'':String(v));"
}

auth_token=""
attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  login_payload=$(printf '{"username":"%s","password":"%s"}' "$USERNAME" "$PASSWORD")
  login_response="$(curl -fsS -X POST "${BASE_URL}/api/v1/auth/login" -H "Content-Type: application/json" -d "$login_payload" || true)"
  auth_token="$(printf '%s' "$login_response" | json_value 'return p.token;' || true)"
  if [ -n "$auth_token" ]; then
    break
  fi
  attempt=$((attempt + 1))
  sleep "$SLEEP_SECONDS"
done

if [ -z "$auth_token" ]; then
  echo "caddymanager bootstrap: failed to login after ${MAX_ATTEMPTS} attempts"
  exit 1
fi

servers_response="$(curl -fsS "${BASE_URL}/api/v1/caddy/servers" -H "Authorization: Bearer ${auth_token}")"
server_id="$(
  printf '%s' "$servers_response" \
    | json_value 'const m=(p.data||[]).find((s)=>s && s.name===process.env.TARGET_SERVER_NAME);return m && (m.id||m._id);'
)"

if [ -z "$server_id" ]; then
  create_payload="$(printf '{"name":"%s","apiUrl":"%s","apiPort":%s,"adminApiPath":"%s","active":true,"pullExistingConfig":true}' \
    "$TARGET_SERVER_NAME" \
    "$TARGET_API_URL" \
    "$TARGET_API_PORT" \
    "$TARGET_ADMIN_API_PATH")"
  curl -fsS -X POST "${BASE_URL}/api/v1/caddy/servers" \
    -H "Authorization: Bearer ${auth_token}" \
    -H "Content-Type: application/json" \
    -d "${create_payload}" >/dev/null

  servers_response="$(curl -fsS "${BASE_URL}/api/v1/caddy/servers" -H "Authorization: Bearer ${auth_token}")"
  server_id="$(
    printf '%s' "$servers_response" \
      | json_value 'const m=(p.data||[]).find((s)=>s && s.name===process.env.TARGET_SERVER_NAME);return m && (m.id||m._id);'
  )"
fi

if [ -z "$server_id" ]; then
  echo "caddymanager bootstrap: failed to create/find target server ${TARGET_SERVER_NAME}"
  exit 1
fi

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  server_configs_response="$(curl -fsS "${BASE_URL}/api/v1/caddy/servers/${server_id}/configs" -H "Authorization: Bearer ${auth_token}" || true)"
  server_config_count="$(printf '%s' "$server_configs_response" | json_value 'return p.count ?? 0;' || true)"
  if [ "${server_config_count:-0}" -gt 0 ]; then
    break
  fi

  curl -fsS "${BASE_URL}/api/v1/caddy/servers/${server_id}/current-config?name=${TARGET_SERVER_NAME}-initial&description=Auto%20bootstrap&setAsActive=true" \
    -H "Authorization: Bearer ${auth_token}" >/dev/null || true

  attempt=$((attempt + 1))
  sleep "$SLEEP_SECONDS"
done

server_configs_response="$(curl -fsS "${BASE_URL}/api/v1/caddy/servers/${server_id}/configs" -H "Authorization: Bearer ${auth_token}")"
server_config_count="$(printf '%s' "$server_configs_response" | json_value 'return p.count ?? 0;')"
if [ "${server_config_count}" -le 0 ]; then
  echo "caddymanager bootstrap: no configs for server ${TARGET_SERVER_NAME}"
  exit 1
fi

echo "caddymanager bootstrap: server=${TARGET_SERVER_NAME} id=${server_id} configs=${server_config_count}"
