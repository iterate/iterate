#!/usr/bin/env bash
set -euo pipefail

INIT_LOG="/tmp/egress-init.log"
TUNNEL_LOG="/tmp/egress-tunnel.log"
TUNNEL_URL_FILE="/tmp/egress-viewer-tunnel-url.txt"
PROXY_PORT="${EGRESS_PROXY_PORT:-18080}"
VIEWER_PORT="${EGRESS_VIEWER_PORT:-18081}"

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
      log "viewer_tunnel_url=$tunnel_url"
      return 0
    fi
    sleep 1
  done
  return 1
}

: >"$INIT_LOG"
log "START host=$(hostname) region=${PROOF_REGION:-unknown}"

export DEBIAN_FRONTEND=noninteractive
apt-get update >>"$INIT_LOG" 2>&1
apt-get install -y --no-install-recommends ca-certificates curl >>"$INIT_LOG" 2>&1
install_cloudflared
node --version >>"$INIT_LOG" 2>&1
cloudflared --version >>"$INIT_LOG" 2>&1

node /proof/egress-proxy/app.mjs >>"$INIT_LOG" 2>&1 &
NODE_PID="$!"
log "node_pid=$NODE_PID"

for attempt in $(seq 1 40); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${VIEWER_PORT}/healthz" >/dev/null 2>&1; then
    log "viewer_health=ok"
    break
  fi
  if [ "$attempt" -eq 40 ]; then
    log "ERROR viewer_health=fail"
    tail -f /dev/null
  fi
  sleep 1
done

cloudflared tunnel --url "http://127.0.0.1:${VIEWER_PORT}" --no-autoupdate --loglevel info >"$TUNNEL_LOG" 2>&1 &
CLOUDFLARED_PID="$!"
log "cloudflared_pid=$CLOUDFLARED_PID"

if ! wait_for_tunnel_url; then
  log "ERROR tunnel_url_not_found"
  tail -f /dev/null
fi

log "READY proxy_port=${PROXY_PORT} viewer_port=${VIEWER_PORT}"
tail -f /dev/null
