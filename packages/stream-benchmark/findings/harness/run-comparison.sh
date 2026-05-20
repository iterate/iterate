#!/usr/bin/env bash
# Run the standard 10k comparison suite. Requires deploy + doppler os dev_jonas for nothing (public URL).
set -euo pipefail

BASE="${1:?Usage: $0 <worker-base-url>}"
MESSAGES="${2:-10000}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

RUNNER=(pnpm exec tsx)

echo "=== 1. External Node WebSocket ==="
"${RUNNER[@]}" "${ROOT}/findings/harness/websocket-external-cli.ts" \
  "${BASE}/bench-findings-external?after=end" --messages "${MESSAGES}"

echo "=== 2. Worker WebSocket (stub.fetch Upgrade) ==="
curl -fsS "${BASE}/benchmark/ws?messages=${MESSAGES}&path=/bench-findings-worker-ws"

echo ""
echo "=== 3. BenchmarkDriver DO WebSocket ==="
curl -fsS "${BASE}/benchmark/driver-ws?messages=${MESSAGES}&path=/bench-findings-driver-ws"

echo ""
echo "=== 4. Worker RPC serial ==="
curl -fsS "${BASE}/benchmark/rpc?messages=${MESSAGES}&batch=1&path=/bench-findings-rpc-serial"

echo ""
echo "=== 5. Worker RPC batch 100 ==="
curl -fsS "${BASE}/benchmark/rpc?messages=${MESSAGES}&batch=100&path=/bench-findings-rpc-batch"

echo ""
echo "Done. See findings/findings.md"
