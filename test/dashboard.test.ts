/**
 * W5.1 — Runtime observability dashboard tests.
 *
 * Covers:
 *  - /dashboard returns HTML with embedded inline JS that uses the
 *    token from `?token=` for snapshot polling.
 *  - /ops/snapshot aggregates runners, signals, config, proxies in one
 *    JSON payload.
 *  - Both routes accept `?token=` as an alternative to the
 *    Authorization header (only on these two paths).
 *  - Missing/incorrect token returns 401 regardless of which form was
 *    used.
 *  - GlobalLoginState is NEVER reached by the snapshot (cookie privacy).
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

const TOKEN = "test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

afterEach(() => {
  _resetRateLimitBucketsForTesting();
});

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const req = new Request(`https://test.invalid${path}`, {
    method: "GET",
    headers,
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("W5.1 dashboard — /dashboard HTML route", () => {
  it("serves HTML when authed via header", async () => {
    const res = await get("/dashboard", AUTH);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("proxy-coordinator dashboard");
  });

  it("accepts token via ?token= query (browser workflow)", async () => {
    const res = await get(`/dashboard?token=${TOKEN}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Token gets embedded into the inline JS for snapshot polling.
    expect(html).toContain(`"${TOKEN}"`);
  });

  it("rejects when no token is provided", async () => {
    const res = await get("/dashboard");
    expect(res.status).toBe(401);
  });

  it("rejects when query token is wrong", async () => {
    const res = await get("/dashboard?token=wrong-token");
    expect(res.status).toBe(401);
  });

  it("propagates the ?proxy_ids= query to the SPA", async () => {
    const res = await get(`/dashboard?token=${TOKEN}&proxy_ids=Proxy-1,Proxy-2`);
    const html = await res.text();
    expect(html).toContain("Proxy-1,Proxy-2");
  });

  it("sets cache-control:no-store so refresh always re-fetches", async () => {
    const res = await get(`/dashboard?token=${TOKEN}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("W5.1 dashboard — /ops/snapshot aggregation", () => {
  it("returns a structured aggregate payload", async () => {
    const res = await get("/ops/snapshot", AUTH);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(typeof data.server_time).toBe("number");
    expect(data.runners).toBeDefined();
    expect(data.signals).toBeDefined();
    expect(data.config).toBeDefined();
    expect(Array.isArray(data.proxies)).toBe(true);
    expect(Array.isArray(data.queried_proxy_ids)).toBe(true);
    expect(data.queried_proxy_ids).toEqual([]);
  });

  it("accepts ?token= as an alternative to the Authorization header", async () => {
    const res = await get(`/ops/snapshot?token=${TOKEN}`);
    expect(res.status).toBe(200);
  });

  it("returns 401 on bad ?token=", async () => {
    const res = await get("/ops/snapshot?token=bogus");
    expect(res.status).toBe(401);
  });

  it("queries the per-proxy DOs only for IDs listed in ?proxy_ids=", async () => {
    // Seed two proxies with a /lease so each has DO state.
    // We consume `r.json()` rather than just inspecting the status — the
    // vitest-pool-workers isolated-storage tracker chokes when a Response
    // body backed by a DO call leaves the test without its body drained
    // (the DO storage frame can't be popped at teardown).
    for (const id of ["DashTestA", "DashTestB"]) {
      const req = new Request("https://test.invalid/lease", {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ proxy_id: id, intended_sleep_ms: 0 }),
      });
      const ctx = createExecutionContext();
      const r = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);
      expect(r.status).toBe(200);
      await r.json();
    }

    const res = await get("/ops/snapshot?proxy_ids=DashTestA,DashTestB", AUTH);
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
    const res = await get(`/ops/snapshot?proxy_ids=${ids}`, AUTH);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { queried_proxy_ids: string[] };
    expect(data.queried_proxy_ids).toHaveLength(32);
  });

  it("trims and drops empty proxy_ids entries", async () => {
    const res = await get("/ops/snapshot?proxy_ids=,  ,A,,B  ,", AUTH);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { queried_proxy_ids: string[] };
    expect(data.queried_proxy_ids).toEqual(["A", "B"]);
  });

  it("never includes login_state / cookie in the snapshot (privacy)", async () => {
    const res = await get("/ops/snapshot", AUTH);
    const text = await res.text();
    // Defence-in-depth: assert by raw substring scan in case a future
    // change accidentally adds the field somewhere structured.
    expect(text).not.toMatch(/login_state/i);
    expect(text).not.toMatch(/cookie/i);
  });

  it("surfaces the W5.4 signal list from the registry", async () => {
    // Push a signal so the snapshot has something to reflect.
    const sigReq = new Request("https://test.invalid/signal", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "throttle_global",
        ttl_ms: 60_000,
        factor: 2.0,
        reason: "dashboard-test",
      }),
    });
    const sigCtx = createExecutionContext();
    const sigRes = await worker.fetch(sigReq, env, sigCtx);
    await waitOnExecutionContext(sigCtx);
    await sigRes.json();

    const res = await get("/ops/snapshot", AUTH);
    const data = (await res.json()) as {
      signals: { active_signals?: Array<{ kind: string; reason?: string }> } | null;
    };
    expect(data.signals).not.toBeNull();
    const sigs = data.signals!.active_signals ?? [];
    expect(
      sigs.some(
        (s) => s.kind === "throttle_global" && s.reason === "dashboard-test",
      ),
    ).toBe(true);

    // Clean up so other tests aren't poisoned.
    const cleanup = new Request("https://test.invalid/signal", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ kind: "resume" }),
    });
    const cCtx = createExecutionContext();
    const cRes = await worker.fetch(cleanup, env, cCtx);
    await waitOnExecutionContext(cCtx);
    await cRes.json();
  });
});
