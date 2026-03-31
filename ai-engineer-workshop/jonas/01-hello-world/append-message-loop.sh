#!/usr/bin/env bash
# Interactive curl append loop.
# Prompts for a message forever and appends each one as a new event to the stream.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

printf 'Appending to %s\n' "${STREAM_PATH:-/jonas/hello-world}"
printf 'Press Ctrl+C to stop.\n'

while true; do
  printf 'message> '
  if ! IFS= read -r message; then
    printf '\n'
    exit 0
  fi

  if [ -z "$message" ]; then
    continue
  fi

  BASE_URL="${BASE_URL:-https://events.iterate.com}" \
  STREAM_PATH="${STREAM_PATH:-/jonas/hello-world}" \
  EVENT_TYPE="${EVENT_TYPE:-hello-world}" \
    "$SCRIPT_DIR/append-hello-world.sh" "$message"
done
