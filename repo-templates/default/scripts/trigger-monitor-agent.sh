#!/usr/bin/env bash
set -euo pipefail

# Only run for the iterate/iterate repo — skip silently for customer machines.
repo_path="${ITERATE_CUSTOMER_REPO_PATH:-${ITERATE_REPO:-}}"
if [[ "$repo_path" != */iterate/iterate ]]; then
  exit 0
fi

daemon_base_url="${ITERATE_DAEMON_BASE_URL:-http://127.0.0.1:${PORT:-3001}}"
agent_path="${ITERATE_MONITOR_AGENT_PATH:-/cron/monitor-fly-io-usage}"

read -r -d '' payload <<'JSON' || true
{
  "events": [
    {
      "type": "iterate:agent:prompt-added",
      "message": "@architect\nRun monitoring mode.\nUse skills/architect-monitoring/SKILL.md and skills/monitor-fly-io-usage/SKILL.md.\nMonitor Fly + Cloudflare + PostHog when available; continue if one is unavailable and note gaps.\nIf anything is P1/P2, always start a Slack thread in #monitoring."
    }
  ]
}
JSON

curl -fsS \
  -X POST "${daemon_base_url}/api/agents${agent_path}" \
  -H "Content-Type: application/json" \
  --data "$payload" \
  >/dev/null
