/**
 * W5.5 — /recommend_proxy cross-DO health aggregation tests.
 *
 * Strategy: seed several proxies via real /lease + /report calls (which
 * populate the ProxyCoordinator DO's health snapshot), then assert
 * ranking + filtering behaviour from /recommend_proxy.
 *
 * Health-score is computed inside ProxyCoordinator from the request /
 * response history. We seed differential success/failure events to
 * generate distinguishable scores rather than mocking the DO.
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

async function lease(proxyId: string): Promise<Response> {
  const req = new Request("https://test.invalid/lease", {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ proxy_id: proxyId, intended_sleep_ms: 0 }),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  await res.json(); // drain so isolated storage can tear down
  return res;
}

async function reportEvent(
  proxyId: string,
  kind: "success" | "failure" | "cf" | "ban",
  extras: { latency_ms?: number; ttl_ms?: number } = {},
): Promise<void> {
  const req = new Request("https://test.invalid/report", {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ proxy_id: proxyId, kind, ...extras }),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  await res.json();
}

async function recommend(query: string): Promise<{
  status: number;
  body: {
    recommendations: Array<{
      proxy_id: string;
      score: number;
      banned: boolean;
      available: boolean;
    }>;
    queried_proxy_ids: string[];
    server_time: number;
  };
}> {
  const req = new Request(`https://test.invalid/recommend_proxy?${query}`, {
    method: "GET",
    headers: { ...AUTH },
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  const status = res.status;
  const body = (await res.json()) as {
    recommendations: Array<{
      proxy_id: string;
      score: number;
      banned: boolean;
      available: boolean;
    }>;
    queried_proxy_ids: string[];
    server_time: number;
  };
  return { status, body };
}

describe("W5.5 /recommend_proxy — empty input", () => {
  it("returns empty recommendations when no proxy_ids supplied", async () => {
    const r = await recommend("");
    expect(r.status).toBe(200);
    expect(r.body.recommendations).toEqual([]);
    expect(r.body.queried_proxy_ids).toEqual([]);
  });

  it("ignores empty / blank entries in proxy_ids", async () => {
    const r = await recommend("proxy_ids=,  ,,");
    expect(r.body.queried_proxy_ids).toEqual([]);
    expect(r.body.recommendations).toEqual([]);
  });
});

describe("W5.5 /recommend_proxy — ranking", () => {
  it("ranks higher-scoring proxies first", async () => {
    // Proxy R-GOOD gets lots of successes; R-BAD gets failures. The
    // ProxyCoordinator's exponential health-score function will give
    // R-GOOD a higher score.
    await lease("R-GOOD");
    await lease("R-BAD");
    for (let i = 0; i < 10; i++) {
      await reportEvent("R-GOOD", "success", { latency_ms: 100 });
    }
    for (let i = 0; i < 10; i++) {
      await reportEvent("R-BAD", "failure");
    }

    const r = await recommend("proxy_ids=R-GOOD,R-BAD");
    expect(r.status).toBe(200);
    expect(r.body.recommendations[0].proxy_id).toBe("R-GOOD");
    expect(r.body.recommendations[0].score).toBeGreaterThan(
      r.body.recommendations[r.body.recommendations.length - 1].score,
    );
  });

  it("excludes banned proxies by default", async () => {
    await lease("R-OKAY");
    await lease("R-BANNED");
    await reportEvent("R-BANNED", "ban", { ttl_ms: 60_000 });

    const r = await recommend("proxy_ids=R-OKAY,R-BANNED");
    const ids = r.body.recommendations.map((rec) => rec.proxy_id);
    expect(ids).toContain("R-OKAY");
    expect(ids).not.toContain("R-BANNED");
  });

  it("returns banned proxies when include_unhealthy=1", async () => {
    await lease("R-VISIBLE");
    await lease("R-BANNED-VISIBLE");
    await reportEvent("R-BANNED-VISIBLE", "ban", { ttl_ms: 60_000 });

    const r = await recommend(
      "proxy_ids=R-VISIBLE,R-BANNED-VISIBLE&include_unhealthy=1",
    );
    const ids = r.body.recommendations.map((rec) => rec.proxy_id);
    expect(ids).toContain("R-VISIBLE");
    expect(ids).toContain("R-BANNED-VISIBLE");
    // Banned ranks last (negative score).
    const banned = r.body.recommendations.find(
      (rec) => rec.proxy_id === "R-BANNED-VISIBLE",
    );
    expect(banned).toBeDefined();
    expect(banned!.banned).toBe(true);
    expect(banned!.score).toBeLessThan(0);
    expect(banned!.available).toBe(false);
  });

  it("caps the result list at top_n", async () => {
    await lease("R-1");
    await lease("R-2");
    await lease("R-3");
    const r = await recommend("proxy_ids=R-1,R-2,R-3&top_n=2");
    expect(r.body.recommendations).toHaveLength(2);
  });

  it("returns all queried proxies when top_n is absent or invalid", async () => {
    await lease("R-A");
    await lease("R-B");
    const r1 = await recommend("proxy_ids=R-A,R-B");
    expect(r1.body.recommendations).toHaveLength(2);
    const r2 = await recommend("proxy_ids=R-A,R-B&top_n=0");
    expect(r2.body.recommendations).toHaveLength(2);
    const r3 = await recommend("proxy_ids=R-A,R-B&top_n=not-a-number");
    expect(r3.body.recommendations).toHaveLength(2);
  });

  it("assigns the neutral 0.5 score to never-leased proxies", async () => {
    // R-UNSEEN has no DO state at all. The ProxyCoordinator returns
    // health.score=0.5 (the neutral baseline) so the proxy gets some
    // traffic on first use instead of being excluded.
    const r = await recommend("proxy_ids=R-UNSEEN&include_unhealthy=1");
    const rec = r.body.recommendations.find(
      (x) => x.proxy_id === "R-UNSEEN",
    );
    expect(rec).toBeDefined();
    expect(rec!.score).toBe(0.5);
  });

  it("ties broken by proxy_id ascending (stable order)", async () => {
    // Two never-leased proxies → same neutral score → tie-break by id.
    const r = await recommend("proxy_ids=R-ZZ,R-AA&include_unhealthy=1");
    expect(r.body.recommendations.map((x) => x.proxy_id)).toEqual([
      "R-AA",
      "R-ZZ",
    ]);
  });
});

describe("W5.5 /recommend_proxy — auth + caps", () => {
  it("returns 401 without bearer auth", async () => {
    const req = new Request(
      "https://test.invalid/recommend_proxy?proxy_ids=R-1",
      { method: "GET" },
    );
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it("caps fan-out at 32 proxy_ids", async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `Cap-${i}`).join(",");
    const r = await recommend(`proxy_ids=${ids}&include_unhealthy=1`);
    expect(r.body.queried_proxy_ids).toHaveLength(32);
  });
});
