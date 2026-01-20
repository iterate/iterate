#!/bin/bash
set -euo pipefail

# Sandbox entrypoint: sets up agent environment and starts s6 process supervisor,
# which runs our daemon and the opencode server under supervision.
#
# Two modes:
#   - Local Docker: /local-iterate-repo mount exists → rsync, pnpm install, build
#   - Daytona/CI: image has everything pre-baked → just starts s6
#
# Why rsync in local mode?
#   The docker image already contains the repo, but may be stale. Restarting the container
#   syncs the latest source from the host mount. This means in local dev you can
#   restart a container and any changes to the daemon/s6-daemons/home-skeleton
#   that you made locally will be reflected in the container.

ITERATE_REPO="${ITERATE_REPO:-$HOME/src/github.com/iterate/iterate}"
ITERATE_REPO_LOCAL_DOCKER_MOUNT="/local-iterate-repo"
S6_DAEMONS="$ITERATE_REPO/apps/os/sandbox/s6-daemons"

echo "=== iterate sandbox ==="

# --- Local Docker: sync host repo into container ---
if [[ -d "$ITERATE_REPO_LOCAL_DOCKER_MOUNT" ]]; then
  echo "Local mode: syncing host repo (restart container to pick up changes)"

  # Sync using .gitignore patterns (excludes build artifacts, node_modules, etc.)
  # But do include .git so that `git status` inside the container shows the same thing as outside
  rsync -a --delete \
    --filter=':- .gitignore' \
    "$ITERATE_REPO_LOCAL_DOCKER_MOUNT/" "$ITERATE_REPO/"

  echo "Git status:"
  (cd "$ITERATE_REPO" && git status --verbose)

  # NOTE: Do NOT delete $ITERATE_REPO_LOCAL_DOCKER_MOUNT - it's a mount point and rm would fail or
  # worse, delete host files if mounted read-write. The mount is isolated anyway.

  # Make scripts executable (rsync preserves permissions but host may not have +x)
  chmod +x "$ITERATE_REPO/apps/os/sandbox/"*.sh
  chmod +x "$ITERATE_REPO/apps/os/sandbox/s6-daemons/"*/run 2>/dev/null || true
  chmod +x "$ITERATE_REPO/apps/os/sandbox/s6-daemons/"*/log/run 2>/dev/null || true

  echo "Installing dependencies..."
  (cd "$ITERATE_REPO" && pnpm install --no-frozen-lockfile)

  echo "Building daemon..."
  (cd "$ITERATE_REPO/apps/daemon" && npx vite build)

  # Setup home directory (agent configs from home-skeleton)
  "$ITERATE_REPO/apps/os/sandbox/setup-home.sh"
fi

# --- Start s6 process supervisor ---
echo "Cleaning s6 state..."
rm -rf "$S6_DAEMONS/.s6-svscan"
find "$S6_DAEMONS" -type d -name supervise -exec rm -rf {} + 2>/dev/null || true

echo "Starting s6-svscan..."
echo ""
echo "Reminder - logs will be here:"
echo "  Daemon:       /var/log/iterate-daemon/"
echo "  Opencode:     /var/log/opencode/"
echo "  Egress proxy: /var/log/egress-proxy/"
echo ""
export ITERATE_REPO
export HOSTNAME="0.0.0.0"

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
GITHUB_MAGIC_TOKEN='getIterateSecret({secretKey: "github.access_token"})'
git config --global "url.https://x-access-token:${GITHUB_MAGIC_TOKEN}@github.com/.insteadOf" "https://github.com/"
git config --global "url.https://x-access-token:${GITHUB_MAGIC_TOKEN}@github.com/.insteadOf" "git@github.com:"
echo "Configured git for GitHub auth via egress proxy"

# Signal readiness via file (more reliable than stdout for docker log detection)
touch /tmp/.iterate-sandbox-ready

exec s6-svscan "$S6_DAEMONS"
