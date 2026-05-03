import { Env, LeaseRequest, ReportRequest } from "./types";

export { ProxyCoordinator } from "./proxy_coordinator";
export { GlobalLoginState } from "./global_login_state";

/**
 * Endpoints that accept GET (every other request must be POST).  Kept as a
 * `Set` so adding new read-only routes is a one-line edit instead of touching
 * the conditional in two places.
 */
const GET_ALLOWED_PATHS = new Set<string>(["/state", "/login_state"]);

/**
 * Worker entry point.  Routes:
 *
 * Per-proxy throttling (ProxyCoordinator DO, addressed by `idFromName(proxy_id)`):
 * - `POST /lease`   — body `{ proxy_id, intended_sleep_ms }` → grant pacing slot.
 * - `POST /report`  — body `{ proxy_id, kind }`              → record CF/failure event.
 * - `GET  /state?proxy_id=...` — debug snapshot.
 *
 * Cross-runtime login state (GlobalLoginState DO, addressed by `idFromName("global")`):
 * - `GET  /login_state`                  — current logged-in proxy + decrypted cookie.
 * - `POST /login_state/acquire_lease`    — mutex for the next re-login attempt.
 * - `POST /login_state/publish`          — publish a fresh cookie (lease holder only).
 * - `POST /login_state/invalidate`       — mark current cookie bad (optimistic version lock).
 * - `POST /login_state/release_lease`    — owner releases the re-login mutex.
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
        default:
          return jsonResponse({ error: "not found" }, 404);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse({ error: message }, 500);
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
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
