# proxy-coordinator

Cloudflare Worker + Durable Object that coordinates **per-proxy request
pacing across multiple GitHub Actions runners** for the JavDB spider.

## Why

Each spider runner already enforces a human-like sleep interval and a
three-window throttle (`packages/python/javdb_spider/runtime/sleep.py`).
But those are **process-local**: when two GH Actions runs share the same
proxy pool (same `PROXY_POOL_JSON` secret), they can both fire requests
through the same physical proxy with no awareness of each other,
breaking the carefully-tuned pacing.

This Worker exposes a `/lease` endpoint backed by one **Durable Object
per `proxy_id`**.  DO instances are single-threaded per id, which gives
us a globally-consistent `next_available_at` and shared three-window
throttle for free.  Every spider HTTP request first calls `/lease`,
waits the returned `wait_ms`, and only then talks to JavDB.

## Architecture

```
Runner 1 ─┐
Runner 2 ─┼──> Worker /lease ──> DO(proxy_A)  ─┐
Runner N ─┘                  └─> DO(proxy_B)  ─┴── one DO per proxy_id
```

Per-proxy CF/failure events are also reported to the same DO via
`/report`, so any runner that hits Turnstile causes every other runner
to immediately raise its `penalty_factor` (longer sleeps).

## Files

| File | Purpose |
|---|---|
| `wrangler.toml` | Worker + DO + Analytics Engine bindings; tunable throttle constants in `[vars]` |
| `src/index.ts` | Worker entry: routes `/lease`, `/report`, `/state`, `/health`; bearer-token auth |
| `src/proxy_coordinator.ts` | `ProxyCoordinator` Durable Object: `next_available_at` + 3 windows + CF events |
| `src/types.ts` | Env / payload type definitions |
| `test/proxy_coordinator.test.ts` | Vitest suite (15 tests) — DO state, throttle math, auth |

## Auth

Every endpoint except `GET /health` requires:

```
Authorization: Bearer <PROXY_COORDINATOR_TOKEN>
```

Set the secret with:

```bash
openssl rand -hex 32 | wrangler secret put PROXY_COORDINATOR_TOKEN
```

The same value must be added to GitHub repo Secrets as
`PROXY_COORDINATOR_TOKEN`.

## proxy_id consistency (CRITICAL)

The DO is addressed via `env.PROXY_DO.idFromName(proxy_id)`.  All
runners **must** agree on the same `proxy_id` string for the same
physical proxy, otherwise the per-proxy mutex falls apart silently.

The Python client uses, in order:

1. The proxy's `name` field from `PROXY_POOL_JSON` (verbatim, trimmed).
2. If `name` is missing, `proxy-<sha1(host:port)[:16]>` (deterministic
   fallback).

**Operational rule**: every proxy entry in `PROXY_POOL_JSON` should
have an explicit `name`.  The Python client logs an ERROR (but does
not abort) when it sees a nameless entry.

## Deploy

```bash
cd cloudflare/proxy_coordinator
npm install
wrangler login                                     # one-time
wrangler secret put PROXY_COORDINATOR_TOKEN        # paste random hex
wrangler deploy
```

The deploy URL looks like
`https://proxy-coordinator.<your-subdomain>.workers.dev`.  Set this in
GitHub repo Variables as `PROXY_COORDINATOR_URL`.

## Local development

```bash
npm install
npx wrangler dev          # http://localhost:8787
npx vitest run            # 15 unit tests
npx tsc --noEmit          # type-check
```

Smoke test:

```bash
TOKEN=$(openssl rand -hex 32)
echo $TOKEN | wrangler secret put PROXY_COORDINATOR_TOKEN
curl -X POST http://localhost:8787/lease \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"proxy_id": "test", "intended_sleep_ms": 1000}'
# {"wait_ms":1000,"penalty_factor":1.0,"server_time":...,"reason":"ok"}
```

## Free-tier sizing

The Cloudflare Workers Free plan provides:

| Resource | Daily limit |
|---|---|
| Worker requests | 100,000 |
| DO requests | 100,000 |
| DO Duration | 13,000 GB-s |
| DO SQLite rows read | 5,000,000 |
| DO SQLite rows written | 100,000 |
| DO storage | 5 GB |

For the JavDB spider (DailyIngestion runs once daily, ~5,000–20,000
requests per run), this consumes roughly **5%–20% of the free quota**.
See `docs/PROXY_COORDINATOR_DEPLOY.md` §10 for the full math.

## Rollback

The Python side is **fail-open**: if the coordinator is unreachable or
its env vars are unset, the spider transparently falls back to the
original local-only throttling.  Two rollback paths:

1. **Disable**: in GitHub Settings, clear the `PROXY_COORDINATOR_URL`
   variable (or delete `PROXY_COORDINATOR_TOKEN` secret).  Next run
   uses local throttling only.  Zero code change.
2. **Tear down**: `cd cloudflare/proxy_coordinator && wrangler delete`.

## Observability

Each lease writes a row to the `proxy_coordinator_leases` Analytics
Engine dataset (free tier: 100k data points/day):

```
blobs:   [proxy_id, op]                      # op = "lease" | "report_cf" | "report_failure"
doubles: [wait_ms, penalty_factor]
indexes: [proxy_id]
```

Query examples:

```sql
-- Per-proxy mean wait over the last hour
SELECT blobs.0 AS proxy_id, AVG(doubles.0) AS mean_wait_ms
FROM proxy_coordinator_leases
WHERE timestamp > NOW() - INTERVAL '1' HOUR
  AND blobs.1 = 'lease'
GROUP BY blobs.0;

-- Daily lease count (compare against 70 k watermark)
SELECT toDate(timestamp) AS day, COUNT(*) AS leases
FROM proxy_coordinator_leases
WHERE blobs.1 = 'lease'
GROUP BY day
ORDER BY day DESC;
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| 401 Unauthorized | GH Secret mismatch with Worker secret |
| 400 missing proxy_id | client did not send `proxy_id` (bug in Python wiring) |
| 429 / quota errors | exceeded 100 k req/day; upgrade to Paid ($5/mo) |
| Long `wait_ms` for a fresh proxy | another runner already holds `next_available_at`; expected |
| Long `wait_ms` after no recent activity | check that all runners use the **same** `proxy_id` string |
| All requests fall back to local | check Worker `/health`, GH var/secret values |
