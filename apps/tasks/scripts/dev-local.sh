#!/usr/bin/env bash
# One-command local harness: local apps/os platform + local tasks vessel +
# header-stamping proxy so a real browser can use the board.
#
#   ./scripts/dev-local.sh [projectSlug]
#
# Prereqs: iterate worktree at ../iterate-collab-poc with doppler dev config;
# deps installed in both worktrees. Idempotent: reuses running servers,
# creates the project + seed tasks only if missing.
set -euo pipefail

TASKS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OS_DIR="${OS_DIR:-$TASKS_DIR/../iterate-collab-poc/apps/os}"
SLUG="${1:-collab-poc}"
TASKS_PORT="${TASKS_PORT:-5199}"
PROXY_PORT="${PROXY_PORT:-5200}"

# 1. Platform: start (or reuse) the os dev server; discover its port.
(cd "$OS_DIR" && pnpm dev start --detach >/dev/null 2>&1 || true)
# A cold start writes the descriptor asynchronously — wait for it.
for _ in $(seq 1 60); do
  [ -f "$OS_DIR/.dev-server/dev-server.json" ] && break
  sleep 1
done
OS_URL=$(node -e "
  const { readFileSync } = require('fs');
  const info = JSON.parse(readFileSync('$OS_DIR/.dev-server/dev-server.json', 'utf8'));
  console.log(info.baseUrl.replace(/\/+\$/, ''));")
echo "platform: $OS_URL"

# 2. Vessel: point OS_BASE_URL at the local platform; start vite if not up.
echo "OS_BASE_URL=$OS_URL" > "$TASKS_DIR/.dev.vars"
if ! curl -sf "http://localhost:$TASKS_PORT/healthz" >/dev/null 2>&1; then
  (cd "$TASKS_DIR" && nohup pnpm dev --port "$TASKS_PORT" --strictPort \
    > /tmp/tasks-dev.log 2>&1 &)
  for _ in $(seq 1 60); do
    curl -sf "http://localhost:$TASKS_PORT/healthz" >/dev/null 2>&1 && break
    sleep 0.5
  done
  if ! curl -sf "http://localhost:$TASKS_PORT/healthz" >/dev/null 2>&1; then
    echo "vessel failed to become healthy on :$TASKS_PORT — see /tmp/tasks-dev.log" >&2
    exit 1
  fi
fi
echo "vessel:   http://localhost:$TASKS_PORT"

# 3. Project: create + seed if missing; fetch id.
PROJECT_ID=$(cd "$OS_DIR" && doppler run -- pnpm cli itx run --base-url "$OS_URL" --eval "
  const project = itx.projects.get('$SLUG').create({});
  await project.waitUntilReady();
  return await project.projectId;" 2>/dev/null | tail -1 | tr -d '"')
echo "project:  $PROJECT_ID ($SLUG)"

# 4. Token: mint a 15-min project-app-session JWT with the local dev secret.
SECRET=$(cd "$OS_DIR" && doppler secrets get APP_CONFIG_PROJECT_APP_SESSION_SECRET --plain)
TOKEN=$(SESSION_SECRET="$SECRET" node "$TASKS_DIR/scripts/mint-local-token.mjs" "$PROJECT_ID")
echo "token:    minted (15 min)"

# 5. Proxy: stamp header+cookie so a real browser works.
pkill -f "local-proxy.mjs $PROXY_PORT" 2>/dev/null || true
nohup node "$TASKS_DIR/scripts/local-proxy.mjs" "$PROXY_PORT" "$TASKS_PORT" "$PROJECT_ID" "$TOKEN" \
  > /tmp/tasks-proxy.log 2>&1 &
sleep 0.5
echo
echo "open:     http://localhost:$PROXY_PORT   (token expires in 15 min — rerun to refresh)"
echo "probes:   node scripts/probe-rpc.mjs http://localhost:$TASKS_PORT $PROJECT_ID <token> <checkoutId>"
