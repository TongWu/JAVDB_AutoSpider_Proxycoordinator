import { Env, LeaseRequest, ReportRequest } from "./types";

export { ProxyCoordinator } from "./proxy_coordinator";
export { GlobalLoginState } from "./global_login_state";
export { MovieClaimState } from "./movie_claim_state";
export { RunnerRegistry } from "./runner_registry";

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

    if (request.method !== "POST" && !GET_ALLOWED_PATHS.has(url.pathname)) {
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
          return await forwardToRunnerRegistryDo(env, "/do/register", "POST", body);
        }
        case "/heartbeat": {
          const body = await request.json();
          return await forwardToRunnerRegistryDo(env, "/do/heartbeat", "POST", body);
        }
        case "/unregister": {
          const body = await request.json();
          return await forwardToRunnerRegistryDo(env, "/do/unregister", "POST", body);
        }
        case "/active_runners":
          return await forwardToRunnerRegistryDo(env, "/do/active_runners", "GET", null);
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
  const header = request.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return false;
  const provided = header.slice("bearer ".length).trim();
  return constantTimeEqual(provided, token);
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
