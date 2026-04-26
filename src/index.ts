import { Env, LeaseRequest, ReportRequest } from "./types";

export { ProxyCoordinator } from "./proxy_coordinator";

/**
 * Worker entry point.  Routes:
 *
 * - `POST /lease`   — body `{ proxy_id, intended_sleep_ms }` → forwarded to
 *   the per-proxy DO instance addressed by `idFromName(proxy_id)`.
 * - `POST /report`  — body `{ proxy_id, kind }` → forwarded similarly.
 * - `GET  /state?proxy_id=...` — debug snapshot of a DO (auth required).
 * - `GET  /health`  — unauthenticated liveness probe (returns 200 OK).
 *
 * Auth: every endpoint except `/health` requires header
 * `Authorization: Bearer <PROXY_COORDINATOR_TOKEN>` (set via
 * `wrangler secret put PROXY_COORDINATOR_TOKEN`).
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

    if (request.method !== "POST" && url.pathname !== "/state") {
      return jsonResponse({ error: "method not allowed" }, 405);
    }

    try {
      switch (url.pathname) {
        case "/lease": {
          const body = (await request.json()) as LeaseRequest;
          const proxyId = normalizeProxyId(body?.proxy_id);
          if (!proxyId) return jsonResponse({ error: "missing proxy_id" }, 400);
          return await forwardToDo(env, proxyId, "/do/lease", body);
        }
        case "/report": {
          const body = (await request.json()) as ReportRequest;
          const proxyId = normalizeProxyId(body?.proxy_id);
          if (!proxyId) return jsonResponse({ error: "missing proxy_id" }, 400);
          return await forwardToDo(env, proxyId, "/do/report", body);
        }
        case "/state": {
          const proxyId = normalizeProxyId(url.searchParams.get("proxy_id"));
          if (!proxyId) return jsonResponse({ error: "missing proxy_id" }, 400);
          return await forwardToDo(env, proxyId, "/do/state", null);
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

async function forwardToDo(
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
