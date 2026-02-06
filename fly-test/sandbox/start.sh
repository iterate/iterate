#!/usr/bin/env bash
set -euo pipefail

INIT_LOG="/tmp/sandbox-init.log"
TUNNEL_LOG="/tmp/sandbox-tunnel.log"
TUNNEL_URL_FILE="/tmp/sandbox-tunnel-url.txt"
SANDBOX_PORT="${SANDBOX_PORT:-8080}"

log() {
  printf "%s %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$INIT_LOG"
}

install_cloudflared() {
  local arch
  local asset
  arch="$(uname -m)"
  case "$arch" in
    x86_64) asset="cloudflared-linux-amd64" ;;
    aarch64 | arm64) asset="cloudflared-linux-arm64" ;;
    *)
      log "ERROR unsupported_arch=$arch"
      return 1
      ;;
  esac
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}" -o /usr/local/bin/cloudflared
  chmod +x /usr/local/bin/cloudflared
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
log "EGRESS_PROXY_URL=${EGRESS_PROXY_URL:-unset}"

if [ -z "${EGRESS_PROXY_URL:-}" ]; then
  log "ERROR missing EGRESS_PROXY_URL"
  tail -f /dev/null
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update >>"$INIT_LOG" 2>&1
apt-get install -y --no-install-recommends ca-certificates curl >>"$INIT_LOG" 2>&1
install_cloudflared
node --version >>"$INIT_LOG" 2>&1
cloudflared --version >>"$INIT_LOG" 2>&1
curl --version >>"$INIT_LOG" 2>&1

node /proof/sandbox/app.mjs >>"$INIT_LOG" 2>&1 &
NODE_PID="$!"
log "node_pid=$NODE_PID"

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
