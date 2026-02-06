#!/usr/bin/env bash
set -euo pipefail

INIT_LOG="/tmp/sandbox-init.log"
TUNNEL_LOG="/tmp/sandbox-tunnel.log"
TUNNEL_URL_FILE="/tmp/sandbox-tunnel-url.txt"
SANDBOX_PORT="${SANDBOX_PORT:-8080}"
EGRESS_MITM_PORT="${EGRESS_MITM_PORT:-18080}"
EGRESS_VIEWER_PORT="${EGRESS_VIEWER_PORT:-18081}"
APP_DIR="/proof/sandbox"

log() {
  printf "%s %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$INIT_LOG"
}

retry() {
  local attempts="$1"
  shift
  local try=1
  local delay=2
  while true; do
    if "$@"; then
      return 0
    fi
    if [ "$try" -ge "$attempts" ]; then
      return 1
    fi
    sleep "$delay"
    try=$((try + 1))
    delay=$((delay * 2))
    if [ "$delay" -gt 20 ]; then delay=20; fi
  done
}

wait_for_tunnel_url() {
  local attempts
  for attempts in $(seq 1 120); do
    local tunnel_url
    tunnel_url="$(grep -Eo "https://[-a-z0-9]+\\.trycloudflare\\.com" "$TUNNEL_LOG" | head -n 1 || true)"
    if [ -n "$tunnel_url" ]; then
      printf "%s\n" "$tunnel_url" >"$TUNNEL_URL_FILE"
      log "sandbox_tunnel_url=$tunnel_url"
      return 0
    fi
    sleep 1
  done
  return 1
}

: >"$INIT_LOG"
log "START host=$(hostname) region=${PROOF_REGION:-unknown}"
log "EGRESS_PROXY_HOST=${EGRESS_PROXY_HOST:-unset}"

if [ -z "${EGRESS_PROXY_HOST:-}" ]; then
  log "ERROR missing EGRESS_PROXY_HOST"
  tail -f /dev/null
fi

EGRESS_CA_URL="${EGRESS_CA_URL:-http://${EGRESS_PROXY_HOST}:${EGRESS_VIEWER_PORT}/ca.crt}"
EGRESS_PROXY_URL="http://${EGRESS_PROXY_HOST}:${EGRESS_MITM_PORT}"

if ! command -v bun >/dev/null 2>&1; then
  log "ERROR bun_not_found"
  tail -f /dev/null
fi
if ! command -v cloudflared >/dev/null 2>&1; then
  log "ERROR cloudflared_not_found"
  tail -f /dev/null
fi
if ! command -v curl >/dev/null 2>&1; then
  log "ERROR curl_not_found"
  tail -f /dev/null
fi
bun --version >>"$INIT_LOG" 2>&1 || true
cloudflared --version >>"$INIT_LOG" 2>&1 || true
curl --version >>"$INIT_LOG" 2>&1 || true

retry 15 curl -fsSL "$EGRESS_CA_URL" -o /usr/local/share/ca-certificates/iterate-fly-test-ca.crt >>"$INIT_LOG" 2>&1
update-ca-certificates >>"$INIT_LOG" 2>&1
log "ca_install=ok source=${EGRESS_CA_URL}"

export HTTP_PROXY="$EGRESS_PROXY_URL"
export HTTPS_PROXY="$EGRESS_PROXY_URL"
export http_proxy="$EGRESS_PROXY_URL"
export https_proxy="$EGRESS_PROXY_URL"
export NO_PROXY="localhost,127.0.0.1,::1"
export no_proxy="localhost,127.0.0.1,::1"
export NODE_EXTRA_CA_CERTS="/usr/local/share/ca-certificates/iterate-fly-test-ca.crt"
export CURL_CA_BUNDLE="/usr/local/share/ca-certificates/iterate-fly-test-ca.crt"
export REQUESTS_CA_BUNDLE="/usr/local/share/ca-certificates/iterate-fly-test-ca.crt"
export GIT_SSL_CAINFO="/usr/local/share/ca-certificates/iterate-fly-test-ca.crt"

log "proxy_env=\"${EGRESS_PROXY_URL}\""

cd "$APP_DIR"
if [ ! -d "$APP_DIR/node_modules" ]; then
  log "ERROR missing_node_modules path=$APP_DIR/node_modules"
  tail -f /dev/null
fi

SANDBOX_PORT="$SANDBOX_PORT" \
PROOF_PREFIX="${PROOF_PREFIX:-__ITERATE_MITM_PROOF__\\n}" \
bun run "$APP_DIR/server.ts" >>"$INIT_LOG" 2>&1 &
APP_PID="$!"
log "app_pid=$APP_PID"

for attempt in $(seq 1 40); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${SANDBOX_PORT}/healthz" >/dev/null 2>&1; then
    log "sandbox_health=ok"
    break
  fi
  if [ "$attempt" -eq 40 ]; then
    log "ERROR sandbox_health=fail"
    tail -f /dev/null
  fi
  sleep 1
done

cloudflared tunnel --url "http://127.0.0.1:${SANDBOX_PORT}" --no-autoupdate --loglevel info >"$TUNNEL_LOG" 2>&1 &
CLOUDFLARED_PID="$!"
log "cloudflared_pid=$CLOUDFLARED_PID"

if ! wait_for_tunnel_url; then
  log "ERROR tunnel_url_not_found"
  tail -f /dev/null
fi

log "READY sandbox_port=${SANDBOX_PORT}"
tail -f /dev/null
