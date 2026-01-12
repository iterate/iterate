#!/bin/sh
# s6-healthcheck-notify.sh - Polls health endpoint and notifies s6 when ready
#
# Usage: s6-healthcheck-notify.sh <health_url>
#
# Run this in background before exec'ing your service. It polls the health
# endpoint, writes to fd 3 when ready, then exits.

HEALTH_URL="$1"

# Poll until healthy (max 30 seconds)
i=0
while [ $i -lt 300 ]; do
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
    printf '\n' >&3 2>/dev/null || true
    echo "Health check passed, s6 notified"
    exit 0
  fi
  i=$((i + 1))
  sleep 0.1
done

echo "Health check timed out after 30s"
exit 1
