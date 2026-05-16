import { ConfigSnapshot, Env, LeaseRequest, ReportRequest } from "./types";

export { ProxyCoordinator } from "./proxy_coordinator";
export { GlobalLoginState } from "./global_login_state";
export { MovieClaimState } from "./movie_claim_state";
export { RunnerRegistry } from "./runner_registry";
export { ConfigState } from "./config_state";
export { WorkDistributor } from "./work_distributor";
export { MetricsState } from "./metrics_state";

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
  "/signals/history",
  "/runners/history",
  "/dashboard",
  "/ops/snapshot",
  "/recommend_proxy",
  "/work/stats",
  "/metrics/range",
  "/proxies_seen",
]);

/** W5.3 — extra non-POST/non-GET methods allowed on specific routes. */
const PATCH_ALLOWED_PATHS = new Set<string>([
  "/config",
]);

/** Phase 2 / ADR-004 — DELETE-allowed routes for ops cleanup. */
const DELETE_ALLOWED_PATHS = new Set<string>([
  "/proxies_seen",
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

    // ── W5.1 dashboard public surface ────────────────────────────────────
    // The login form + login POST are intentionally pre-auth: they ARE
    // the dashboard auth gate. `/` and `/dashboard` render either the
    // login form (no valid cookie) or the dashboard (valid cookie).
    if (DASHBOARD_PUBLIC_PATHS.has(url.pathname)) {
      return await handleDashboardPublic(request, env, url);
    }
    if (url.pathname === "/dashboard/logout") {
      return handleDashboardLogout();
    }

    // ── Standard auth (Bearer header OR dashboard cookie) ────────────────
    const cookieAuth =
      COOKIE_AUTH_PATHS.has(url.pathname) &&
      (await verifyDashboardCookie(
        env,
        readCookie(request, DASHBOARD_COOKIE_NAME),
      ));
    if (!cookieAuth && !checkAuth(request, env)) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    // W5.6 — token-bucket rate limit. Runs AFTER auth so unauthenticated
    // probes can't poison legitimate tokens' buckets, and BEFORE the
    // route switch so a depleted bucket short-circuits cheap routes.
    //
    // Bucket key: the Bearer token if present (machine-to-machine
    // workflow), or the literal "dashboard" sentinel for cookie-authed
    // requests — operator polling at 30 s is well under any sane limit
    // but we still want it metered so a runaway dashboard tab is
    // visible in metrics.
    const bucketKey = extractBearerToken(request) || (cookieAuth ? "dashboard" : "");
    const capacity = resolveRateLimitCapacity(env);
    if (bucketKey && !rateLimitAllow(bucketKey, capacity, Date.now())) {
      return jsonResponse({ error: "rate_limited" }, 429);
    }

    if (
      request.method !== "POST" &&
      !GET_ALLOWED_PATHS.has(url.pathname) &&
      !(request.method === "PATCH" && PATCH_ALLOWED_PATHS.has(url.pathname)) &&
      !(request.method === "DELETE" && DELETE_ALLOWED_PATHS.has(url.pathname))
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
        // W5.1 — runtime observability snapshot consumed by /dashboard
        // SPA (cookie-authed) AND by external monitoring scripts
        // (Bearer-authed). /dashboard + / are served pre-switch by
        // handleDashboardPublic so they can also render the login form.
        case "/ops/snapshot":
          return await aggregateOpsSnapshot(env, url);
        // W5.5 — cross-DO health aggregation; returns proxy IDs ranked
        // by their most-recent ProxyCoordinator health snapshot.
        case "/recommend_proxy":
          return await recommendProxies(env, url);
        // W5.2 — WorkDistributor singleton (deduplicated work queue with
        // visibility leases). All four mutating routes are POSTs; /work/stats
        // is the read-only ops endpoint.
        case "/work/enqueue": {
          const body = await request.json();
          return await forwardToWorkDistributorDo(env, "/do/work/enqueue", "POST", body);
        }
        case "/work/pull": {
          const body = await request.json();
          return await forwardToWorkDistributorDo(env, "/do/work/pull", "POST", body);
        }
        case "/work/complete": {
          const body = await request.json();
          return await forwardToWorkDistributorDo(env, "/do/work/complete", "POST", body);
        }
        case "/work/release": {
          const body = await request.json();
          return await forwardToWorkDistributorDo(env, "/do/work/release", "POST", body);
        }
        case "/work/stats":
          return await forwardToWorkDistributorDo(env, "/do/work/stats", "GET", null);
        // W5.4 — operator-pushed active signals (live in RunnerRegistry DO)
        case "/signal": {
          const body = await request.json();
          return await forwardToRunnerRegistryDo(env, "/do/signal", "POST", body);
        }
        case "/signals":
          return await forwardToRunnerRegistryDo(env, "/do/signals", "GET", null);
        // Phase 2 / ADR-002 — event log history endpoints
        case "/signals/history":
          return await forwardToRunnerRegistryDo(
            env,
            "/do/signals/history?" + url.searchParams.toString(),
            "GET",
            null,
          );
        case "/runners/history":
          return await forwardToRunnerRegistryDo(
            env,
            "/do/runners/history?" + url.searchParams.toString(),
            "GET",
            null,
          );
        // Phase 2 / ADR-004 — proxies_seen: enumerable proxy roster
        case "/proxies_seen":
          return await forwardToRunnerRegistryDo(
            env,
            "/do/proxies_seen?" + url.searchParams.toString(),
            request.method as "GET" | "DELETE",
            null,
          );
        // W5.3 — dynamic config singleton (ConfigState DO)
        case "/config": {
          if (request.method === "PATCH") {
            const body = await request.json();
            return await forwardToConfigStateDo(env, "/do/patch", "POST", body);
          }
          return await forwardToConfigStateDo(env, "/do/config", "GET", null);
        }
        // W5.7 / ADR-003 — MetricsState DO
        case "/metrics/record": {
          const body = await request.json();
          return await forwardToMetricsStateDo(env, "/do/metrics/record", "POST", body);
        }
        case "/metrics/range":
          return await forwardToMetricsStateDo(
            env, `/do/metrics/range?${url.searchParams.toString()}`, "GET", null,
          );
        case "/metrics/prune": {
          const body = await request.json();
          return await forwardToMetricsStateDo(env, "/do/metrics/prune", "POST", body);
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
  const provided = extractBearerToken(request);
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
 * W5.1 — paths where the dashboard cookie alone (no Bearer header)
 * satisfies authentication. The cookie is HMAC-signed against
 * ``PROXY_COORDINATOR_TOKEN`` and only issued after a successful
 * password login at ``POST /dashboard/login`` (`DASHBOARD_PASSWORD`
 * secret). External monitoring scripts hitting these same paths can
 * still use the standard ``Authorization: Bearer`` header.
 */
const COOKIE_AUTH_PATHS = new Set<string>([
  "/",
  "/dashboard",
  "/ops/snapshot",
  "/recommend_proxy",
  "/signals/history",
  "/runners/history",
  "/dashboard/logout",
]);

/** Routes inside ``/dashboard/*`` that bypass the normal auth gate
 *  because they ARE the auth gate. ``/dashboard/login`` accepts a
 *  password POST; ``/`` and ``/dashboard`` either render the login
 *  form (no cookie) or the dashboard (valid cookie) inline. */
const DASHBOARD_PUBLIC_PATHS = new Set<string>([
  "/",
  "/dashboard",
  "/dashboard/login",
]);

const DASHBOARD_COOKIE_NAME = "dashboard_session";
const DASHBOARD_DEFAULT_SESSION_TTL_SEC = 8 * 60 * 60; // 8 h

/**
 * HMAC-SHA256 sign a payload with the Worker's main token as the key.
 * Returns the signature as a lowercase hex string.
 */
async function hmacSign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return arrayBufferToHex(sig);
}

function arrayBufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Build a dashboard session cookie value of the form
 * ``<expiry_ms>.<hex_signature>``. The signature commits to a
 * versioned label + the expiry so neither field can be modified
 * without invalidating the cookie.
 */
async function buildDashboardCookie(env: Env, ttlSec: number): Promise<string> {
  const exp = Date.now() + ttlSec * 1000;
  const sig = await hmacSign(
    env.PROXY_COORDINATOR_TOKEN,
    `dashboard_session_v1:${exp}`,
  );
  return `${exp}.${sig}`;
}

/**
 * Verify a dashboard session cookie. Returns true iff:
 *   - it parses as ``<int>.<hex>``;
 *   - the expiry is in the future;
 *   - the signature matches when recomputed with the current token.
 *
 * Constant-time equality protects against timing-side-channel attacks
 * on the signature half. Returns false on every failure mode so the
 * caller doesn't need to differentiate between "no cookie" and "bad
 * cookie".
 */
async function verifyDashboardCookie(
  env: Env,
  rawCookie: string,
): Promise<boolean> {
  if (!rawCookie) return false;
  const dot = rawCookie.indexOf(".");
  if (dot <= 0) return false;
  const expStr = rawCookie.slice(0, dot);
  const providedSig = rawCookie.slice(dot + 1);
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp <= Date.now()) return false;
  let expectedSig: string;
  try {
    expectedSig = await hmacSign(
      env.PROXY_COORDINATOR_TOKEN,
      `dashboard_session_v1:${exp}`,
    );
  } catch {
    return false;
  }
  return constantTimeEqual(providedSig, expectedSig);
}

/** Read one cookie value from the request's ``Cookie:`` header.
 *  Returns the empty string when the header is missing or the named
 *  cookie isn't present. Defensive parse — does not pull in a full
 *  cookie library. */
function readCookie(request: Request, name: string): string {
  const header = request.headers.get("cookie") ?? "";
  if (!header) return "";
  const parts = header.split(";");
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return "";
}

function resolveDashboardSessionTtlSec(env: Env): number {
  const raw = env.DASHBOARD_SESSION_TTL_SEC;
  if (!raw) return DASHBOARD_DEFAULT_SESSION_TTL_SEC;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 60) return DASHBOARD_DEFAULT_SESSION_TTL_SEC;
  // Hard ceiling at 30 days so an accidentally-large value can't keep a
  // stale session alive forever.
  return Math.min(n, 30 * 24 * 60 * 60);
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
  method: "GET" | "POST" | "DELETE",
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
    method === "GET" || method === "DELETE"
      ? { method }
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
 * W5.2 — proxy a request to the singleton WorkDistributor DO.
 *
 * Returns 503 when the binding is missing (v5 migration not yet applied),
 * mirroring the runner-registry / config-state fallback path: clients
 * treat 503 as "work queue not available" and either fall back to local
 * dispatch or fail fast.
 */
async function forwardToWorkDistributorDo(
  env: Env,
  path: string,
  method: "GET" | "POST",
  body: unknown,
): Promise<Response> {
  if (!env.WORK_DISTRIBUTOR_DO) {
    return jsonResponse(
      { error: "work_distributor binding not configured (apply v5 migration)" },
      503,
    );
  }
  const id = env.WORK_DISTRIBUTOR_DO.idFromName("global-work");
  const stub = env.WORK_DISTRIBUTOR_DO.get(id);
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
 * W5.1 — dispatch the dashboard's public surface (no Bearer header
 * required because we ARE the auth gate). Renders the login form when
 * the dashboard session cookie is absent / invalid; renders the
 * dashboard SPA when the cookie verifies.
 *
 * Three routes flow through here:
 *   - GET  /                  — root domain alias for /dashboard
 *   - GET  /dashboard         — explicit dashboard route
 *   - POST /dashboard/login   — password form submission
 */
async function handleDashboardPublic(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (
    url.pathname === "/dashboard/login" &&
    request.method === "POST"
  ) {
    return await handleDashboardLogin(request, env, url);
  }
  if (request.method !== "GET") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const cookie = readCookie(request, DASHBOARD_COOKIE_NAME);
  const valid = await verifyDashboardCookie(env, cookie);
  const html = valid
    ? renderDashboardHtml(url)
    : renderLoginHtml(url, env, undefined);
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // Browsers should never see this rendered inside a frame on another
      // origin — defence-in-depth against clickjacking attacks against
      // the login form.
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    },
  });
}

/**
 * Process a password submission. Accepts either application/json
 * (``{password: ...}``) or application/x-www-form-urlencoded
 * (``password=...``) so a no-JS browser submission still works.
 *
 * On success: redirect to /, with the signed session cookie.
 * On failure: re-render the login form with an inline error.
 *
 * Two failure modes are surfaced verbatim ("invalid password",
 * "dashboard not configured") because they correspond to operator
 * misconfiguration; the response itself is constant-status (200) so
 * automated scrapers can't easily distinguish them, and the 1-second
 * sleep on every failure path bounds brute-force throughput.
 */
async function handleDashboardLogin(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const errorRender = async (msg: string): Promise<Response> => {
    // Burn ~750 ms on every failed login to cap brute-force throughput
    // to ~80 attempts/minute even from a single isolate. Combined with
    // W5.6 rate-limit (1000 req/min keyed by "dashboard"), an attacker
    // gets at most ~1000/min total before being throttled.
    await new Promise((r) => setTimeout(r, 750));
    return new Response(renderLoginHtml(url, env, msg), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
      },
    });
  };

  const expected = env.DASHBOARD_PASSWORD;
  if (!expected) {
    return errorRender("Dashboard password is not configured on the Worker.");
  }

  let provided = "";
  const ctype = (request.headers.get("content-type") ?? "").toLowerCase();
  if (ctype.includes("application/json")) {
    try {
      const body = (await request.json()) as { password?: unknown };
      if (typeof body?.password === "string") provided = body.password;
    } catch {
      /* fall through; provided stays "" */
    }
  } else {
    // Default: form-encoded (HTML <form> POST).
    try {
      const text = await request.text();
      const params = new URLSearchParams(text);
      provided = params.get("password") ?? "";
    } catch {
      /* fall through */
    }
  }
  if (!provided) {
    return errorRender("Please enter a password.");
  }
  if (!constantTimeEqual(provided, expected)) {
    return errorRender("Invalid password.");
  }

  const ttl = resolveDashboardSessionTtlSec(env);
  const cookieValue = await buildDashboardCookie(env, ttl);
  const cookie = [
    `${DASHBOARD_COOKIE_NAME}=${cookieValue}`,
    `Max-Age=${ttl}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
  ].join("; ");
  return new Response(null, {
    status: 303,
    headers: {
      location: "/",
      "set-cookie": cookie,
      "cache-control": "no-store",
    },
  });
}

/**
 * Clear the dashboard session cookie. Returns the operator to /, where
 * the login form will render on the next request because the cookie is
 * now expired.
 */
function handleDashboardLogout(): Response {
  const cookie = [
    `${DASHBOARD_COOKIE_NAME}=`,
    "Max-Age=0",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
  ].join("; ");
  return new Response(null, {
    status: 303,
    headers: {
      location: "/",
      "set-cookie": cookie,
      "cache-control": "no-store",
    },
  });
}

/**
 * Render the login form. ``errorMessage`` (if set) is shown inline
 * above the password field. The form posts to ``/dashboard/login``
 * as ``application/x-www-form-urlencoded`` so it works with no JS.
 */
function renderLoginHtml(
  _url: URL,
  _env: Env,
  errorMessage: string | undefined,
): string {
  const errorBlock = errorMessage
    ? `<div class="alert">${escapeHtmlForServer(errorMessage)}</div>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<title>Sign in · Proxy Coordinator</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>${commonDashboardStyles()}
  .login-shell {
    min-height: 100vh; display:flex; align-items:center; justify-content:center;
    background:
      radial-gradient(1100px 600px at 80% -10%, rgba(56, 189, 248, 0.08), transparent 60%),
      radial-gradient(900px 500px at -10% 110%, rgba(168, 85, 247, 0.07), transparent 60%),
      var(--bg);
  }
  .card {
    width: 380px; padding: 32px; background: var(--card-bg);
    border: 1px solid var(--border); border-radius: 14px;
    box-shadow: 0 20px 50px -20px rgba(0,0,0,0.7);
  }
  .brand { display:flex; align-items:center; gap:10px; margin-bottom: 22px; }
  .brand .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 12px var(--ok); }
  .brand .title { font-size: 14px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text); }
  .brand .sub { font-size: 11px; color: var(--muted); margin-left: auto; }
  h2 { margin: 0 0 6px; font-size: 20px; color: var(--text); }
  .lead { color: var(--muted); font-size: 13px; margin: 0 0 22px; line-height: 1.5; }
  label { display:block; font-size:11px; text-transform:uppercase; letter-spacing:0.06em; color: var(--muted); margin-bottom: 6px; }
  input[type="password"] {
    width: 100%; padding: 11px 14px; font-size: 14px; border-radius: 8px;
    background: var(--input-bg); border: 1px solid var(--border); color: var(--text);
    box-sizing: border-box; outline: none; transition: border-color .15s;
  }
  input[type="password"]:focus { border-color: var(--accent); }
  button {
    width: 100%; margin-top: 18px; padding: 11px 14px; font-size: 14px; font-weight: 500;
    border: none; border-radius: 8px; cursor: pointer;
    background: linear-gradient(180deg, var(--accent), var(--accent-dim));
    color: #0a0e14; transition: filter .15s;
  }
  button:hover { filter: brightness(1.08); }
  button:active { filter: brightness(0.95); }
  .alert {
    margin: -6px 0 16px; padding: 10px 12px; font-size: 12px; color: var(--bad);
    background: rgba(248, 113, 113, 0.08); border: 1px solid rgba(248, 113, 113, 0.25);
    border-radius: 6px;
  }
  .foot { margin-top: 18px; font-size: 11px; color: var(--muted); text-align:center; }
  .foot code { background: var(--input-bg); padding: 1px 5px; border-radius: 3px; }
</style></head>
<body>
<div class="login-shell">
  <div class="card">
    <div class="brand">
      <span class="dot"></span>
      <span class="title">Proxy Coordinator</span>
      <span class="sub">ops</span>
    </div>
    <h2>Sign in</h2>
    <p class="lead">Enter the operator dashboard password to access live runner state, signals, and config.</p>
    ${errorBlock}
    <form method="POST" action="/dashboard/login" autocomplete="off">
      <label for="password">Password</label>
      <input id="password" type="password" name="password" autofocus required />
      <button type="submit">Sign in</button>
    </form>
    <div class="foot">Configure with <code>wrangler secret put DASHBOARD_PASSWORD</code></div>
  </div>
</div>
</body></html>`;
}

/**
 * Render the dashboard SPA. Reads the operator session cookie that
 * was set by ``/dashboard/login``; uses ``credentials: same-origin``
 * on every fetch so the cookie rides along automatically.
 */
function renderDashboardHtml(url: URL): string {
  const proxyIdsRaw = url.searchParams.get("proxy_ids") ?? "";
  const proxyIdsJs = JSON.stringify(proxyIdsRaw);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>Dashboard · Proxy Coordinator</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>${commonDashboardStyles()}
  body { padding-top: 56px; }
  .topbar {
    position: fixed; top: 0; left: 0; right: 0; height: 56px; z-index: 10;
    display: flex; align-items: center; padding: 0 24px;
    background: rgba(11, 15, 21, 0.85); backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border);
  }
  .topbar .brand { display:flex; align-items:center; gap:10px; }
  .topbar .brand .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); transition: background .2s, box-shadow .2s; }
  .topbar .brand.live .dot { background: var(--ok); box-shadow: 0 0 10px var(--ok); animation: pulse 2s infinite; }
  .topbar .brand.err .dot { background: var(--bad); box-shadow: 0 0 10px var(--bad); }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
  .topbar .title { font-size: 13px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--text); }
  .topbar .sub { font-size: 11px; color: var(--muted); }
  .topbar .spacer { flex: 1; }
  .topbar .meta { display:flex; align-items:center; gap:18px; font-size: 12px; color: var(--muted); }
  .topbar .meta code { color: var(--text); }
  .topbar a.logout { color: var(--muted); text-decoration: none; font-size: 12px; padding: 5px 10px; border: 1px solid var(--border); border-radius: 6px; transition: color .15s, border-color .15s; }
  .topbar a.logout:hover { color: var(--text); border-color: var(--muted); }
  main { max-width: 1440px; margin: 0 auto; padding: 28px 24px 56px; }

  /* Hero stats row */
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 24px; }
  .stat-card {
    background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px;
    padding: 16px 18px;
  }
  .stat-card .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); margin-bottom: 6px; }
  .stat-card .value { font-size: 32px; font-weight: 600; color: var(--text); letter-spacing: -0.02em; line-height: 1.1; }
  .stat-card .delta { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .stat-card.warn .value { color: var(--warn); }
  .stat-card.bad .value { color: var(--bad); }
  .stat-card.ok .value { color: var(--ok); }

  /* Section grid */
  .grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 20px; }
  @media (max-width: 1000px) { .grid { grid-template-columns: 1fr; } .stats { grid-template-columns: repeat(2, 1fr); } }
  .panel {
    background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px;
    overflow: hidden; display: flex; flex-direction: column;
  }
  .panel header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px; border-bottom: 1px solid var(--border);
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted);
  }
  .panel header .badge { font-size: 10px; background: var(--input-bg); color: var(--text); padding: 2px 7px; border-radius: 4px; letter-spacing: 0; text-transform: none; }
  .panel .body { padding: 0; }
  .panel.full { grid-column: 1 / -1; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { padding: 9px 16px; text-align: left; border-bottom: 1px solid var(--border); }
  tr:last-child td { border-bottom: none; }
  th { font-weight: 500; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); background: rgba(0,0,0,0.15); }
  td code { background: var(--input-bg); padding: 2px 6px; border-radius: 3px; color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
  td .muted { color: var(--muted); }
  td .pill { display: inline-block; padding: 2px 7px; font-size: 11px; border-radius: 999px; font-weight: 500; }
  td .pill.ok { background: rgba(74, 222, 128, 0.12); color: var(--ok); }
  td .pill.warn { background: rgba(251, 191, 36, 0.12); color: var(--warn); }
  td .pill.bad { background: rgba(248, 113, 113, 0.12); color: var(--bad); }
  td .pill.muted { background: var(--input-bg); color: var(--muted); }

  .score-bar { display: inline-flex; align-items: center; gap: 8px; font-variant-numeric: tabular-nums; }
  .score-bar .track { width: 80px; height: 4px; border-radius: 2px; background: var(--input-bg); overflow: hidden; }
  .score-bar .fill { display: block; height: 100%; background: linear-gradient(90deg, var(--ok), var(--accent)); border-radius: 2px; }

  .empty { padding: 22px 16px; color: var(--muted); font-style: italic; font-size: 12.5px; text-align: center; }
  .hint { padding: 14px 16px; color: var(--muted); font-size: 12px; line-height: 1.5; }
  .hint code { background: var(--input-bg); padding: 1px 5px; border-radius: 3px; color: var(--text); }

  .banner {
    margin: 0 0 22px; padding: 12px 16px;
    background: linear-gradient(90deg, rgba(248, 113, 113, 0.10), rgba(248, 113, 113, 0.02));
    border: 1px solid rgba(248, 113, 113, 0.30); border-radius: 8px;
    color: var(--bad); font-size: 12.5px;
  }
  .banner strong { color: var(--text); margin-right: 6px; }
  .banner.warn { background: linear-gradient(90deg, rgba(251, 191, 36, 0.10), rgba(251, 191, 36, 0.02)); border-color: rgba(251, 191, 36, 0.30); color: var(--warn); }

  details { padding: 0 16px; }
  details summary { padding: 12px 0; cursor: pointer; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); list-style: none; user-select: none; }
  details summary::-webkit-details-marker { display: none; }
  details summary::before { content: "▸"; margin-right: 6px; display: inline-block; transition: transform .15s; }
  details[open] summary::before { transform: rotate(90deg); }
  details .config-grid { padding: 0 0 16px; display: grid; grid-template-columns: minmax(220px, auto) 1fr; gap: 4px 16px; font-size: 12.5px; }
  details .config-grid .k { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  details .config-grid .v { color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style></head>
<body>
<div class="topbar">
  <div class="brand" id="brand"><span class="dot"></span><span class="title">Proxy Coordinator</span><span class="sub">/ ops</span></div>
  <div class="spacer"></div>
  <div class="meta">
    <span>last update <code id="ts">—</code></span>
    <span id="state">connecting…</span>
    <form method="POST" action="/dashboard/logout" style="margin:0">
      <button type="submit" style="all:unset"><a class="logout" href="/dashboard/logout" onclick="this.closest('form').submit(); return false;">Sign out</a></button>
    </form>
  </div>
</div>
<main>
  <div id="banners"></div>
  <div class="stats" id="stats"></div>
  <div class="grid">
    <div class="panel">
      <header>Active runners <span class="badge" id="runner-count">0</span></header>
      <div class="body" id="runners"></div>
    </div>
    <div class="panel">
      <header>Active signals <span class="badge" id="signal-count">0</span></header>
      <div class="body" id="signals"></div>
    </div>
    <div class="panel full">
      <header>Per-proxy state <span class="badge" id="proxy-count">0</span></header>
      <div class="body" id="proxies"></div>
    </div>
    <div class="panel full">
      <header>Config snapshot</header>
      <div class="body" id="config"></div>
    </div>
  </div>
</main>
<script>
(function(){
  var PROXY_IDS = ${proxyIdsJs};
  var REFRESH_MS = 30000;
  var $ = function(id){ return document.getElementById(id); };
  var brand = $("brand");

  function fmtTs(ms){ if(!ms) return "—"; var d = new Date(ms); return d.toISOString().replace("T"," ").slice(11,19) + "Z"; }
  function fmtAge(ms, nowMs){ if(!ms) return "—"; var s = Math.max(0,(nowMs-ms)/1000); if(s<60) return s.toFixed(0)+"s"; if(s<3600) return (s/60).toFixed(1)+"m"; return (s/3600).toFixed(1)+"h"; }
  function fmtDur(ms){ if(ms<=0) return "—"; var s = ms/1000; if(s<60) return s.toFixed(0)+"s"; if(s<3600) return (s/60).toFixed(1)+"m"; return (s/3600).toFixed(1)+"h"; }
  function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"})[c]; }); }

  function statTile(label, value, cls){
    return '<div class="stat-card '+(cls||"")+'"><div class="label">'+label+'</div><div class="value">'+esc(String(value))+'</div></div>';
  }

  function renderStats(data, nowMs){
    var runners = (data.runners && data.runners.active_runners) || [];
    var signals = (data.signals && data.signals.active_signals) || [];
    var proxies = data.proxies || [];
    var healthyProxies = proxies.filter(function(p){ return !p.banned && !p.error; }).length;
    var signalCls = signals.length === 0 ? "" : (signals.some(function(s){ return s.kind === "pause_all"; }) ? "bad" : "warn");
    var html = "";
    html += statTile("Live runners", runners.length, runners.length > 0 ? "ok" : "");
    html += statTile("Active signals", signals.length, signalCls);
    html += statTile("Proxies tracked", proxies.length, "");
    html += statTile("Healthy proxies", healthyProxies + " / " + proxies.length, healthyProxies === proxies.length && proxies.length > 0 ? "ok" : (healthyProxies === 0 && proxies.length > 0 ? "bad" : ""));
    $("stats").innerHTML = html;
  }

  function renderBanners(data){
    var signals = (data.signals && data.signals.active_signals) || [];
    if(signals.length === 0){ $("banners").innerHTML = ""; return; }
    var nowMs = data.server_time || Date.now();
    var html = "";
    signals.forEach(function(s){
      var cls = s.kind === "pause_all" ? "" : "warn";
      var payload = "";
      if(s.kind === "throttle_global") payload = "global throttle × " + s.factor;
      else if(s.kind === "ban_proxy") payload = "ban proxy " + esc(s.proxy_id || "?");
      else if(s.kind === "pause_all") payload = "PAUSE ALL RUNNERS";
      else payload = esc(s.kind);
      var ttl = fmtDur((s.expires_at_ms || 0) - nowMs);
      html += '<div class="banner '+cls+'"><strong>'+payload+'</strong>· expires in '+ttl;
      if(s.reason) html += ' · <em>'+esc(s.reason)+'</em>';
      html += ' · <code>'+esc(s.id)+'</code></div>';
    });
    $("banners").innerHTML = html;
  }

  function renderRunners(data, nowMs){
    if(!data.runners || !data.runners.active_runners){ $("runners").innerHTML = '<div class="empty">registry unavailable</div>'; $("runner-count").textContent = "0"; return; }
    var rows = data.runners.active_runners;
    $("runner-count").textContent = String(rows.length);
    if(rows.length === 0){ $("runners").innerHTML = '<div class="empty">No live runners</div>'; return; }
    var html = '<table><tr><th>Holder</th><th>Workflow</th><th>Uptime</th><th>Last heartbeat</th><th>Pool hash</th></tr>';
    rows.forEach(function(r){
      var lastAge = nowMs - r.last_heartbeat;
      var lastCls = lastAge > 120000 ? "warn" : (lastAge > 300000 ? "bad" : "ok");
      var lastPill = '<span class="pill '+lastCls+'">'+fmtAge(r.last_heartbeat, nowMs)+' ago</span>';
      html += '<tr><td><code>'+esc(r.holder_id)+'</code></td>'
        + '<td class="muted">'+esc(r.workflow_name || "—")+'</td>'
        + '<td class="muted">'+fmtAge(r.started_at, nowMs)+'</td>'
        + '<td>'+lastPill+'</td>'
        + '<td><code>'+esc((r.proxy_pool_hash || "").slice(0,10) || "—")+'</code></td></tr>';
    });
    html += '</table>';
    $("runners").innerHTML = html;
  }

  function renderSignals(data, nowMs){
    if(!data.signals || !data.signals.active_signals){ $("signals").innerHTML = '<div class="empty">registry unavailable</div>'; $("signal-count").textContent = "0"; return; }
    var rows = data.signals.active_signals;
    $("signal-count").textContent = String(rows.length);
    if(rows.length === 0){ $("signals").innerHTML = '<div class="empty">Cohort healthy — no operator signals</div>'; return; }
    var html = '<table><tr><th>Kind</th><th>Payload</th><th>Expires</th></tr>';
    rows.forEach(function(s){
      var cls = s.kind === "pause_all" ? "bad" : "warn";
      var payload = "—";
      if(s.kind === "throttle_global") payload = '× '+esc(s.factor);
      else if(s.kind === "ban_proxy") payload = '<code>'+esc(s.proxy_id || "?")+'</code>';
      var ttl = fmtDur((s.expires_at_ms || 0) - nowMs);
      html += '<tr><td><span class="pill '+cls+'">'+esc(s.kind)+'</span></td><td>'+payload+'</td><td class="muted">in '+ttl+'</td></tr>';
    });
    html += '</table>';
    $("signals").innerHTML = html;
  }

  function renderConfig(data){
    if(!data.config){ $("config").innerHTML = '<div class="empty">config-state DO unavailable</div>'; return; }
    var entries = Object.entries(data.config.values || {});
    if(entries.length === 0){
      $("config").innerHTML = '<div class="hint">No operator overrides — all values use env-var defaults from <code>wrangler.toml</code>. Snapshot version <code>'+esc(String(data.config.version||0))+'</code>.</div>';
      return;
    }
    var html = '<details open><summary>'+entries.length+' override(s) · version <code style="text-transform:none;letter-spacing:0">'+esc(String(data.config.version||0))+'</code></summary><div class="config-grid">';
    entries.forEach(function(kv){
      html += '<div class="k">'+esc(kv[0])+'</div><div class="v">'+esc(kv[1])+'</div>';
    });
    html += '</div></details>';
    $("config").innerHTML = html;
  }

  function renderProxies(data){
    var rows = data.proxies || [];
    $("proxy-count").textContent = String(rows.length);
    if(rows.length === 0){
      $("proxies").innerHTML = '<div class="hint">No proxies queried. Append <code>?proxy_ids=Proxy-1,Proxy-2</code> to this URL to enumerate per-proxy throttle state.</div>';
      return;
    }
    var html = '<table><tr><th>Proxy</th><th>Status</th><th>Health</th><th>Latency</th><th>Wins / Losses</th><th>Wait</th></tr>';
    rows.forEach(function(p){
      if(p.error){
        html += '<tr><td><code>'+esc(p.proxy_id)+'</code></td><td colspan="5"><span class="pill bad">error: '+esc(p.error)+'</span></td></tr>';
        return;
      }
      var statusPill;
      if(p.banned) statusPill = '<span class="pill bad">banned</span>';
      else if(p.requires_cf_bypass) statusPill = '<span class="pill warn">cf-bypass</span>';
      else statusPill = '<span class="pill ok">live</span>';
      var h = p.health || {};
      var score = typeof h.score === "number" ? h.score : 0.5;
      var scoreBar = '<span class="score-bar"><span class="track"><span class="fill" style="width:'+(score*100).toFixed(0)+'%"></span></span><span>'+(score*100).toFixed(0)+'</span></span>';
      var latency = typeof h.latency_ema_ms === "number" ? h.latency_ema_ms.toFixed(0)+" ms" : "—";
      var wins = typeof h.success_count === "number" ? h.success_count : 0;
      var losses = typeof h.failure_count === "number" ? h.failure_count : 0;
      var waitMs = p.nextAvailableAt ? Math.max(0, p.nextAvailableAt - Date.now()) : 0;
      html += '<tr><td><code>'+esc(p.proxy_id)+'</code></td>'
        + '<td>'+statusPill+'</td>'
        + '<td>'+scoreBar+'</td>'
        + '<td class="muted">'+esc(latency)+'</td>'
        + '<td class="muted">'+wins+' / '+losses+'</td>'
        + '<td class="muted">'+(waitMs > 0 ? waitMs+"ms" : "—")+'</td></tr>';
    });
    html += '</table>';
    $("proxies").innerHTML = html;
  }

  function setBrandLive(live){
    brand.classList.toggle("live", !!live);
    brand.classList.toggle("err", !live);
  }

  function refresh(){
    var url = "/ops/snapshot";
    if(PROXY_IDS) url += "?proxy_ids="+encodeURIComponent(PROXY_IDS);
    $("state").textContent = "polling…";
    fetch(url, { credentials: "same-origin" }).then(function(r){
      if(r.status === 401){ window.location.href = "/"; throw new Error("auth"); }
      if(r.status !== 200) throw new Error("HTTP "+r.status);
      return r.json();
    }).then(function(data){
      var nowMs = data.server_time || Date.now();
      renderStats(data, nowMs);
      renderBanners(data);
      renderRunners(data, nowMs);
      renderSignals(data, nowMs);
      renderConfig(data);
      renderProxies(data);
      setBrandLive(true);
      $("state").textContent = "live";
      $("ts").textContent = fmtTs(nowMs);
    }).catch(function(err){
      setBrandLive(false);
      $("state").textContent = "error: " + err.message;
    });
  }
  refresh();
  setInterval(refresh, REFRESH_MS);
})();
</script>
</body></html>`;
}

/** CSS shared between login form + dashboard SPA. Single source of
 *  truth for the color palette + base typography. */
function commonDashboardStyles(): string {
  return `
  :root {
    --bg: #0a0e14;
    --card-bg: #131820;
    --input-bg: #1c2230;
    --border: #1f2730;
    --text: #d4d7e0;
    --muted: #6e7681;
    --accent: #38bdf8;
    --accent-dim: #0ea5e9;
    --ok: #4ade80;
    --warn: #fbbf24;
    --bad: #f87171;
  }
  * { box-sizing: border-box; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Inter", sans-serif;
    margin: 0; background: var(--bg); color: var(--text);
    -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
  }
  a { color: var(--accent); text-decoration: none; }
  `;
}

/** Server-side HTML escape used in the login form's error message slot.
 *  The dashboard's client-side ``esc()`` covers the live-poll path. */
function escapeHtmlForServer(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

/**
 * W5.7 / ADR-003 — proxy a request to the singleton MetricsState DO.
 *
 * Returns 503 when the binding is missing (v6 migration not yet applied).
 * Body buffering mirrors the other forwardTo* helpers to avoid leaking
 * the DO's SQLite storage frame across the JSRPC boundary.
 */
async function forwardToMetricsStateDo(
  env: Env,
  path: string,
  method: "GET" | "POST",
  body: unknown,
): Promise<Response> {
  if (!env.METRICS_STATE_DO) {
    return jsonResponse(
      { error: "metrics_state binding not configured (apply v6 migration)" },
      503,
    );
  }
  const id = env.METRICS_STATE_DO.idFromName("global-metrics");
  const stub = env.METRICS_STATE_DO.get(id);
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
