import { ConfigSnapshot, Env, LeaseRequest, ReportRequest } from "./types";

export { ProxyCoordinator } from "./proxy_coordinator";
export { GlobalLoginState } from "./global_login_state";
export { MovieClaimState } from "./movie_claim_state";
export { RunnerRegistry } from "./runner_registry";
export { ConfigState } from "./config_state";

/**
 * W5.6 — Worker-level token-bucket rate limit.
 *
 * Best-effort defence against burst abuse from a single auth token within
 * one Worker isolate. Limits to `WORKER_RATE_LIMIT_PER_MIN` (default 1000)
 * requests per minute per token. Tokens refill linearly over the window;
 * a depleted bucket returns HTTP 429.
 *
 * Trade-offs:
 *
 * * Isolate-local: every Worker isolate runs an independent bucket. A
 *   single token spread across many isolates can still exceed the limit
 *   globally — but the Worker invocation model is sticky enough that a
 *   given runner usually pins to one isolate for the lifetime of its
 *   keep-alive HTTP connection.
 * * Cold-start reset: buckets do not persist. Acceptable for abuse
 *   protection (the operator can deploy a new wheel to reset) but not
 *   for SLO enforcement.
 *
 * Disable by setting `WORKER_RATE_LIMIT_PER_MIN=0` in `wrangler.toml`
 * `[vars]` (also the convention used by tests).
 */
const DEFAULT_RATE_LIMIT_PER_MIN = 1000;
const RATE_LIMIT_WINDOW_MS = 60_000;

interface BucketState {
  /** Tokens currently available in this bucket. */
  tokens: number;
  /** Wall-clock ms of the last token refill. */
  lastRefillMs: number;
}

/**
 * Module-scope (per-isolate) bucket store keyed by Bearer token. Workers do
 * not share JS state across isolates, so this is intentionally lightweight
 * — no eviction logic; the map grows by token count which is bounded by
 * the operator's deploy.
 */
const rateLimitBuckets = new Map<string, BucketState>();

/**
 * Decide whether *token* may make another request right now. Refills the
 * bucket linearly: a bucket sized at `capacity` per `RATE_LIMIT_WINDOW_MS`
 * gains `capacity / windowMs` tokens per millisecond elapsed since the
 * previous decision.
 */
function rateLimitAllow(token: string, capacity: number, nowMs: number): boolean {
  if (capacity <= 0) return true; // disabled
  let bucket = rateLimitBuckets.get(token);
  if (bucket === undefined) {
    bucket = { tokens: capacity, lastRefillMs: nowMs };
    rateLimitBuckets.set(token, bucket);
  } else {
    const elapsed = Math.max(0, nowMs - bucket.lastRefillMs);
    if (elapsed > 0) {
      const refill = (elapsed * capacity) / RATE_LIMIT_WINDOW_MS;
      bucket.tokens = Math.min(capacity, bucket.tokens + refill);
      bucket.lastRefillMs = nowMs;
    }
  }
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

/** Test-only — reset the per-isolate bucket store. */
export function _resetRateLimitBucketsForTesting(): void {
  rateLimitBuckets.clear();
}

/** Test-only — expose the pure rate-limit decision with controllable nowMs. */
export function _rateLimitAllowForTesting(
  token: string,
  capacity: number,
  nowMs: number,
): boolean {
  return rateLimitAllow(token, capacity, nowMs);
}

/** Test-only — forcibly seed a bucket state (e.g. drained, just-refilled). */
export function _seedRateLimitBucketForTesting(
  token: string,
  tokens: number,
  lastRefillMs: number,
): void {
  rateLimitBuckets.set(token, { tokens, lastRefillMs });
}

function resolveRateLimitCapacity(env: Env): number {
  const raw = env.WORKER_RATE_LIMIT_PER_MIN;
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_RATE_LIMIT_PER_MIN;
  }
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_RATE_LIMIT_PER_MIN;
  return n > 0 ? n : 0;
}

/**
 * Endpoints that accept GET (every other request must be POST).  Kept as a
 * `Set` so adding new read-only routes is a one-line edit instead of touching
 * the conditional in two places.
 */
const GET_ALLOWED_PATHS = new Set<string>([
  "/state",
  "/login_state",
  "/movie_status",
  "/sweep_orphan_stages",
  "/active_runners",
  "/config",
  "/signals",
  "/dashboard",
  "/ops/snapshot",
  "/recommend_proxy",
]);

/** W5.3 — extra non-POST/non-GET methods allowed on specific routes. */
const PATCH_ALLOWED_PATHS = new Set<string>([
  "/config",
]);

/**
 * Worker entry point.  Routes:
 *
 * Per-proxy throttling (ProxyCoordinator DO, addressed by `idFromName(proxy_id)`):
 * - `POST /lease`   — body `{ proxy_id, intended_sleep_ms }` → grant pacing slot.
 * - `POST /report`  — body `{ proxy_id, kind, ttl_ms?, reason? }` → record
 *                     CF/failure event OR mutate ban / cf_bypass state (P1-A).
 * - `GET  /state?proxy_id=...` — debug snapshot.
 *
 * Cross-runtime login state (GlobalLoginState DO, addressed by `idFromName("global")`):
 * - `GET  /login_state`                  — current logged-in proxy + decrypted cookie.
 * - `POST /login_state/acquire_lease`    — mutex for the next re-login attempt.
 * - `POST /login_state/publish`          — publish a fresh cookie (lease holder only).
 * - `POST /login_state/invalidate`       — mark current cookie bad (optimistic version lock).
 * - `POST /login_state/release_lease`    — owner releases the re-login mutex.
 * - `POST /login_state/record_attempt`   — append a `{success|failure}` record
 *   (P2-C) to the rolling buffer used by the cooldown function.
 *
 * Cross-runner movie detail claim (MovieClaimState DO, addressed by
 * `idFromName("YYYY-MM-DD")` — per-day shard):
 * - `POST /claim_movie`    — body `{ href, holder_id, ttl_ms?, session_id?, date? }` → claim or check status.
 * - `POST /release_movie`  — body `{ href, holder_id, date? }` → relinquish a held claim.
 * - `POST /complete_movie` — body `{ href, holder_id, date? }` → mark claim done (legacy; commits immediately).
 * - `POST /stage_complete_movie`    — body `{ href, holder_id, session_id, date? }`
 *                                     → Phase-1 staged completion awaiting commit / rollback.
 * - `POST /commit_completed_movies` — body `{ session_id, date? }`
 *                                     → promote every staged entry for *session_id* to committed.
 * - `POST /rollback_staged_movies`  — body `{ session_id, date? }`
 *                                     → drop every staged entry for *session_id* (no peer impact).
 * - `GET  /sweep_orphan_stages?older_than_ms=<ms>&date=YYYY-MM-DD`
 *                                     → cron-only safety-net prune of long-orphaned stages.
 * - `POST /report_failure` — body `{ href, holder_id?, error_kind?, cooldown_ms?, date? }`
 *                            → record a failure + bump cooldown (P2-A).
 * - `GET  /movie_status?href=...&date=YYYY-MM-DD` — ops debug.
 *
 * Runner registry (RunnerRegistry DO, singleton `idFromName("runners")`, P2-E):
 * - `POST /register`       — body `{ holder_id, workflow_run_id?, workflow_name?, started_at?, proxy_pool_hash?, page_range? }`.
 * - `POST /heartbeat`      — body `{ holder_id }` → refresh `last_heartbeat`.
 * - `POST /unregister`     — body `{ holder_id }` → atexit-style removal.
 * - `GET  /active_runners` — read-only snapshot for ops dashboards.
 *
 * Liveness:
 * - `GET  /health`  — unauthenticated 200 OK probe.
 *
 * Auth: every endpoint except `/health` requires header
 * `Authorization: Bearer <PROXY_COORDINATOR_TOKEN>` (set via
 * `wrangler secret put PROXY_COORDINATOR_TOKEN`).  The same token also
 * derives the AES-GCM key used by GlobalLoginState to encrypt cookies at
 * rest, so rotating it forces the next runner to re-login (see
 * `src/global_login_state.ts`).
 */
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (!checkAuth(request, env)) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    // W5.6 — token-bucket rate limit, keyed by Bearer token. Runs AFTER
    // checkAuth so unauthenticated probes can't poison legitimate tokens'
    // buckets, and BEFORE the route switch so a depleted bucket short-
    // circuits even cheap routes.
    //
    // Uses the same header-or-query fallback as auth so the W5.1
    // dashboard's polling requests (which carry `?token=`) count against
    // the same bucket — an operator who opens the dashboard in two tabs
    // gets one bucket, not two.
    const bearerToken = extractTokenWithQueryFallback(request, url);
    const capacity = resolveRateLimitCapacity(env);
    if (bearerToken && !rateLimitAllow(bearerToken, capacity, Date.now())) {
      return jsonResponse({ error: "rate_limited" }, 429);
    }

    if (
      request.method !== "POST" &&
      !GET_ALLOWED_PATHS.has(url.pathname) &&
      !(request.method === "PATCH" && PATCH_ALLOWED_PATHS.has(url.pathname))
    ) {
      return jsonResponse({ error: "method not allowed" }, 405);
    }

    try {
      switch (url.pathname) {
        case "/lease": {
          const body = (await request.json()) as LeaseRequest;
          const proxyId = normalizeProxyId(body?.proxy_id);
          if (!proxyId) return jsonResponse({ error: "missing proxy_id" }, 400);
          return await forwardToProxyDo(env, proxyId, "/do/lease", body);
        }
        case "/report": {
          const body = (await request.json()) as ReportRequest;
          const proxyId = normalizeProxyId(body?.proxy_id);
          if (!proxyId) return jsonResponse({ error: "missing proxy_id" }, 400);
          return await forwardToProxyDo(env, proxyId, "/do/report", body);
        }
        case "/state": {
          const proxyId = normalizeProxyId(url.searchParams.get("proxy_id"));
          if (!proxyId) return jsonResponse({ error: "missing proxy_id" }, 400);
          return await forwardToProxyDo(env, proxyId, "/do/state", null);
        }
        case "/login_state":
          return await forwardToGlobalLoginStateDo(env, "/do/login_state/get", "GET", null);
        case "/login_state/acquire_lease": {
          const body = await request.json();
          return await forwardToGlobalLoginStateDo(
            env, "/do/login_state/acquire_lease", "POST", body,
          );
        }
        case "/login_state/publish": {
          const body = await request.json();
          return await forwardToGlobalLoginStateDo(
            env, "/do/login_state/publish", "POST", body,
          );
        }
        case "/login_state/invalidate": {
          const body = await request.json();
          return await forwardToGlobalLoginStateDo(
            env, "/do/login_state/invalidate", "POST", body,
          );
        }
        case "/login_state/release_lease": {
          const body = await request.json();
          return await forwardToGlobalLoginStateDo(
            env, "/do/login_state/release_lease", "POST", body,
          );
        }
        case "/login_state/record_attempt": {
          // P2-C — append a {success|failure} record into the
          // GlobalLoginState DO's rolling `recent_attempts` buffer.
          // The DO returns the post-append cooldown so the caller can
          // ack the next acquire_lease decision without an extra
          // round-trip — this matters for the cookie publisher path
          // which reports its own outcome immediately after publish().
          const body = await request.json();
          return await forwardToGlobalLoginStateDo(
            env, "/do/login_state/record_attempt", "POST", body,
          );
        }
        // ── P1-B: per-day movie claim shard (W2.2: sub-sharded by href) ─
        case "/claim_movie": {
          const body = (await request.json()) as { href?: string; date?: string };
          const shard = resolveClaimShardForHref(env, body?.date, String(body?.href ?? ""));
          return await forwardToMovieClaimDo(env, shard, "/do/claim_movie", "POST", body);
        }
        case "/release_movie": {
          const body = (await request.json()) as { href?: string; date?: string };
          const shard = resolveClaimShardForHref(env, body?.date, String(body?.href ?? ""));
          return await forwardToMovieClaimDo(env, shard, "/do/release_movie", "POST", body);
        }
        case "/complete_movie": {
          const body = (await request.json()) as { href?: string; date?: string };
          const shard = resolveClaimShardForHref(env, body?.date, String(body?.href ?? ""));
          return await forwardToMovieClaimDo(env, shard, "/do/complete_movie", "POST", body);
        }
        case "/stage_complete_movie": {
          const body = (await request.json()) as { href?: string; date?: string };
          const shard = resolveClaimShardForHref(env, body?.date, String(body?.href ?? ""));
          return await forwardToMovieClaimDo(
            env, shard, "/do/stage_complete_movie", "POST", body,
          );
        }
        case "/commit_completed_movies": {
          const body = (await request.json()) as { date?: string };
          return await fanOutToAllClaimShards(
            env, body?.date, "/do/commit_completed_movies", "POST", body,
          );
        }
        case "/rollback_staged_movies": {
          const body = (await request.json()) as { date?: string };
          return await fanOutToAllClaimShards(
            env, body?.date, "/do/rollback_staged_movies", "POST", body,
          );
        }
        case "/sweep_orphan_stages": {
          const date = url.searchParams.get("date");
          const upstreamPath = `/do/sweep_orphan_stages?${url.searchParams.toString()}`;
          return await fanOutToAllClaimShards(env, date, upstreamPath, "GET", null);
        }
        case "/report_failure": {
          const body = (await request.json()) as { href?: string; date?: string };
          const shard = resolveClaimShardForHref(env, body?.date, String(body?.href ?? ""));
          return await forwardToMovieClaimDo(env, shard, "/do/report_failure", "POST", body);
        }
        case "/movie_status": {
          const date = url.searchParams.get("date");
          const href = url.searchParams.get("href") ?? "";
          const shard = resolveClaimShardForHref(env, date, href);
          const upstreamUrl = `/do/movie_status?${url.searchParams.toString()}`;
          return await forwardToMovieClaimDo(env, shard, upstreamUrl, "GET", null);
        }
        // ── P2-E: runner registry singleton ───────────────────────────
        case "/register": {
          const body = await request.json();
          const resp = await forwardToRunnerRegistryDo(
            env, "/do/register", "POST", body,
          );
          return await embedConfigSnapshot(env, resp);
        }
        case "/heartbeat": {
          const body = await request.json();
          const resp = await forwardToRunnerRegistryDo(
            env, "/do/heartbeat", "POST", body,
          );
          return await embedConfigSnapshot(env, resp);
        }
        case "/unregister": {
          const body = await request.json();
          return await forwardToRunnerRegistryDo(env, "/do/unregister", "POST", body);
        }
        case "/active_runners":
          return await forwardToRunnerRegistryDo(env, "/do/active_runners", "GET", null);
        // W5.1 — runtime observability dashboard
        case "/dashboard":
          return new Response(renderDashboardHtml(url), {
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8",
              // Dashboard polls itself; prevent intermediaries from caching
              // a stale snapshot in case the operator hard-refreshes.
              "cache-control": "no-store",
            },
          });
        case "/ops/snapshot":
          return await aggregateOpsSnapshot(env, url);
        // W5.5 — cross-DO health aggregation; returns proxy IDs ranked
        // by their most-recent ProxyCoordinator health snapshot.
        case "/recommend_proxy":
          return await recommendProxies(env, url);
        // W5.4 — operator-pushed active signals (live in RunnerRegistry DO)
        case "/signal": {
          const body = await request.json();
          return await forwardToRunnerRegistryDo(env, "/do/signal", "POST", body);
        }
        case "/signals":
          return await forwardToRunnerRegistryDo(env, "/do/signals", "GET", null);
        // W5.3 — dynamic config singleton (ConfigState DO)
        case "/config": {
          if (request.method === "PATCH") {
            const body = await request.json();
            return await forwardToConfigStateDo(env, "/do/patch", "POST", body);
          }
          return await forwardToConfigStateDo(env, "/do/config", "GET", null);
        }
        default:
          return jsonResponse({ error: "not found" }, 404);
      }
    } catch (err) {
      // Do NOT echo the raw error message to the caller: DO handlers can
      // throw with SQL fragments, file paths, or partial cookies in the
      // exception text. Log to Workers logs (operator-only) and respond
      // with a stable opaque ``internal_error`` so external observers
      // can't probe internal state via crafted bad requests.
      const message = err instanceof Error ? err.message : String(err);
      console.error("worker fetch handler error", {
        path: url.pathname,
        method: request.method,
        error: message,
      });
      return jsonResponse({ error: "internal_error" }, 500);
    }
  },
};

function checkAuth(request: Request, env: Env): boolean {
  const token = env.PROXY_COORDINATOR_TOKEN;
  if (!token) {
    /**
     * Fail closed if no token is configured.  This avoids accidentally
     * exposing the coordinator to the public internet during a misconfigured
     * deploy.  Operators must `wrangler secret put PROXY_COORDINATOR_TOKEN`
     * before the Worker becomes usable.
     */
    return false;
  }
  const url = new URL(request.url);
  const provided = extractTokenWithQueryFallback(request, url);
  if (!provided) return false;
  return constantTimeEqual(provided, token);
}

/**
 * Return the raw Bearer token from the request, or the empty string if
 * the header is absent / malformed. Used by W5.6 rate limiting to key
 * buckets by token without coupling to `checkAuth`'s validation logic.
 */
function extractBearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return "";
  return header.slice("bearer ".length).trim();
}

/**
 * W5.1 — paths where the dashboard can pass the bearer token via a
 * `?token=` query parameter so the operator can paste a URL into a
 * browser without curl gymnastics. The token still has to match the
 * Worker secret exactly; the only thing the query alternative buys us
 * is browser-friendliness for the operator's own dashboard URL.
 *
 * Trade-off: tokens in URLs end up in browser history and Worker
 * access logs. Treat the dashboard URL as a secret bookmark; rotate
 * `PROXY_COORDINATOR_TOKEN` if it leaks.
 */
const QUERY_TOKEN_PATHS = new Set<string>([
  "/dashboard",
  "/ops/snapshot",
]);

/**
 * Like {@link extractBearerToken} but for dashboard / snapshot routes:
 * accepts either the standard ``Authorization`` header OR a ``?token=``
 * query parameter. Returns the empty string when neither is present.
 */
function extractTokenWithQueryFallback(request: Request, url: URL): string {
  const header = extractBearerToken(request);
  if (header) return header;
  if (!QUERY_TOKEN_PATHS.has(url.pathname)) return "";
  return (url.searchParams.get("token") ?? "").trim();
}

function constantTimeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function normalizeProxyId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return "";
  return trimmed;
}

async function forwardToProxyDo(
  env: Env,
  proxyId: string,
  path: string,
  body: unknown,
): Promise<Response> {
  const id = env.PROXY_DO.idFromName(proxyId);
  const stub = env.PROXY_DO.get(id);
  const init: RequestInit =
    body === null
      ? { method: "GET" }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        };
  return stub.fetch(`https://do${path}`, init);
}

/**
 * Forward to the singleton GlobalLoginState DO.  The fixed `idFromName("global")`
 * means every Worker instance / GH Actions runner converges on the same DO,
 * which is essential — a per-runner DO id would silently fragment the login
 * state and re-introduce the very problem this DO exists to solve.
 *
 * The DO response body is materialised here (``await response.text()``)
 * before being re-emitted as a fresh Response.  Streaming the original body
 * across the JSRPC boundary would leak the DO's SQLite read transaction
 * past the Worker fetch handler's await point, which `vitest-pool-workers`
 * detects as "Failed to pop isolated storage stack frame" — see
 * https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle.
 * In production the body is small (≤ 200 bytes JSON) so the buffering cost
 * is negligible.
 */
async function forwardToGlobalLoginStateDo(
  env: Env,
  path: string,
  method: "GET" | "POST",
  body: unknown,
): Promise<Response> {
  const id = env.GLOBAL_LOGIN_STATE_DO.idFromName("global");
  const stub = env.GLOBAL_LOGIN_STATE_DO.get(id);
  const init: RequestInit =
    method === "GET"
      ? { method: "GET" }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body ?? {}),
        };
  const upstream = await stub.fetch(`https://do${path}`, init);
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: upstream.headers,
  });
}

/**
 * Forward to a per-day-sharded {@link MovieClaimState} DO (P1-B).  The shard
 * key is a `YYYY-MM-DD` string in the operational time zone (Asia/Singapore,
 * mirroring `path_helper.ensure_dated_dir` on the Python side); a single
 * day's claims live in one DO instance and old shards naturally evict via
 * the Cloudflare DO LRU.
 *
 * The DO response body is buffered through ``await text()`` before being
 * re-emitted, mirroring `forwardToGlobalLoginStateDo` — see that function's
 * comment for why streaming would break vitest-pool-workers' isolated
 * storage stack-frame cleanup.
 *
 * Returns a 503 when the binding is missing (i.e. the v3 migration has not
 * been applied yet) so the Python client treats it as ``Unavailable`` and
 * falls open to local-only behaviour.
 */
async function forwardToMovieClaimDo(
  env: Env,
  shardId: string,
  path: string,
  method: "GET" | "POST",
  body: unknown,
): Promise<Response> {
  if (!env.MOVIE_CLAIM_DO) {
    return jsonResponse(
      { error: "movie_claim_state binding not configured (apply v3 migration)" },
      503,
    );
  }
  const id = env.MOVIE_CLAIM_DO.idFromName(shardId);
  const stub = env.MOVIE_CLAIM_DO.get(id);
  const init: RequestInit =
    method === "GET"
      ? { method: "GET" }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body ?? {}),
        };
  const upstream = await stub.fetch(`https://do${path}`, init);
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: upstream.headers,
  });
}

/**
 * Compute the per-day shard ID for a `MovieClaimState` request.  Accepts an
 * explicit `YYYY-MM-DD` from the caller (mandatory when crossing day
 * boundaries within a long-running ingestion — the caller passes the *task
 * dispatch time* date so the same movie always maps to the same shard) and
 * falls back to the Worker's current time in Asia/Singapore.
 *
 * Returns the bare date string; the Asia/Singapore tz is implicit and stays
 * out of the shard ID to keep DO names compact (Cloudflare caps `idFromName`
 * at 256 chars but recommends much shorter for log readability).
 */
/**
 * Forward to the singleton {@link RunnerRegistry} DO (P2-E).  The fixed
 * `idFromName("runners")` collapses every Worker / runner to one DO so a
 * register/heartbeat from any runtime joins the same registry.
 *
 * Body buffering mirrors `forwardToGlobalLoginStateDo` / `forwardToMovieClaimDo`
 * for the same vitest-pool-workers reason — see those functions' comments.
 *
 * Returns 503 when the binding is missing (i.e. v3 migration not yet
 * deployed to register the `RunnerRegistry` class).  The Python client
 * treats 503 as ``Unavailable`` and falls open to "no registry, no
 * heartbeat", so a stale Worker deploy is graceful rather than fatal.
 */
async function forwardToRunnerRegistryDo(
  env: Env,
  path: string,
  method: "GET" | "POST",
  body: unknown,
): Promise<Response> {
  if (!env.RUNNER_REGISTRY_DO) {
    return jsonResponse(
      { error: "runner_registry binding not configured (apply v3 migration)" },
      503,
    );
  }
  const id = env.RUNNER_REGISTRY_DO.idFromName("runners");
  const stub = env.RUNNER_REGISTRY_DO.get(id);
  const init: RequestInit =
    method === "GET"
      ? { method: "GET" }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body ?? {}),
        };
  const upstream = await stub.fetch(`https://do${path}`, init);
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: upstream.headers,
  });
}

/**
 * W5.3 — proxy a request to the singleton ConfigState DO.
 *
 * Returns 503 when the binding is missing (v4 migration not yet applied),
 * mirroring the runner-registry fallback path: clients treat 503 as
 * "config DO unavailable, use env-var defaults" and continue.
 */
async function forwardToConfigStateDo(
  env: Env,
  path: string,
  method: "GET" | "POST",
  body: unknown,
): Promise<Response> {
  if (!env.CONFIG_STATE_DO) {
    return jsonResponse(
      { error: "config_state binding not configured (apply v4 migration)" },
      503,
    );
  }
  const id = env.CONFIG_STATE_DO.idFromName("global-config");
  const stub = env.CONFIG_STATE_DO.get(id);
  const init: RequestInit =
    method === "GET"
      ? { method: "GET" }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body ?? {}),
        };
  const upstream = await stub.fetch(`https://do${path}`, init);
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: upstream.headers,
  });
}

/**
 * W5.3 — embed the current ConfigState snapshot into a register / heartbeat
 * response so runners pull config without a separate round-trip.
 *
 * Fail-open: if the config DO is unavailable or returns a malformed
 * snapshot, the original response passes through unchanged (clients fall
 * back to env-var defaults). The registry response is the runner's
 * critical path — a config DO outage MUST NOT break heartbeating.
 */
async function embedConfigSnapshot(env: Env, resp: Response): Promise<Response> {
  if (!env.CONFIG_STATE_DO) return resp;
  // Only embed on 2xx responses; 4xx/5xx from the registry already encode
  // a different failure mode and the client should not see a mixed payload.
  if (resp.status >= 300) return resp;
  // Parse the registry payload first so we can fail-open if it isn't JSON.
  let registryBody: Record<string, unknown>;
  try {
    registryBody = (await resp.json()) as Record<string, unknown>;
  } catch {
    return resp;
  }
  try {
    const id = env.CONFIG_STATE_DO.idFromName("global-config");
    const stub = env.CONFIG_STATE_DO.get(id);
    const configResp = await stub.fetch(
      "https://do/do/config", { method: "GET" },
    );
    if (configResp.status === 200) {
      const snap = (await configResp.json()) as ConfigSnapshot & {
        server_time?: number;
      };
      // Strip server_time before embedding — the registry's own
      // server_time is authoritative for the merged response.
      const { server_time: _unused, ...config } = snap;
      void _unused;
      registryBody.config = config;
    }
  } catch (err) {
    // Swallow any error: heartbeat must succeed even if config DO is down.
    console.warn("embedConfigSnapshot failed; serving registry-only payload", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return jsonResponse(registryBody, resp.status);
}

/**
 * W5.1 — aggregate live state across every DO into a single JSON
 * snapshot the dashboard SPA can render in one round-trip.
 *
 * Proxy enumeration:
 *   The ProxyCoordinator DO is addressed per-id (`idFromName(proxy_id)`);
 *   there is no master "list of known proxies" registry. The operator
 *   passes the proxy IDs they care about via `?proxy_ids=a,b,c` (comma
 *   separated, max 32). Empty query → snapshot omits the proxies block
 *   (the dashboard SPA shows a hint).
 *
 * Privacy:
 *   Deliberately omits `GlobalLoginState` — the cookie inside it must
 *   NEVER ride along in a dashboard payload (the token-in-URL workflow
 *   exposes the snapshot to browser history + server logs). Operators
 *   needing to inspect login state should use `GET /login_state` with
 *   the standard header auth.
 *
 * Fail-open: each sub-fetch is independent; a single DO timing out
 * surfaces as `null` in its slot rather than failing the whole snapshot.
 */
async function aggregateOpsSnapshot(env: Env, url: URL): Promise<Response> {
  const rawIds = (url.searchParams.get("proxy_ids") ?? "").trim();
  // Cap at 32 to bound the fan-out fan-in fan-cost; ops dashboards
  // monitor a handful of proxies at a time, not entire blast radius.
  const proxyIds = rawIds
    ? rawIds
        .split(",")
        .map((s) => normalizeProxyId(s.trim()))
        .filter((s) => s !== "")
        .slice(0, 32)
    : [];

  const now = Date.now();

  // Fan out in parallel; each promise resolves to a `{ ok, data }` shape
  // so one failure can't poison Promise.all.
  const [runners, signals, config, proxies] = await Promise.all([
    snapshotFromRegistry(env, "/do/active_runners"),
    snapshotFromRegistry(env, "/do/signals"),
    snapshotFromConfigState(env),
    snapshotProxies(env, proxyIds),
  ]);

  return jsonResponse({
    server_time: now,
    runners,
    signals,
    config,
    proxies,
    // Echo back so the SPA can rebuild the query for refresh links.
    queried_proxy_ids: proxyIds,
  });
}

async function snapshotFromRegistry(
  env: Env,
  path: string,
): Promise<unknown> {
  if (!env.RUNNER_REGISTRY_DO) return null;
  try {
    const id = env.RUNNER_REGISTRY_DO.idFromName("runners");
    const stub = env.RUNNER_REGISTRY_DO.get(id);
    const r = await stub.fetch(`https://do${path}`, { method: "GET" });
    if (r.status !== 200) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function snapshotFromConfigState(env: Env): Promise<unknown> {
  if (!env.CONFIG_STATE_DO) return null;
  try {
    const id = env.CONFIG_STATE_DO.idFromName("global-config");
    const stub = env.CONFIG_STATE_DO.get(id);
    const r = await stub.fetch("https://do/do/config", { method: "GET" });
    if (r.status !== 200) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function snapshotProxies(
  env: Env,
  proxyIds: string[],
): Promise<Array<Record<string, unknown>>> {
  if (proxyIds.length === 0) return [];
  const results = await Promise.all(
    proxyIds.map(async (proxyId) => {
      try {
        const id = env.PROXY_DO.idFromName(proxyId);
        const stub = env.PROXY_DO.get(id);
        const r = await stub.fetch("https://do/do/state", { method: "GET" });
        if (r.status !== 200) {
          return { proxy_id: proxyId, error: `status_${r.status}` };
        }
        const data = (await r.json()) as Record<string, unknown>;
        return { proxy_id: proxyId, ...data };
      } catch (err) {
        return {
          proxy_id: proxyId,
          error: err instanceof Error ? err.message : "fetch_failed",
        };
      }
    }),
  );
  return results;
}

/**
 * W5.5 — rank the supplied proxy IDs by their most-recent
 * ProxyCoordinator health snapshot and return the top-N for selection.
 *
 * Query params:
 *   proxy_ids (required) — comma-separated list, capped at 32.
 *   top_n (optional)     — return only the top N; default = all.
 *   include_unhealthy    — set to "1" to include banned / errored
 *                          proxies in the response (still ranked last).
 *                          Default omits them so the caller can blindly
 *                          take recommendations[0] without checking.
 *
 * Ranking:
 *   1. health.score descending (higher = better)
 *   2. health.latency_ema_ms ascending (faster = better) for ties
 *   3. proxy_id ascending for fully-stable tie-break
 *
 * Returns ``recommendations: []`` (not a 400) when no proxy_ids are
 * supplied so a misconfigured client fails open. Unreachable DOs / no
 * health data yet → score defaults to 0.5 (neutral) so an
 * unseen-but-configured proxy gets some traffic instead of being
 * excluded entirely.
 */
async function recommendProxies(env: Env, url: URL): Promise<Response> {
  const rawIds = (url.searchParams.get("proxy_ids") ?? "").trim();
  const proxyIds = rawIds
    ? rawIds
        .split(",")
        .map((s) => normalizeProxyId(s.trim()))
        .filter((s) => s !== "")
        .slice(0, 32)
    : [];
  const topNRaw = parseInt(url.searchParams.get("top_n") ?? "", 10);
  const topN =
    Number.isFinite(topNRaw) && topNRaw > 0 ? topNRaw : proxyIds.length;
  const includeUnhealthy = url.searchParams.get("include_unhealthy") === "1";

  if (proxyIds.length === 0) {
    return jsonResponse({
      recommendations: [],
      queried_proxy_ids: [],
      server_time: Date.now(),
    });
  }

  const states = await snapshotProxies(env, proxyIds);

  interface Recommendation {
    proxy_id: string;
    score: number;
    latency_ema_ms: number;
    success_count: number;
    failure_count: number;
    banned: boolean;
    requires_cf_bypass: boolean;
    available: boolean;
  }

  const ranked: Recommendation[] = states.map((s) => {
    const banned = Boolean(s.banned);
    const requires_cf_bypass = Boolean(s.requires_cf_bypass);
    const healthy = !s.error && !banned;
    // ``health`` is the ProxyHealthSnapshot computed by the DO; missing
    // when the proxy has not yet been leased or returned an error.
    const h =
      typeof s.health === "object" && s.health !== null
        ? (s.health as {
            score?: number;
            latency_ema_ms?: number;
            success_count?: number;
            failure_count?: number;
          })
        : null;
    const score = clampNumber(h?.score, 0.5, 0, 1);
    return {
      proxy_id: String(s.proxy_id),
      score: banned ? -1 : score,
      latency_ema_ms: clampNumber(h?.latency_ema_ms, 0, 0, 60_000),
      success_count: clampNumber(h?.success_count, 0, 0, Number.MAX_SAFE_INTEGER),
      failure_count: clampNumber(h?.failure_count, 0, 0, Number.MAX_SAFE_INTEGER),
      banned,
      requires_cf_bypass,
      available: healthy,
    };
  });

  ranked.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.latency_ema_ms !== b.latency_ema_ms) {
      return a.latency_ema_ms - b.latency_ema_ms;
    }
    return a.proxy_id.localeCompare(b.proxy_id);
  });

  const filtered = includeUnhealthy
    ? ranked
    : ranked.filter((r) => r.available);

  return jsonResponse({
    recommendations: filtered.slice(0, topN),
    queried_proxy_ids: proxyIds,
    server_time: Date.now(),
  });
}

function clampNumber(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * W5.1 — render the dashboard HTML. Self-contained: inline CSS + vanilla
 * JS, no CDN dependencies (Workers Free deployments behind operator
 * firewalls shouldn't need to phone home to a CDN to render an ops
 * panel). Reads the bearer token from the same `?token=` query that
 * loaded this page and reuses it for snapshot polling.
 *
 * Stays under ~6 KB so the response is one TCP frame even cold-start.
 */
function renderDashboardHtml(url: URL): string {
  const token = url.searchParams.get("token") ?? "";
  const proxyIdsRaw = url.searchParams.get("proxy_ids") ?? "";
  // JSON-safe embedding — escape the token only so it can't break the
  // string literal in the inline script. The query already had to match
  // the Bearer secret so this isn't a security boundary, just a
  // string-injection guard.
  const tokenJs = JSON.stringify(token);
  const proxyIdsJs = JSON.stringify(proxyIdsRaw);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>proxy-coordinator dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; margin: 0; background:#0f1115; color:#d6d8df; }
  header { padding: 14px 20px; background:#1a1d24; border-bottom:1px solid #272a31; display:flex; justify-content:space-between; align-items:center; }
  header h1 { margin:0; font-size:16px; font-weight:600; }
  header .status { font-size:12px; color:#8b8f97; }
  main { padding: 16px 20px 32px; max-width: 1280px; margin: 0 auto; }
  section { margin-top:24px; }
  section h2 { font-size:13px; text-transform:uppercase; letter-spacing:0.05em; color:#8b8f97; margin:0 0 8px; }
  table { width:100%; border-collapse:collapse; font-size:13px; background:#161920; border:1px solid #272a31; border-radius:6px; overflow:hidden; }
  th, td { padding:8px 10px; text-align:left; border-bottom:1px solid #272a31; }
  th { background:#1a1d24; font-weight:600; color:#a8acb5; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; }
  tr:last-child td { border-bottom:none; }
  td.muted { color:#8b8f97; }
  td.warn { color:#f7c873; }
  td.bad { color:#f47174; }
  td.ok { color:#7fc88c; }
  .empty { padding:14px; color:#8b8f97; font-style:italic; }
  .hint { background:#1a1d24; border:1px solid #272a31; border-radius:6px; padding:14px; color:#8b8f97; font-size:13px; }
  code { background:#0a0c10; padding:1px 5px; border-radius:3px; color:#d6d8df; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style></head>
<body>
<header>
  <h1>proxy-coordinator dashboard</h1>
  <div class="status"><span id="state">loading…</span> · refresh every 30 s · <span id="ts"></span></div>
</header>
<main>
  <section><h2>Active runners</h2><div id="runners"><div class="empty">no data yet</div></div></section>
  <section><h2>Active signals (W5.4)</h2><div id="signals"><div class="empty">no data yet</div></div></section>
  <section><h2>Config snapshot (W5.3)</h2><div id="config"><div class="empty">no data yet</div></div></section>
  <section><h2>Per-proxy state</h2><div id="proxies"><div class="empty">no data yet</div></div></section>
</main>
<script>
(function(){
  var TOKEN = ${tokenJs};
  var PROXY_IDS = ${proxyIdsJs};
  var REFRESH_MS = 30000;
  var stateEl = document.getElementById("state");
  var tsEl = document.getElementById("ts");

  function fmtTs(ms){ if(!ms) return "—"; var d = new Date(ms); return d.toISOString().replace("T"," ").slice(0,19) + " UTC"; }
  function escapeHtml(s){ return String(s).replace(/[&<>\"']/g, function(c){ return ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"})[c]; }); }
  function fmtAge(ms, nowMs){ if(!ms) return "—"; var s = Math.max(0,(nowMs-ms)/1000); if(s<60) return s.toFixed(0)+"s"; if(s<3600) return (s/60).toFixed(1)+"m"; return (s/3600).toFixed(1)+"h"; }

  function renderRunners(data, nowMs){
    if(!data || !data.active_runners) return '<div class="empty">registry unavailable</div>';
    var rows = data.active_runners;
    if(rows.length === 0) return '<div class="empty">no live runners</div>';
    var head = '<tr><th>holder_id</th><th>workflow</th><th>started</th><th>last heartbeat</th><th>pool hash</th><th>page range</th></tr>';
    var body = rows.map(function(r){
      var lastHb = fmtAge(r.last_heartbeat, nowMs);
      var lastCls = r.last_heartbeat && (nowMs - r.last_heartbeat) > 120000 ? "warn" : "ok";
      return '<tr>'
        + '<td><code>'+escapeHtml(r.holder_id)+'</code></td>'
        + '<td class="muted">'+escapeHtml(r.workflow_name||"—")+'</td>'
        + '<td class="muted">'+fmtAge(r.started_at, nowMs)+' ago</td>'
        + '<td class="'+lastCls+'">'+lastHb+' ago</td>'
        + '<td><code>'+escapeHtml((r.proxy_pool_hash||"").slice(0,12))+'</code></td>'
        + '<td class="muted">'+escapeHtml(r.page_range||"—")+'</td>'
        + '</tr>';
    }).join("");
    return '<table>'+head+body+'</table>';
  }

  function renderSignals(data, nowMs){
    if(!data || !data.active_signals) return '<div class="empty">registry unavailable</div>';
    var rows = data.active_signals;
    if(rows.length === 0) return '<div class="empty">no signals active (cohort is healthy)</div>';
    var head = '<tr><th>id</th><th>kind</th><th>payload</th><th>expires</th><th>reason</th></tr>';
    var body = rows.map(function(s){
      var payload = s.kind === "throttle_global" ? ("factor="+s.factor) : s.kind === "ban_proxy" ? ("proxy_id="+s.proxy_id) : "—";
      var exp = fmtAge(s.expires_at_ms, nowMs);
      var expCls = s.expires_at_ms && (s.expires_at_ms - nowMs) < 60000 ? "warn" : "bad";
      return '<tr>'
        + '<td><code>'+escapeHtml(s.id)+'</code></td>'
        + '<td class="'+(s.kind === "pause_all" ? "bad" : "warn")+'">'+escapeHtml(s.kind)+'</td>'
        + '<td>'+escapeHtml(payload)+'</td>'
        + '<td class="'+expCls+'">in '+exp+'</td>'
        + '<td class="muted">'+escapeHtml(s.reason||"—")+'</td>'
        + '</tr>';
    }).join("");
    return '<table>'+head+body+'</table>';
  }

  function renderConfig(data){
    if(!data) return '<div class="empty">config-state DO unavailable</div>';
    var entries = Object.entries(data.values||{});
    var meta = '<div class="hint">version <code>'+escapeHtml(String(data.version||0))+'</code> · updated '+fmtTs(data.updated_at)+'</div>';
    if(entries.length === 0) return meta + '<div class="empty">no operator overrides — all values use env-var defaults</div>';
    var head = '<tr><th>key</th><th>value</th></tr>';
    var body = entries.map(function(kv){ return '<tr><td><code>'+escapeHtml(kv[0])+'</code></td><td>'+escapeHtml(kv[1])+'</td></tr>'; }).join("");
    return meta + '<table style="margin-top:8px">'+head+body+'</table>';
  }

  function renderProxies(rows){
    if(!rows || rows.length === 0){
      return '<div class="hint">No proxy IDs supplied. Add <code>?proxy_ids=Proxy-1,Proxy-2</code> to the URL to enumerate per-proxy throttle state.</div>';
    }
    var head = '<tr><th>proxy_id</th><th>wait until</th><th>banned</th><th>cf bypass</th><th>events</th></tr>';
    var body = rows.map(function(p){
      if(p.error){
        return '<tr><td><code>'+escapeHtml(p.proxy_id)+'</code></td><td class="bad" colspan="4">error: '+escapeHtml(p.error)+'</td></tr>';
      }
      var banned = p.banned ? '<span class="bad">yes</span>' : '<span class="muted">no</span>';
      var cfBp = p.requires_cf_bypass ? '<span class="warn">required</span>' : '<span class="muted">no</span>';
      var nextWait = p.nextAvailableAt ? Math.max(0, p.nextAvailableAt - Date.now())+"ms" : "—";
      var cfEventCount = (p.cfEvents && p.cfEvents.length) || 0;
      return '<tr>'
        + '<td><code>'+escapeHtml(p.proxy_id)+'</code></td>'
        + '<td class="muted">'+escapeHtml(nextWait)+'</td>'
        + '<td>'+banned+'</td>'
        + '<td>'+cfBp+'</td>'
        + '<td class="muted">'+escapeHtml(String(cfEventCount))+'</td>'
        + '</tr>';
    }).join("");
    return '<table>'+head+body+'</table>';
  }

  function refresh(){
    var url = "/ops/snapshot?token="+encodeURIComponent(TOKEN);
    if(PROXY_IDS) url += "&proxy_ids="+encodeURIComponent(PROXY_IDS);
    stateEl.textContent = "polling…";
    fetch(url).then(function(r){
      if(r.status !== 200) throw new Error("HTTP "+r.status);
      return r.json();
    }).then(function(data){
      var nowMs = data.server_time || Date.now();
      document.getElementById("runners").innerHTML = renderRunners(data.runners, nowMs);
      document.getElementById("signals").innerHTML = renderSignals(data.signals, nowMs);
      document.getElementById("config").innerHTML = renderConfig(data.config);
      document.getElementById("proxies").innerHTML = renderProxies(data.proxies);
      stateEl.textContent = "live";
      tsEl.textContent = fmtTs(nowMs);
    }).catch(function(err){
      stateEl.textContent = "error: "+err.message;
    });
  }
  refresh();
  setInterval(refresh, REFRESH_MS);
})();
</script>
</body></html>`;
}

function resolveClaimShard(rawDate?: string | null): string {
  const cleaned =
    rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate.trim())
      ? rawDate.trim()
      : currentSingaporeDate();
  return cleaned;
}

const DEFAULT_NUM_CLAIM_SHARDS = 4;

function getNumClaimShards(env: Env): number {
  const n = parseInt(env.NUM_CLAIM_SHARDS || "", 10);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_NUM_CLAIM_SHARDS;
}

function hrefShardIndex(href: string, numShards: number): number {
  let h = 0;
  for (let i = 0; i < href.length; i++) {
    h = ((h << 5) - h + href.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % numShards;
}

function resolveClaimShardForHref(
  env: Env,
  rawDate: string | undefined | null,
  href: string,
): string {
  const n = getNumClaimShards(env);
  if (n <= 1) return resolveClaimShard(rawDate);
  return `${resolveClaimShard(rawDate)}-${hrefShardIndex(href, n)}`;
}

async function fanOutToAllClaimShards(
  env: Env,
  rawDate: string | undefined | null,
  path: string,
  method: "GET" | "POST",
  body: unknown,
): Promise<Response> {
  const n = getNumClaimShards(env);
  const baseShard = resolveClaimShard(rawDate);
  const shardIds =
    n <= 1
      ? [baseShard]
      : [baseShard, ...Array.from({ length: n }, (_, i) => `${baseShard}-${i}`)];
  const responses = await Promise.all(
    shardIds.map((id) =>
      forwardToMovieClaimDo(env, id, path, method, body),
    ),
  );
  for (const r of responses) {
    if (r.status >= 400) return r;
  }
  const dataArr = await Promise.all(
    responses.map((r) => r.json() as Promise<Record<string, unknown>>),
  );
  const merged: Record<string, unknown> = {};
  let maxServerTime = 0;
  for (const data of dataArr) {
    for (const [key, val] of Object.entries(data)) {
      if (key === "server_time") {
        maxServerTime = Math.max(maxServerTime, Number(val) || 0);
      } else if (typeof val === "number") {
        merged[key] = ((merged[key] as number) || 0) + val;
      } else if (!(key in merged)) {
        merged[key] = val;
      }
    }
  }
  merged.server_time = maxServerTime;
  return jsonResponse(merged);
}

function currentSingaporeDate(): string {
  // Asia/Singapore is UTC+08:00 and DST-free, so a fixed offset is exact.
  // Avoiding `Intl.DateTimeFormat` here keeps the path allocator-free and
  // sidesteps a workerd IANA tz-data dependency.
  const now = new Date(Date.now() + 8 * 60 * 60_000);
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
