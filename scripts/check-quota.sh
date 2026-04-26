#!/usr/bin/env bash
# Query the proxy-coordinator Analytics Engine dataset and emit a warning
# (exit 1) when daily lease count exceeds the threshold.  Intended to be
# run from CI cron or a local cronjob.
#
# Required env:
#   CLOUDFLARE_ACCOUNT_ID       — same as VAR_CLOUDFLARE_ACCOUNT_ID in CI
#   CLOUDFLARE_API_TOKEN        — token with "Account Analytics: Read" perm
#   PROXY_COORDINATOR_THRESHOLD — soft cap (default 70000 = 70% of 100k free quota)
#
# Usage:
#   bash cloudflare/proxy_coordinator/scripts/check-quota.sh

set -euo pipefail

: "${CLOUDFLARE_ACCOUNT_ID:?missing}"
: "${CLOUDFLARE_API_TOKEN:?missing}"
THRESHOLD="${PROXY_COORDINATOR_THRESHOLD:-70000}"

# Workers Analytics Engine SQL endpoint.  See:
# https://developers.cloudflare.com/analytics/analytics-engine/sql-api/
SQL_URL="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/analytics_engine/sql"

QUERY=$(cat <<'SQL'
SELECT toDate(timestamp) AS day, COUNT(*) AS leases
FROM proxy_coordinator_leases
WHERE blob1 = 'lease'
  AND timestamp > NOW() - INTERVAL '24' HOUR
GROUP BY day
ORDER BY day DESC
FORMAT JSON
SQL
)

response=$(curl -fsS -X POST "$SQL_URL" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "content-type: text/plain" \
  --data-binary "$QUERY")

count=$(echo "$response" | python3 -c "
import json, sys
d = json.load(sys.stdin)
rows = d.get('data', [])
if not rows:
    print(0)
else:
    print(int(rows[0].get('leases', 0)))
")

echo "Last-24h lease count: $count (threshold: $THRESHOLD)"
if [ "$count" -gt "$THRESHOLD" ]; then
    echo "::warning::proxy-coordinator daily lease count $count exceeds threshold $THRESHOLD (limit 100000/day on Free plan)"
    exit 1
fi
echo "OK — well under the free-tier daily quota"
