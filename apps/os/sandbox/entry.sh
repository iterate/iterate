#!/bin/bash
set -euo pipefail

# Sandbox entrypoint: sets up agent environment and starts pidnap process manager,
# which runs our daemon and the opencode server under supervision.
#
# Two modes:
#   - Local Docker (ITERATE_DEV=true): repo mounted, run pnpm install + build
#   - Daytona: image has everything pre-baked → just starts pidnap

ITERATE_REPO="${ITERATE_REPO:-$HOME/src/github.com/iterate/iterate}"
SANDBOX_DIR="$ITERATE_REPO/apps/os/sandbox"

echo "=== iterate sandbox ==="

# --- Local Docker: install deps and build ---
if [[ "${ITERATE_DEV:-}" == "true" ]]; then
  echo "Local dev mode: repo mounted at $ITERATE_REPO"
  echo ""

  echo "Git status:"
  (cd "$ITERATE_REPO" && git status --short || echo "(not a git repo)")
  echo ""

  echo "Installing dependencies..."
  (cd "$ITERATE_REPO" && pnpm install --no-frozen-lockfile)

  echo "Building daemon..."
  (cd "$ITERATE_REPO/apps/daemon" && npx vite build)

  # Setup home directory (agent configs from home-skeleton)
  bash "$SANDBOX_DIR/setup-home.sh"
else
  echo "Daytona mode: using pre-baked image"
fi

# --- Start pidnap process manager ---
echo ""
echo "Starting pidnap..."
echo ""
echo "Reminder - logs will be in /var/log/pidnap/"
echo "  pidnap status         - show manager status"
echo "  pidnap processes list  - list all processes"
echo ""
export ITERATE_REPO

# Egress proxy environment variables
# These enable services to use the mitmproxy for outbound traffic interception
PROXY_PORT=8888
MITMPROXY_DIR="$HOME/.mitmproxy"
CA_CERT_PATH="$MITMPROXY_DIR/mitmproxy-ca-cert.pem"

export HTTP_PROXY="http://127.0.0.1:$PROXY_PORT"
export HTTPS_PROXY="http://127.0.0.1:$PROXY_PORT"
export http_proxy="http://127.0.0.1:$PROXY_PORT"
export https_proxy="http://127.0.0.1:$PROXY_PORT"
export NO_PROXY="localhost,127.0.0.1"
export no_proxy="localhost,127.0.0.1"
export SSL_CERT_FILE="$CA_CERT_PATH"
export SSL_CERT_DIR="$MITMPROXY_DIR"
export REQUESTS_CA_BUNDLE="$CA_CERT_PATH"
export CURL_CA_BUNDLE="$CA_CERT_PATH"
export NODE_EXTRA_CA_CERTS="$CA_CERT_PATH"
export GIT_SSL_CAINFO="$CA_CERT_PATH"

# Configure git to use magic string for GitHub auth (egress proxy resolves it)
# This rewrites https://github.com/ URLs to include the magic string token
# The magic string is URL-encoded to be valid in a URL context
# Egress proxy URL-decodes before matching
GITHUB_MAGIC_TOKEN='getIterateSecret%28%7BsecretKey%3A%20%22github.access_token%22%7D%29'
git config --global "url.https://x-access-token:${GITHUB_MAGIC_TOKEN}@github.com/.insteadOf" "https://github.com/"
git config --global --add "url.https://x-access-token:${GITHUB_MAGIC_TOKEN}@github.com/.insteadOf" "git@github.com:"
echo "Configured git for GitHub auth via egress proxy"

# Signal readiness via file (more reliable than stdout for docker log detection)
touch /tmp/.iterate-sandbox-ready

# Node is not an init system, tini is good
exec tini -sg -- pidnap init -c "$SANDBOX_DIR/pidnap.config.ts"
