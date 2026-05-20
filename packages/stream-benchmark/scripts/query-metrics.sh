#!/usr/bin/env bash
set -euo pipefail

: "${CF_ACCOUNT_ID:?Set CF_ACCOUNT_ID (32-char account id from Cloudflare dashboard)}"
: "${CF_API_TOKEN:?Set CF_API_TOKEN (Account Analytics Read)}"

API="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/analytics_engine/sql"

echo "=== Totals (last 15m) ==="
curl -fsS "$API" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  --data "SELECT blob1 AS stream_path, SUM(_sample_interval) AS appends
          FROM stream_metrics
          WHERE timestamp > NOW() - INTERVAL '15' MINUTE
            AND blob2 = 'append'
          GROUP BY stream_path
          ORDER BY appends DESC
          FORMAT JSON"

echo ""
echo "=== Appends/sec (10s buckets, last 15m) ==="
curl -fsS "$API" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  --data "SELECT
            intDiv(toUInt32(timestamp), 10) * 10 AS t,
            blob1 AS stream_path,
            SUM(_sample_interval) / 10 AS appends_per_sec
          FROM stream_metrics
          WHERE blob2 = 'append'
            AND timestamp > NOW() - INTERVAL '15' MINUTE
          GROUP BY t, stream_path
          ORDER BY t, stream_path
          FORMAT JSON"
