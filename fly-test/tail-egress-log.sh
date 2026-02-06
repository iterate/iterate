#!/usr/bin/env bash
set -euo pipefail

if ! command -v flyctl >/dev/null 2>&1; then
  echo "flyctl not found" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found" >&2
  exit 1
fi
if [ -z "${FLY_API_KEY:-}" ]; then
  echo "Missing FLY_API_KEY in env" >&2
  exit 1
fi

APP="${1:-}"
NAME="${2:-egress-proxy}"

if [ -z "$APP" ]; then
  echo "Usage: bash fly-test/tail-egress-log.sh <app-name> [machine-name]" >&2
  exit 1
fi

export FLY_API_TOKEN="$FLY_API_KEY"

MACHINE_ID="$(flyctl machine list -a "$APP" --json | jq -r --arg name "$NAME" '.[] | select(.name==$name) | .id' | head -n 1)"
if [ -z "$MACHINE_ID" ]; then
  echo "Machine not found: app=$APP name=$NAME" >&2
  exit 1
fi

echo "Tailing /tmp/egress-proxy.log from machine $MACHINE_ID (name=$NAME app=$APP)"
flyctl machine exec "$MACHINE_ID" "sh -lc 'tail -n 200 -f /tmp/egress-proxy.log'" -a "$APP"
