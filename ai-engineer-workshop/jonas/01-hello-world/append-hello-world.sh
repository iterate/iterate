#!/usr/bin/env bash
# One-shot curl append example.
# Shows the raw POST request shape used to add a single event to the stream.
set -euo pipefail

BASE_URL="${BASE_URL:-https://events.iterate.com}"
WORKSHOP_PATH_PREFIX="${WORKSHOP_PATH_PREFIX:-/$(id -un)}"
STREAM_PATH="${STREAM_PATH:-${WORKSHOP_PATH_PREFIX}/hello-world}"
EVENT_TYPE="${EVENT_TYPE:-hello-world}"
MESSAGE="${1:-hello world}"

BODY="$(node -e 'const [path, type, message] = process.argv.slice(1); console.log(JSON.stringify({ path, events: [{ path, type, payload: { message } }] }));' "$STREAM_PATH" "$EVENT_TYPE" "$MESSAGE")"

curl -sS -X POST "${BASE_URL%/}/api/streams${STREAM_PATH}" \
  -H "content-type: application/json" \
  --data "$BODY"

printf '\n'
