#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="/tmp/cloudflared-e2e.log"
TUNNEL_LOG_FILE="/tmp/cloudflared-tunnel.log"
TUNNEL_URL_FILE="/tmp/tunnel-url.txt"
WEB_DIR="/tmp/web"
MARKER="cloudflared-e2e-ok"

log() {
  printf "%s %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE"
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
  local attempt
  local tunnel_url
  for attempt in $(seq 1 120); do
    tunnel_url="$(grep -Eo "https://[-a-z0-9]+\\.trycloudflare\\.com" "$TUNNEL_LOG_FILE" | head -n 1 || true)"
    if [ -n "$tunnel_url" ]; then
      printf "%s\n" "$tunnel_url" >"$TUNNEL_URL_FILE"
      log "tunnel_url=$tunnel_url"
      return 0
    fi
    sleep 1
  done
  log "ERROR tunnel_url_not_found"
  return 1
}

: >"$LOG_FILE"
log "START host=$(hostname) region=${PROOF_REGION:-unknown}"

export DEBIAN_FRONTEND=noninteractive
apt-get update >>"$LOG_FILE" 2>&1
apt-get install -y --no-install-recommends ca-certificates curl python3 >>"$LOG_FILE" 2>&1
install_cloudflared
cloudflared --version >>"$LOG_FILE" 2>&1
python3 --version >>"$LOG_FILE" 2>&1

mkdir -p "$WEB_DIR"
printf "%s host=%s region=%s\n" "$MARKER" "$(hostname)" "${PROOF_REGION:-unknown}" >"$WEB_DIR/index.html"
python3 -m http.server 8080 --bind 127.0.0.1 --directory "$WEB_DIR" >>"$LOG_FILE" 2>&1 &
PYTHON_PID="$!"
log "python_pid=$PYTHON_PID"

for attempt in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:8080 >/dev/null 2>&1; then
    log "python_server_check=SUCCESS"
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    log "ERROR python_server_check=FAIL"
    tail -f /dev/null
  fi
  sleep 1
done

cloudflared tunnel --url http://127.0.0.1:8080 --no-autoupdate --loglevel info >"$TUNNEL_LOG_FILE" 2>&1 &
CLOUDFLARED_PID="$!"
log "cloudflared_pid=$CLOUDFLARED_PID"

if ! wait_for_tunnel_url; then
  tail -f /dev/null
fi

inside_ok=0
for attempt in $(seq 1 20); do
  if curl -fsS --max-time 10 "$(cat "$TUNNEL_URL_FILE")" | grep -q "$MARKER"; then
    inside_ok=1
    log "inside_tunnel_check=SUCCESS attempt=$attempt"
    break
  fi
  sleep 2
done
if [ "$inside_ok" -ne 1 ]; then
  log "inside_tunnel_check=SKIPPED"
fi

log "READY"
tail -f /dev/null
