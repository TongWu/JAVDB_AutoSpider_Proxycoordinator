# proxy-coordinator

Cloudflare Worker + Durable Objects that coordinate **per-proxy request
pacing** *and* **shared JavDB login state** across multiple GitHub Actions
runners for the JavDB spider.

Five cooperating Durable Object classes live behind the same Worker and
the same bearer token:

- `ProxyCoordinator` (per-proxy DO, addressed by `idFromName(proxy_id)`):
  global `next_available_at` + three-window throttle + CF/failure penalty.
- `GlobalLoginState` (singleton, `idFromName("global")`):
  the at-most-one logged-in proxy + its encrypted session cookie + a
  re-login mutex (`lease`) so only one runner ever performs the actual
  login at a time.
- `MovieClaimState` (per-day-sharded, `idFromName("YYYY-MM-DD[-N]")`):
  cross-runner mutex on detail-page fetches; prevents two runners from
  scraping the same `/v/<id>` page concurrently.
- `RunnerRegistry` (singleton, `idFromName("runners")`):
  registry of live spider runners for ops visibility +
  `proxy_pool_hash` drift detection. Also stores **operator signals**
  (W5.4) — see [Active signals](#active-signals-w54).
- `ConfigState` (singleton, `idFromName("global-config")`):
  W5.3 — versioned snapshot of operator-tunable runtime parameters that
  runners pull on every heartbeat without a redeploy.

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
                                ┌──> ProxyCoordinator(proxy_A)   one DO per proxy_id
                                │     /lease + /report + /state
                                │
Runner 1 ─┐                     ├──> GlobalLoginState (singleton)
Runner 2 ─┼──> Worker ──────────┤     /login_state*
Runner N ─┘   (auth +           │
               rate-limit)      ├──> MovieClaimState(YYYY-MM-DD[-N])  one DO per day-shard
                                │     /claim_movie + /complete_movie + ...
                                │
                                ├──> RunnerRegistry (singleton)
                                │     /register + /heartbeat + /unregister
                                │     /signal + /signals               (W5.4)
                                │
                                └──> ConfigState (singleton)            (W5.3)
                                      /config (GET, PATCH)
```

Every DO class has **separate bindings** and **separate storage**:
rotating one cannot disrupt the others.

## Files

| File | Purpose |
|---|---|
| `wrangler.toml` | Worker + DO + Analytics Engine bindings; v1 → v4 SQLite migrations; tunable throttle constants in `[vars]` |
| `src/index.ts` | Worker entry: routes for every DO + `/health`; Bearer auth + W5.6 rate limit |
| `src/proxy_coordinator.ts` | `ProxyCoordinator` per-proxy DO: `next_available_at` + 3 windows + CF events |
| `src/global_login_state.ts` | `GlobalLoginState` singleton DO: cookie (AES-GCM at rest), version, lease mutex |
| `src/movie_claim_state.ts` | `MovieClaimState` per-day DO: cross-runner detail-page mutex (P1-B), failure cooldown (P2-A), staged-commit (Phase-1) |
| `src/runner_registry.ts` | `RunnerRegistry` singleton DO: live runner list + drift detection + W5.4 operator signals |
| `src/config_state.ts` | `ConfigState` singleton DO (W5.3): versioned snapshot of operator-tunable runtime config |
| `src/types.ts` | Env / payload / response type definitions for every DO |
| `test/proxy_coordinator.test.ts` | Vitest suite (43 tests) — throttle math, auth, P2-D health snapshots |
| `test/global_login_state.test.ts` | Vitest suite (46 tests) — lease, publish, invalidate, encryption, isolation |
| `test/movie_claim_state.test.ts` | Vitest suite (62 tests) — claim / complete / stage / rollback / sweep |
| `test/runner_registry.test.ts` | Vitest suite (34 tests) — register / heartbeat / drift summary |
| `test/config_state.test.ts` | Vitest suite (11 tests, W5.3) — GET / PATCH / heartbeat embedding |
| `test/signals.test.ts` | Vitest suite (10 tests, W5.4) — POST /signal validation + register/heartbeat embedding |
| `test/rate_limit.test.ts` | Vitest suite (10 tests, W5.6) — token-bucket math + fetch-handler integration |

Total: **216 tests** across 7 files.

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
npx vitest run            # 216 unit tests
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

## Runner registry endpoints

`RunnerRegistry` is the singleton DO that tracks which spider runners are
alive right now. Every register / heartbeat response carries a snapshot
of the live cohort and (when the v3 + v4 migrations are applied) the
W5.3 config snapshot and W5.4 active signals.

| Method + path | Body | Purpose |
|---|---|---|
| `POST /register` | `{holder_id, workflow_run_id?, workflow_name?, started_at?, proxy_pool_hash?, page_range?}` | Idempotent register. Re-registers with the same `holder_id` keep the original `started_at` and act as a heartbeat refresh. Response carries `active_runners[]`, `pool_hash_summary[]`, `movie_claim_recommended`, `config?` (W5.3), `active_signals?` (W5.4). |
| `POST /heartbeat` | `{holder_id}` | Refresh `last_heartbeat`. Returns `alive=false` (not 404) for evicted holders so the client can re-register without treating it as fatal. Same `config` / `active_signals` embedding as `/register`. |
| `POST /unregister` | `{holder_id}` | atexit cleanup. Idempotent — unknown holder returns `unregistered=false`. |
| `GET /active_runners` | — | Read-only snapshot for ops dashboards. Does not refresh any heartbeat. |

## Dynamic config (W5.3)

`ConfigState` lets operators tune runtime parameters (throttle windows,
ban TTLs, heartbeat cadence, ...) without redeploying the Worker. The
new values flow to every runner within one heartbeat interval via the
`config` field embedded in `/register` and `/heartbeat` responses.

Allowed keys (closed allowlist — PATCH with anything outside this set
returns HTTP 400): `short_window_sec`, `short_max`, `long_window_sec`,
`long_max`, `extra_window_sec`, `extra_max`, `penalty_window_sec`,
`jitter_max_ms`, `ban_ttl_ms`, `movie_claim_ttl_ms`,
`runner_stale_ttl_ms`, `movie_claim_min_runners`,
`login_cooldown_threshold`, `login_cooldown_window_sec`,
`login_cooldown_duration_ms`, `heartbeat_interval_sec`.

| Method + path | Body | Purpose |
|---|---|---|
| `GET /config` | — | Read the current snapshot: `{version, updated_at, values, server_time}`. `values` is a partial map of operator-set overrides (unset keys fall back to the env-var defaults in `wrangler.toml [vars]`). |
| `PATCH /config` | `{values: {key: stringValue, ...}}` | Partial update. Bumps `version` and `updated_at`. All values are stored / transported as strings — pass `""` to clear an override. Unknown keys return 400. |

```bash
# View
curl -H "Authorization: Bearer $TOKEN" https://your.worker.dev/config

# Tighten the short-window throttle (e.g. response to anti-bot escalation)
curl -X PATCH https://your.worker.dev/config \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"values": {"short_max": "2", "long_max": "20"}}'

# Clear that override (revert to env-var default)
curl -X PATCH https://your.worker.dev/config \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"values": {"short_max": "", "long_max": ""}}'
```

**Note:** The current MVP delivers the **distribution mechanism only**.
Worker DOs (ProxyCoordinator, MovieClaim, RunnerRegistry) still read
their tuning values from env vars on each request; the Python spider
client receives the snapshot in `HeartbeatResult.config` but does not
yet apply it to `MovieSleepManager` / `TripleWindowThrottle`. Migrating
consumers to read from `ConfigState` is a separate follow-up; until
then, PATCH /config is observable but not yet load-bearing.

## Active signals (W5.4)

`RunnerRegistry` carries an operator-pushed signal list that runners
reconcile on every heartbeat. Signals are **state, not events**: the
heartbeat response always returns the full active set, so a runner
arriving mid-flight observes the same posture as everyone else.

Signal kinds (closed allowlist):

| Kind | Purpose | Required payload |
|---|---|---|
| `throttle_global` | Multiply every runner's local sleep / throttle by `factor`. Use during cohort-wide cool-down. | `factor` ∈ [1.0, 100.0], `ttl_ms` |
| `ban_proxy` | Emergency drop of one proxy from every runner's local pool. Independent from the per-proxy Worker-side ban. | `proxy_id`, `ttl_ms` |
| `pause_all` | Runners stop dispatching new tasks; in-flight requests run to completion. | `ttl_ms` |
| `resume` | Operator override — clears every other active signal in one go. | *(none)* |

| Method + path | Body | Purpose |
|---|---|---|
| `POST /signal` | `{kind, ttl_ms?, factor?, proxy_id?, reason?, id?}` | Push a signal. Idempotent on `id` (operator retry replaces the same entry). Server clamps `ttl_ms` to [1 s, 24 h] and `factor` to [1, 100]. |
| `GET /signals` | — | List currently-active signals (already filtered for expired entries). |

```bash
# Emergency global throttle (3× pace, 30 min)
curl -X POST https://your.worker.dev/signal \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"kind":"throttle_global","factor":3.0,"ttl_ms":1800000,"reason":"WAF flap"}'

# Drop a misbehaving proxy from every runner for 1 hour
curl -X POST https://your.worker.dev/signal \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"kind":"ban_proxy","proxy_id":"Proxy-3","ttl_ms":3600000,"reason":"timeouts > 80%"}'

# Pause everyone for 5 min while you investigate
curl -X POST https://your.worker.dev/signal \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"kind":"pause_all","ttl_ms":300000,"reason":"manual ops"}'

# Clear all signals (operator override)
curl -X POST https://your.worker.dev/signal \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"kind":"resume"}'

# What's active right now?
curl -H "Authorization: Bearer $TOKEN" https://your.worker.dev/signals
```

Signals are **time-bounded**: every signal auto-expires at `expires_at_ms`
and the GC alarm prunes the storage every 5 min. The Python client
parses `HeartbeatResult.active_signals` into a typed `Signal` list but
**does not yet apply** the effects to `MovieSleepManager` / `ProxyPool`;
same scope decision as W5.3 — distribution mechanism first, consumer
integration in a follow-up.

## Rate limit (W5.6)

Every authenticated request runs through a per-Bearer-token token-bucket
gate after auth and before the route switch. Defaults to **1000
requests / minute / token**; depleted buckets return HTTP 429.

The bucket lives in the Worker isolate and resets on cold start, so this
is best-effort burst protection rather than strict SLO enforcement.
Configure via `WORKER_RATE_LIMIT_PER_MIN` in `wrangler.toml [vars]`;
set `"0"` to disable (e.g. for load tests).

`/health` bypasses both auth and rate limiting so an unauthenticated
probe can still verify the Worker is reachable.

## DO migrations

`wrangler.toml` declares four migration tags:

- `v1`: introduces `ProxyCoordinator` (per-proxy throttle DO).
- `v2`: introduces `GlobalLoginState` (singleton login state DO).
- `v3`: introduces `MovieClaimState` (per-day claim DO) + `RunnerRegistry`
  (singleton ops/drift DO) in one atomic deploy.
- `v4`: introduces `ConfigState` (singleton W5.3 config DO).

Migrations are applied in tag order on every `wrangler deploy`; do **not**
reorder or delete an earlier tag — that would re-create its DO class
from scratch and lose the persisted SQLite state.  Adding a new DO class
later is always safe: append a new `[[migrations]]` block with the next
tag.

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
