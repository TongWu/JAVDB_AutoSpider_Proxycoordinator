# proxy-coordinator

Cloudflare Worker + Durable Objects that coordinate **per-proxy request
pacing** *and* **shared JavDB login state** across multiple GitHub Actions
runners for the JavDB spider.

Two cooperating Durable Object classes live behind the same Worker and
the same bearer token:

- `ProxyCoordinator` (per-proxy DO, addressed by `idFromName(proxy_id)`):
  global `next_available_at` + three-window throttle + CF/failure penalty.
- `GlobalLoginState` (singleton DO, addressed by `idFromName("global")`):
  the at-most-one logged-in proxy + its encrypted session cookie + a
  re-login mutex (`lease`) so only one runner ever performs the actual
  login at a time.

## Why

### Per-proxy pacing

Each spider runner already enforces a human-like sleep interval and a
three-window throttle (`packages/python/javdb_spider/runtime/sleep.py`).
But those are **process-local**: when two GH Actions runs share the same
proxy pool (same `PROXY_POOL_JSON` secret), they can both fire requests
through the same physical proxy with no awareness of each other,
breaking the carefully-tuned pacing.

`ProxyCoordinator` exposes `/lease` backed by one DO per `proxy_id`.  DO
instances are single-threaded per id, giving us a globally-consistent
`next_available_at` and shared three-window throttle for free.  Every
spider HTTP request first calls `/lease`, waits the returned `wait_ms`,
and only then talks to JavDB.

### Cross-runtime login state

JavDB only allows **one logged-in session per account**: a fresh login
via proxy A invalidates the cookie tied to proxy B.  Without
coordination, every GH Actions runner would (a) attempt its own login,
burning credentials and tripping anti-bot, and (b) clobber each other's
session.

`GlobalLoginState` stores `(logged_in_proxy_name, encrypted_cookie,
version, last_verified_at)` as a singleton DO.  All runners read from it
on startup; only the runner that wins `acquire_lease` performs the actual
re-login when the cookie goes stale, and `publish` makes the new cookie
visible to everyone before `release_lease` lets the next runner try.
See `docs/PROXY_COORDINATOR_DEPLOY.md` §13 in the spider repo for the
end-to-end design.

## Architecture

```
                                ┌──> ProxyCoordinator(proxy_A)
                                │     /lease + /report
Runner 1 ─┐                     ├──> ProxyCoordinator(proxy_B)
Runner 2 ─┼──> Worker (auth) ───┤        ...one DO per proxy_id
Runner N ─┘                     │
                                └──> GlobalLoginState (singleton)
                                      /login_state{,/acquire_lease,
                                       /publish,/invalidate,/release_lease}
```

`/login_state` and `/lease` operate on **different DO classes** with
**separate bindings** and **separate storage**: rotating one cannot
disrupt the other.

## Files

| File | Purpose |
|---|---|
| `wrangler.toml` | Worker + DO + Analytics Engine bindings; v1 / v2 SQLite migrations; tunable throttle constants in `[vars]` |
| `src/index.ts` | Worker entry: routes `/lease`, `/report`, `/state`, `/login_state*`, `/health`; bearer-token auth |
| `src/proxy_coordinator.ts` | `ProxyCoordinator` per-proxy DO: `next_available_at` + 3 windows + CF events |
| `src/global_login_state.ts` | `GlobalLoginState` singleton DO: cookie (AES-GCM at rest), version, lease mutex |
| `src/types.ts` | Env / payload type definitions for both DOs |
| `test/proxy_coordinator.test.ts` | Vitest suite (15 tests) — DO state, throttle math, auth |
| `test/global_login_state.test.ts` | Vitest suite (31 tests) — lease, publish, invalidate, encryption, isolation |

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

# 1. Per-proxy lease (ProxyCoordinator DO)
curl -X POST http://localhost:8787/lease \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"proxy_id": "test", "intended_sleep_ms": 1000}'
# {"wait_ms":1000,"penalty_factor":1.0,"server_time":...,"reason":"ok"}

# 2. Read shared login state (GlobalLoginState DO; empty initially)
curl -H "Authorization: Bearer $TOKEN" http://localhost:8787/login_state
# {"proxy_name":null,"cookie":null,"version":0,...}
```

## GlobalLoginState endpoints

All require `Authorization: Bearer <PROXY_COORDINATOR_TOKEN>`; the DO
state is a single SQLite-backed snapshot (see `src/global_login_state.ts`).

| Method + path | Body | Returns | Purpose |
|---|---|---|---|
| `GET /login_state` | — | `{proxy_name, cookie, version, last_verified_at, has_active_lease, server_time}` | Read the current logged-in proxy + its cookie (decrypted plaintext); cookie is `null` before any publish or after `invalidate`. |
| `POST /login_state/acquire_lease` | `{holder_id, target_proxy_name, ttl_ms}` | `{acquired, holder_id, target_proxy_name, lease_expires_at, server_time}` | At-most-one mutex for the next re-login.  `ttl_ms` is clamped to `[5_000, 300_000]`.  Same `holder_id` calling again renews idempotently. |
| `POST /login_state/publish` | `{holder_id, proxy_name, cookie}` | `{ok, version, server_time}` | Publish a fresh cookie.  **Must hold a live lease** (`409 lease_required` otherwise).  Bumps `version`; **does not** release the lease — call `release_lease` next. |
| `POST /login_state/invalidate` | `{version}` | `{invalidated, current_version, server_time}` | Mark the current cookie bad with an optimistic version lock.  `invalidated:false` means a newer cookie has already been published; resync via `GET /login_state`. |
| `POST /login_state/release_lease` | `{holder_id}` | `{released, server_time}` | Owner releases the lease.  Non-owner calls return `released:false` and leave the lease alone. |

### Why a separate lease + publish step?

The lease guarantees only **one** runner attempts the login at a time
(prevents JavDB anti-bot from reacting to N parallel logins).  Publish
makes the cookie visible *before* the lease is released so the publisher
can run its own verification (`verify_login_via_fixed_pages`) while
still holding the mutex; only after verification succeeds does the
publisher release.

### Cookie encryption

Cookies are encrypted with **AES-GCM 256** before going to SQLite, IV
random per write.  The 256-bit key is derived from
`PROXY_COORDINATOR_TOKEN` via `HKDF-SHA256(salt="global-login-state-v1",
info="aes-gcm-key")`.  Two consequences:

- No new secret to manage; rotating `PROXY_COORDINATOR_TOKEN` is the
  rotation event for both auth and at-rest cookie encryption.
- After a token rotation the DO will fail to decrypt any pre-rotation
  cookie and surface `cookie:null` to clients — exactly what we want
  (the next runner triggers a fresh login).

### Smoke test (full login flow)

```bash
H="-H 'Authorization: Bearer $TOKEN' -H 'content-type: application/json'"

# Acquire the re-login mutex for proxy "JP-1"
eval curl -s -X POST http://localhost:8787/login_state/acquire_lease $H \
  -d "'{\"holder_id\":\"runner-A\",\"target_proxy_name\":\"JP-1\",\"ttl_ms\":60000}'"

# Publish a fresh cookie (must be the lease holder)
eval curl -s -X POST http://localhost:8787/login_state/publish $H \
  -d "'{\"holder_id\":\"runner-A\",\"proxy_name\":\"JP-1\",\"cookie\":\"_jdb_session=abc\"}'"

# Anyone reads the cookie back
curl -H "Authorization: Bearer $TOKEN" http://localhost:8787/login_state

# Release once verification passes
eval curl -s -X POST http://localhost:8787/login_state/release_lease $H \
  -d "'{\"holder_id\":\"runner-A\"}'"
```

## DO migrations

`wrangler.toml` declares two migration tags:

- `v1`: introduces `ProxyCoordinator` (per-proxy throttle DO).
- `v2`: introduces `GlobalLoginState` (singleton login state DO).

Migrations are applied in tag order on every `wrangler deploy`; do **not**
reorder or delete an earlier tag — that would re-create its DO class
from scratch and lose the persisted SQLite state.  Adding a new DO class
later is always safe: append a new `[[migrations]] tag = "v3"` block.

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
