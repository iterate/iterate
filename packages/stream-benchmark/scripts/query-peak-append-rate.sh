#!/usr/bin/env bash
# Peak appends/sec from Analytics Engine over the last N minutes (all streams).
set -euo pipefail

: "${CF_ACCOUNT_ID:?Set CF_ACCOUNT_ID}"
: "${CF_API_TOKEN:?Set CF_API_TOKEN}"

MINUTES="${1:-5}"
API="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/analytics_engine/sql"

echo "=== Peak appends/sec (1s buckets, last ${MINUTES}m, all /bench-limit* streams) ==="
curl -fsS "$API" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  --data "SELECT
            intDiv(toUInt32(timestamp), 1) * 1 AS t,
            blob1 AS stream_path,
            SUM(_sample_interval) AS appends_in_second
          FROM stream_metrics
          WHERE blob2 = 'append'
            AND timestamp > NOW() - INTERVAL '${MINUTES}' MINUTE
            AND startsWith(blob1, '/bench-limit')
          GROUP BY t, stream_path
          ORDER BY appends_in_second DESC
          LIMIT 30
          FORMAT JSON"

echo ""
echo "=== Aggregate appends/sec (1s buckets, summed across all limit-test streams) ==="
curl -fsS "$API" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  --data "SELECT
            intDiv(toUInt32(timestamp), 1) * 1 AS t,
            SUM(_sample_interval) AS total_appends_in_second
          FROM stream_metrics
          WHERE blob2 = 'append'
            AND timestamp > NOW() - INTERVAL '${MINUTES}' MINUTE
            AND startsWith(blob1, '/bench-limit')
          GROUP BY t
          ORDER BY total_appends_in_second DESC
          LIMIT 15
          FORMAT JSON"
