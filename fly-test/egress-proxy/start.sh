#!/usr/bin/env bash
set -euo pipefail

INIT_LOG="/tmp/egress-init.log"
TUNNEL_LOG="/tmp/egress-tunnel.log"
TUNNEL_URL_FILE="/tmp/egress-viewer-tunnel-url.txt"
MITM_LOG="${EGRESS_LOG_PATH:-/tmp/egress-proxy.log}"
MITM_PORT="${EGRESS_MITM_PORT:-18080}"
VIEWER_PORT="${EGRESS_VIEWER_PORT:-18081}"
TRANSFORM_URL="${TRANSFORM_URL:-http://127.0.0.1:${VIEWER_PORT}/transform}"
MITM_DIR="${MITM_DIR:-/data/mitm}"
APP_DIR="/opt/egress-proxy-app"
GO_APP_DIR="/opt/egress-go-mitm"

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
  retry 8 curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}" -o /usr/local/bin/cloudflared >>"$INIT_LOG" 2>&1
  chmod +x /usr/local/bin/cloudflared
}

install_bun() {
  export BUN_INSTALL="/root/.bun"
  if [ ! -x "$BUN_INSTALL/bin/bun" ]; then
    retry 8 curl -fsSL https://bun.sh/install -o /tmp/bun-install.sh >>"$INIT_LOG" 2>&1
    BUN_INSTALL="$BUN_INSTALL" bash /tmp/bun-install.sh >>"$INIT_LOG" 2>&1
  fi
  export PATH="$BUN_INSTALL/bin:$PATH"
}

install_go() {
  local arch
  local go_arch
  local go_version
  arch="$(uname -m)"
  case "$arch" in
    x86_64) go_arch="amd64" ;;
    aarch64 | arm64) go_arch="arm64" ;;
    *)
      log "ERROR unsupported_go_arch=$arch"
      return 1
      ;;
  esac

  go_version="$(retry 8 curl -fsSL https://go.dev/VERSION?m=text | head -n 1)"
  if [ -z "$go_version" ]; then
    log "ERROR unable_to_resolve_go_version"
    return 1
  fi

  retry 8 curl -fsSL "https://go.dev/dl/${go_version}.linux-${go_arch}.tar.gz" -o /tmp/go.tgz >>"$INIT_LOG" 2>&1
  rm -rf /usr/local/go
  tar -C /usr/local -xzf /tmp/go.tgz
  export PATH="/usr/local/go/bin:$PATH"
}

generate_ca() {
  mkdir -p "$MITM_DIR"
  if [ ! -f "$MITM_DIR/ca.crt" ] || [ ! -f "$MITM_DIR/ca.key" ]; then
    log "generating_ca_cert dir=$MITM_DIR"
    openssl ecparam -name prime256v1 -genkey -noout -out "$MITM_DIR/ca.key" >>"$INIT_LOG" 2>&1
    openssl req -x509 -new -sha256 \
      -key "$MITM_DIR/ca.key" \
      -out "$MITM_DIR/ca.crt" \
      -days 3650 \
      -subj "/CN=Iterate Fly Test Egress Root CA/O=Iterate/OU=fly-test" \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" \
      -addext "subjectKeyIdentifier=hash" >>"$INIT_LOG" 2>&1
  else
    log "ca_cert_already_exists"
  fi
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
: >"$MITM_LOG"
log "START host=$(hostname) region=${PROOF_REGION:-unknown}"

export DEBIAN_FRONTEND=noninteractive
retry 5 apt-get update >>"$INIT_LOG" 2>&1
retry 5 apt-get install -y --no-install-recommends ca-certificates curl openssl xz-utils >>"$INIT_LOG" 2>&1
install_cloudflared
install_bun
install_go
bun --version >>"$INIT_LOG" 2>&1
go version >>"$INIT_LOG" 2>&1
cloudflared --version >>"$INIT_LOG" 2>&1

generate_ca

mkdir -p "$APP_DIR" "$GO_APP_DIR"
cp /proof/egress-proxy/server.ts "$APP_DIR/server.ts"
cp /proof/egress-proxy/client.tsx "$APP_DIR/client.tsx"
cp /proof/egress-proxy/index.html "$APP_DIR/index.html"
cp /proof/egress-proxy/package.json "$APP_DIR/package.json"
cp /proof/egress-proxy/tsconfig.json "$APP_DIR/tsconfig.json"
cp /proof/egress-proxy/go-mitm/main.go "$GO_APP_DIR/main.go"
cp /proof/egress-proxy/go-mitm/go.mod "$GO_APP_DIR/go.mod"

cd "$APP_DIR"
retry 5 bun install >>"$INIT_LOG" 2>&1

cd "$GO_APP_DIR"
export GOCACHE="/tmp/go-build-cache"
export GOMODCACHE="/tmp/go-mod-cache"
retry 5 /usr/local/go/bin/go mod download >>"$INIT_LOG" 2>&1
retry 5 /usr/local/go/bin/go build -o /usr/local/bin/fly-mitm ./ >>"$INIT_LOG" 2>&1

EGRESS_LOG_PATH="$MITM_LOG" \
EGRESS_VIEWER_PORT="$VIEWER_PORT" \
MITM_CA_CERT_PATH="$MITM_DIR/ca.crt" \
PROOF_PREFIX="${PROOF_PREFIX:-__ITERATE_MITM_PROOF__\\n}" \
bun run "$APP_DIR/server.ts" >>"$INIT_LOG" 2>&1 &
VIEWER_PID="$!"
log "viewer_pid=$VIEWER_PID"

/usr/local/bin/fly-mitm \
  --listen ":${MITM_PORT}" \
  --transform-url "$TRANSFORM_URL" \
  --ca-cert "$MITM_DIR/ca.crt" \
  --ca-key "$MITM_DIR/ca.key" \
  --log "$MITM_LOG" \
  --request-preview-bytes "${REQUEST_PREVIEW_BYTES:-512}" >>"$INIT_LOG" 2>&1 &
MITM_PID="$!"
log "mitm_pid=$MITM_PID"

for attempt in $(seq 1 60); do
  viewer_ok="0"
  mitm_ok="0"
  if curl -fsS --max-time 2 "http://127.0.0.1:${VIEWER_PORT}/healthz" >/dev/null 2>&1; then viewer_ok="1"; fi
  if curl -fsS --max-time 2 "http://127.0.0.1:${MITM_PORT}/healthz" >/dev/null 2>&1; then mitm_ok="1"; fi

  if [ "$viewer_ok" = "1" ] && [ "$mitm_ok" = "1" ]; then
    log "services_health=ok"
    break
  fi

  if [ "$attempt" -eq 60 ]; then
    log "ERROR services_health=fail"
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

log "READY mitm_port=${MITM_PORT} viewer_port=${VIEWER_PORT}"
tail -f /dev/null
