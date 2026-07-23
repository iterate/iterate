#!/usr/bin/env bash
# Try the DEPLOYED collab preview in your browser: mints a 15-minute token
# for the preview-13 project and proxies localhost:5300 → the deployed vessel
# (stamping the auth the config-worker proxy would). Re-run to refresh.
set -euo pipefail
TASKS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OS_DIR="${OS_DIR:-$TASKS_DIR/../iterate-collab-poc/apps/os}"
PROJECT_ID="${PROJECT_ID:-prj_105a32c658ea4e7e99918071b3ac83d0}"
VESSEL="https://tasks-collab-preview.iterate.workers.dev"
PORT="${PORT:-5300}"

SECRET=$(cd "$OS_DIR" && doppler secrets get APP_CONFIG_PROJECT_APP_SESSION_SECRET --plain --config preview_13)
TOKEN=$(SESSION_SECRET="$SECRET" node "$TASKS_DIR/scripts/mint-local-token.mjs" "$PROJECT_ID" "usr_jonas" "$VESSEL")
pkill -f "local-proxy.mjs $PORT" 2>/dev/null || true
nohup node "$TASKS_DIR/scripts/local-proxy.mjs" "$PORT" "$VESSEL" "$PROJECT_ID" "$TOKEN" \
  > /tmp/tasks-preview-proxy.log 2>&1 &
sleep 0.5
echo
echo "  DEPLOYED board:   http://localhost:$PORT/w/demo"
echo "  Collab editor:    http://localhost:$PORT/collab/demo?path=/tasks/ship-collab-lane.md"
echo "  (token lasts 15 min — re-run this script to refresh)"
