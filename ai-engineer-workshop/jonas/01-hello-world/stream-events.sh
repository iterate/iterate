#!/usr/bin/env bash
# Curl SSE reader.
# Shows the raw `text/event-stream` response for a stream, including live updates.
set -euo pipefail

BASE_URL="${BASE_URL:-https://events.iterate.com}"
WORKSHOP_PATH_PREFIX="${WORKSHOP_PATH_PREFIX:-/$(id -un)}"
STREAM_PATH="${STREAM_PATH:-${WORKSHOP_PATH_PREFIX}/hello-world}"
LIVE="${LIVE:-true}"
OFFSET="${OFFSET:-}"

URL="${BASE_URL%/}/api/streams${STREAM_PATH}?live=${LIVE}"
if [ -n "$OFFSET" ]; then
  URL="${URL}&offset=${OFFSET}"
fi

curl -sS -N \
  -H "accept: text/event-stream" \
  "$URL"
