#!/bin/sh
# s6-healthcheck-notify.sh - Polls health endpoint until ready
#
# Usage: s6-healthcheck-notify.sh <health_url> [notify_fifo]
#
# If notify_fifo is provided, writes "ready" to it when healthy.

HEALTH_URL="$1"
NOTIFY_FIFO="$2"

# Poll until healthy (max 30 seconds)
i=0
while [ $i -lt 300 ]; do
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
    if [ -n "$NOTIFY_FIFO" ]; then
      echo "ready" > "$NOTIFY_FIFO"
    fi
    echo "Health check passed for $HEALTH_URL"
    exit 0
  fi
  i=$((i + 1))
  sleep 0.1
done

echo "Health check timed out after 30s for $HEALTH_URL"
exit 1
