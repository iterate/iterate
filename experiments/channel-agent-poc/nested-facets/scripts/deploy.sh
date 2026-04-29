#!/usr/bin/env bash
# Sync base template, rebase project, build all apps, and optionally deploy the worker.
# Usage: ./scripts/deploy.sh [--worker]
set -euo pipefail
cd "$(dirname "$0")/.."

ACCOUNT_ID="cc7f6f461fbe823c199da2b27f9e0ff3"
PROJECT_HOST="test.iterate-dev-jonas.app"

echo "=== 1. Sync base template ==="
CLOUDFLARE_ACCOUNT_ID=$ACCOUNT_ID npx tsx scripts/sync-base-artifact.ts ./base-template

echo "=== 2. Deploy worker (if --worker) ==="
if [[ "${1:-}" == "--worker" ]]; then
  npx wrangler deploy
fi

echo "=== 3. Rebase project ==="
curl -sf -X POST "https://$PROJECT_HOST/api/rebase?force=1" -H 'x-level: project' | \
  python3 -c "import sys,json; print('  rebase:', json.loads(sys.stdin.read())['ok'])"

echo "=== 4. Build apps ==="
for app in agents billing chatbot counter; do
  result=$(curl -sf -X POST "https://$PROJECT_HOST/api/build/$app" -H 'x-level: project' 2>/dev/null || echo '{"ok":false}')
  ok=$(echo "$result" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('ok','?'))" 2>/dev/null || echo "skip")
  echo "  $app: $ok"
done

echo "=== Done ==="
