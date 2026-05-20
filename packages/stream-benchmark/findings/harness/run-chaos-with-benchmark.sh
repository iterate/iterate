#!/usr/bin/env bash
# Run WebSocket load on one path while chaos monkey kills a pool of sibling DOs.
set -euo pipefail

BASE="${1:?Usage: $0 <worker-base-url>}"
MESSAGES="${2:-5000}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNNER=(pnpm exec tsx)

# Kill pool includes -01 (the stream under load) plus siblings.
echo "Starting chaos in background (pool /bench-chaos-01 …, target is -01)..."
"${RUNNER[@]}" "${ROOT}/findings/harness/chaos-monkey.ts" "${BASE}" \
  --binding stream \
  --path-prefix /bench-chaos \
  --paths 8 \
  --duration-ms 90000 \
  --interval-ms 1500 \
  --kills-per-tick 1 \
  > /tmp/stream-benchmark-chaos.log 2>&1 &
CHAOS_PID=$!
sleep 1

echo "Load test on /bench-chaos-01 (${MESSAGES} messages, partysocket reconnect)..."
"${RUNNER[@]}" "${ROOT}/findings/harness/websocket-external-cli.ts" \
  "${BASE}/bench-chaos-01?after=end" --messages "${MESSAGES}" --reconnect || true

wait "${CHAOS_PID}" || true
echo "Chaos log:"
tail -20 /tmp/stream-benchmark-chaos.log
