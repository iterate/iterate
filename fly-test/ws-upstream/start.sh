#!/usr/bin/env bash
set -euo pipefail

UPSTREAM_WS_PORT="${UPSTREAM_WS_PORT:-19090}"
UPSTREAM_WS_LOG_PATH="${UPSTREAM_WS_LOG_PATH:-/tmp/ws-upstream.log}"

UPSTREAM_WS_PORT="$UPSTREAM_WS_PORT" \
UPSTREAM_WS_LOG_PATH="$UPSTREAM_WS_LOG_PATH" \
exec bun run /proof/ws-upstream/server.ts
