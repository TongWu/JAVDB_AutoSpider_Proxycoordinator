/**
 * W5.1 — Runtime observability dashboard tests (password-login model).
 *
 * Covers:
 *  - GET / and GET /dashboard render the LOGIN form when no cookie is
 *    present (root-domain access works without a token in the URL).
 *  - POST /dashboard/login validates password against env.DASHBOARD_PASSWORD,
 *    sets an HttpOnly signed cookie, and redirects to /.
 *  - Bad / missing password re-renders the login form (HTTP 200) with
 *    an inline error.
 *  - After login, GET / renders the dashboard HTML.
 *  - /ops/snapshot accepts EITHER the dashboard cookie OR a Bearer header.
 *  - /ops/snapshot returns 401 with no auth at all.
 *  - GlobalLoginState is NEVER reached by the snapshot (cookie privacy).
 *  - /dashboard/logout clears the cookie.
 */

import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker, {
  _resetRateLimitBucketsForTesting,
} from "../src/index";

const BEARER = "test-token";
const PASSWORD = "test-dash-password";
const AUTH_HEADER = { authorization: `Bearer ${BEARER}` };

afterEach(() => {
  _resetRateLimitBucketsForTesting();
});

async function getRaw(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const req = new Request(`https://test.invalid${path}`, {
    method: "GET",
    ...init,
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** Submit the login form and return the (redirect / error) response. */
async function login(
  password: string,
  ctype: "form" | "json" = "form",
): Promise<Response> {
  const headers: Record<string, string> =
    ctype === "json"
      ? { "content-type": "application/json" }
      : { "content-type": "application/x-www-form-urlencoded" };
  const body =
    ctype === "json"
      ? JSON.stringify({ password })
      : `password=${encodeURIComponent(password)}`;
  const req = new Request("https://test.invalid/dashboard/login", {
    method: "POST",
    headers,
    body,
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** Pull the dashboard_session cookie value out of a Set-Cookie header. */
function sessionCookieFrom(res: Response): string {
  const sc = res.headers.get("set-cookie") ?? "";
  const m = sc.match(/dashboard_session=([^;]+)/);
  expect(m, `expected dashboard_session in: ${sc}`).not.toBeNull();
  return m![1];
}

describe("W5.1 dashboard — root domain + login form", () => {
  it("GET / serves the login form when no cookie is present", async () => {
    const res = await getRaw("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toMatch(/Sign in/i);
    expect(html).toContain('action="/dashboard/login"');
    // Defence-in-depth headers.
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("GET /dashboard serves the same login form as /", async () => {
    const res = await getRaw("/dashboard");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/Sign in/i);
  });

  it("does NOT accept ?token= query parameter any more", async () => {
    // W5.1-r2: the legacy query-token fallback is gone. Hitting /
    // with ?token= should still render the login form (not bypass it)
    // because the cookie check is what gates the dashboard now.
    const res = await getRaw(`/?token=${BEARER}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/Sign in/i);
  });
});

describe("W5.1 dashboard — POST /dashboard/login", () => {
  it("rejects empty password with an inline error", async () => {
    const res = await login("");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/please enter a password/i);
  });

  it("rejects wrong password with an inline error", async () => {
    const res = await login("not-the-real-password");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/invalid password/i);
    // Must NOT set the session cookie on failure.
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("accepts the correct password and sets a signed cookie", async () => {
    const res = await login(PASSWORD);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const sc = res.headers.get("set-cookie") ?? "";
    expect(sc).toMatch(/dashboard_session=/);
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/Secure/);
    expect(sc).toMatch(/SameSite=Lax/);
    expect(sc).toMatch(/Path=\//);
    // Cookie value is "<exp>.<hex>" — verify shape.
    const m = sc.match(/dashboard_session=([^;]+)/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/^\d+\.[0-9a-f]+$/);
  });

  it("accepts JSON body too (for programmatic clients)", async () => {
    const res = await login(PASSWORD, "json");
    expect(res.status).toBe(303);
  });
});

describe("W5.1 dashboard — authenticated rendering", () => {
  it("GET / with a valid cookie renders the dashboard SPA", async () => {
    const loginRes = await login(PASSWORD);
    const cookie = sessionCookieFrom(loginRes);
    const res = await getRaw("/", {
      headers: { cookie: `dashboard_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Proxy Coordinator");
    expect(html).toContain("/ops/snapshot");
    // Must NOT render the login form for a logged-in operator.
    expect(html).not.toMatch(/Sign in</);
  });

  it("a tampered cookie falls back to the login form", async () => {
    // Replace the signature half with all-zeros.
    const loginRes = await login(PASSWORD);
    const original = sessionCookieFrom(loginRes);
    const dot = original.indexOf(".");
    const tampered = original.slice(0, dot + 1) + "0".repeat(64);
    const res = await getRaw("/", {
      headers: { cookie: `dashboard_session=${tampered}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/Sign in/i);
  });

  it("an expired cookie falls back to the login form", async () => {
    // Hand-build an expired cookie. The signature won't match (expiry
    // is in the payload) so verify also rejects on the signature path,
    // but the explicit "exp < now" branch is what we want to cover.
    const res = await getRaw("/", {
      headers: { cookie: "dashboard_session=1.deadbeef" },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/Sign in/i);
  });
});

describe("W5.1 dashboard — /dashboard/logout", () => {
  it("clears the session cookie and redirects to /", async () => {
    const loginRes = await login(PASSWORD);
    const cookie = sessionCookieFrom(loginRes);
    const req = new Request("https://test.invalid/dashboard/logout", {
      method: "POST",
      headers: { cookie: `dashboard_session=${cookie}` },
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const sc = res.headers.get("set-cookie") ?? "";
    expect(sc).toMatch(/dashboard_session=/);
    expect(sc).toMatch(/Max-Age=0/);
  });
});

describe("W5.1 dashboard — /ops/snapshot dual auth", () => {
  it("returns 200 with a valid session cookie", async () => {
    const loginRes = await login(PASSWORD);
    const cookie = sessionCookieFrom(loginRes);
    const res = await getRaw("/ops/snapshot", {
      headers: { cookie: `dashboard_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(typeof data.server_time).toBe("number");
    expect(data.runners).toBeDefined();
    expect(Array.isArray(data.proxies)).toBe(true);
  });

  it("returns 200 with a Bearer header (machine workflow still works)", async () => {
    const res = await getRaw("/ops/snapshot", { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
  });

  it("returns 401 with no auth at all", async () => {
    const res = await getRaw("/ops/snapshot");
    expect(res.status).toBe(401);
  });

  it("queries the per-proxy DOs only for IDs listed in ?proxy_ids=", async () => {
    // Seed two proxies via the Bearer-authed lease path.
    for (const id of ["DashTestA", "DashTestB"]) {
      const req = new Request("https://test.invalid/lease", {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ proxy_id: id, intended_sleep_ms: 0 }),
      });
      const ctx = createExecutionContext();
      const r = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);
      expect(r.status).toBe(200);
      await r.json();
    }

    const loginRes = await login(PASSWORD);
    const cookie = sessionCookieFrom(loginRes);
    const res = await getRaw("/ops/snapshot?proxy_ids=DashTestA,DashTestB", {
      headers: { cookie: `dashboard_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      proxies: Array<Record<string, unknown>>;
      queried_proxy_ids: string[];
    };
    expect(data.queried_proxy_ids).toEqual(["DashTestA", "DashTestB"]);
    expect(data.proxies).toHaveLength(2);
    expect(data.proxies.map((p) => p.proxy_id).sort()).toEqual([
      "DashTestA",
      "DashTestB",
    ]);
  });

  it("caps proxy_ids at 32 to bound fan-out cost", async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `Cap-${i}`).join(",");
    const res = await getRaw(`/ops/snapshot?proxy_ids=${ids}`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { queried_proxy_ids: string[] };
    expect(data.queried_proxy_ids).toHaveLength(32);
  });

  it("never includes login_state / cookie in the snapshot (privacy)", async () => {
    const res = await getRaw("/ops/snapshot", { headers: AUTH_HEADER });
    const text = await res.text();
    expect(text).not.toMatch(/login_state/i);
    expect(text).not.toMatch(/cookie/i);
  });
});
