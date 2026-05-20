#!/usr/bin/env bash
# Run WebSocket append benchmarks against several named streams in parallel.
# Usage: ./scripts/run-benchmark-load.sh https://stream-benchmark.<subdomain>.workers.dev
set -euo pipefail

BASE="${1:?Usage: $0 <worker-base-url> [messages-per-stream]}"
MESSAGES="${2:-500}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

run_stream() {
  local path="$1"
  local url="${BASE%/}${path}?after=end"
  echo "Starting ${url} (${MESSAGES} messages)..."
  node "${ROOT}/scripts/benchmark-websocket.ts" "$url" --messages "$MESSAGES"
}

for stream in /bench-alpha /bench-beta /bench-gamma; do
  run_stream "$stream" &
done

wait
echo "All benchmark streams finished."
