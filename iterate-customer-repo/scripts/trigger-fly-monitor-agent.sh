#!/usr/bin/env bash
set -euo pipefail

daemon_base_url="${ITERATE_DAEMON_BASE_URL:-http://127.0.0.1:${PORT:-3001}}"
agent_path="${ITERATE_MONITOR_AGENT_PATH:-/cron/monitor-fly-io-usage}"

read -r -d '' payload <<'JSON' || true
{
  "events": [
    {
      "type": "iterate:agent:prompt-added",
      "message": "@architect\nRun Fly monitoring mode.\nRead and follow: skills/monitor-fly-io-usage/SKILL.md\nUse Fly + Cloudflare observability if available; continue if one is unavailable and note the gap briefly.\nPlaybooks are static runbooks; do not append findings to playbooks.\nAppend to active task only if needed (blocked/deferred/repeat issue).\nIf anything is P1/P2, always start a Slack thread in #monitoring."
    }
  ]
}
JSON

curl -fsS \
  -X POST "${daemon_base_url}/api/agents${agent_path}" \
  -H "Content-Type: application/json" \
  --data "$payload" \
  >/dev/null
