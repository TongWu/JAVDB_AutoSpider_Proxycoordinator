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
      heuristic_score: number;
      model_score: number;
      confidence: number;
      reason_code: string;
      cooldown_until: number | null;
      model_version: string;
      banned: boolean;
      available: boolean;
      rank_score: number;
      ranking_mode: string;
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
      heuristic_score: number;
      model_score: number;
      confidence: number;
      reason_code: string;
      cooldown_until: number | null;
      model_version: string;
      banned: boolean;
      available: boolean;
      rank_score: number;
      ranking_mode: string;
    }>;
    queried_proxy_ids: string[];
    server_time: number;
  };
  return { status, body };
}

async function recommendWithEnv(
  query: string,
  overrides: Record<string, string>,
): Promise<Awaited<ReturnType<typeof recommend>>> {
  const req = new Request(`https://test.invalid/recommend_proxy?${query}`, {
    method: "GET",
    headers: { ...AUTH },
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, { ...env, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  const status = res.status;
  const body = (await res.json()) as Awaited<ReturnType<typeof recommend>>["body"];
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

  it("adds ADR-023 shadow scoring fields without changing heuristic score", async () => {
    await lease("R-SHADOW-GOOD");
    await lease("R-SHADOW-BAD");
    for (let i = 0; i < 10; i++) {
      await reportEvent("R-SHADOW-GOOD", "success", { latency_ms: 100 });
    }
    for (let i = 0; i < 10; i++) {
      await reportEvent("R-SHADOW-BAD", "failure");
    }

    const r = await recommend("proxy_ids=R-SHADOW-GOOD,R-SHADOW-BAD");

    expect(r.body.recommendations.map((rec) => rec.proxy_id)).toEqual([
      "R-SHADOW-GOOD",
      "R-SHADOW-BAD",
    ]);
    for (const rec of r.body.recommendations) {
      expect(rec.heuristic_score).toBe(rec.score);
      expect(rec.model_score).toBeGreaterThanOrEqual(0);
      expect(rec.model_score).toBeLessThanOrEqual(1);
      expect(rec.confidence).toBeGreaterThanOrEqual(0);
      expect(rec.confidence).toBeLessThanOrEqual(1);
      expect(rec.reason_code).toMatch(
        /stable_recently|proxy_underperforming|global_pool_unstable|low_confidence_prior|banned_cooldown|cf_bypass_cooldown/,
      );
      expect(rec.model_version).toBe("adr023-shadow-v1");
    }
    // R-SHADOW-GOOD has 10 successes; R-SHADOW-BAD has 10 failures.
    // The model_score must reflect this differential.
    expect(r.body.recommendations[0].model_score).toBeGreaterThan(
      r.body.recommendations[1].model_score,
    );
  });

  it("deduplicates repeated proxy_ids in the query", async () => {
    await lease("R-DUP");
    await reportEvent("R-DUP", "success", { latency_ms: 100 });

    const r = await recommend("proxy_ids=R-DUP,R-DUP");

    const dupRows = r.body.recommendations.filter((rec) => rec.proxy_id === "R-DUP");
    expect(dupRows.length).toBe(1);
  });

  it("returns cooldown_until for banned proxies when included", async () => {
    await lease("R-COOLDOWN-VISIBLE");
    await reportEvent("R-COOLDOWN-VISIBLE", "ban", { ttl_ms: 60_000 });

    const r = await recommend("proxy_ids=R-COOLDOWN-VISIBLE&include_unhealthy=1");
    const rec = r.body.recommendations[0];

    expect(rec.proxy_id).toBe("R-COOLDOWN-VISIBLE");
    expect(rec.banned).toBe(true);
    expect(rec.reason_code).toBe("banned_cooldown");
    expect(typeof rec.cooldown_until).toBe("number");
    expect(rec.cooldown_until).toBeGreaterThan(r.body.server_time);
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

describe("W5.5 /recommend_proxy — policy mode flag (ADR-023 Phase 2)", () => {
  it("keeps heuristic ordering by default (shadow mode: rank_score === score)", async () => {
    await lease("R-DEFAULT-HEURISTIC-HIGH");
    await lease("R-DEFAULT-HEURISTIC-LOW");
    for (let i = 0; i < 10; i++) {
      await reportEvent("R-DEFAULT-HEURISTIC-HIGH", "success", { latency_ms: 5000 });
      await reportEvent("R-DEFAULT-HEURISTIC-LOW", "failure");
    }

    const r = await recommend(
      "proxy_ids=R-DEFAULT-HEURISTIC-HIGH,R-DEFAULT-HEURISTIC-LOW&include_unhealthy=1",
    );

    // R-DEFAULT-HEURISTIC-HIGH has 10 successes → high heuristic score.
    // R-DEFAULT-HEURISTIC-LOW has 10 failures → low heuristic score.
    // In shadow mode the sort key is rank_score = heuristic score, so HIGH wins.
    expect(r.body.recommendations[0].proxy_id).toBe("R-DEFAULT-HEURISTIC-HIGH");
    expect(r.body.recommendations[0].ranking_mode).toBe("shadow");
    expect(r.body.recommendations[0].rank_score).toBe(
      r.body.recommendations[0].score,
    );
  });

  it("uses blended policy rank score when RECOMMEND_PROXY_POLICY_MODE=policy", async () => {
    await lease("R-POLICY-FAST");
    await lease("R-POLICY-SLOW");
    for (let i = 0; i < 10; i++) {
      await reportEvent("R-POLICY-FAST", "success", { latency_ms: 100 });
      await reportEvent("R-POLICY-SLOW", "success", { latency_ms: 7000 });
    }

    const r = await recommendWithEnv(
      "proxy_ids=R-POLICY-SLOW,R-POLICY-FAST&include_unhealthy=1",
      {
        RECOMMEND_PROXY_POLICY_MODE: "policy",
        RECOMMEND_PROXY_EXPLORATION_FLOOR: "0.02",
      },
    );

    expect(r.body.recommendations[0].proxy_id).toBe("R-POLICY-FAST");
    expect(r.body.recommendations[0].ranking_mode).toBe("policy");
    expect(r.body.recommendations[0].rank_score).toBeGreaterThan(
      r.body.recommendations[1].rank_score,
    );
    // Both available proxies must respect the exploration floor.
    for (const rec of r.body.recommendations) {
      expect(rec.rank_score).toBeGreaterThanOrEqual(0.02);
    }
  });

  it("keeps banned proxies last in policy mode when include_unhealthy=1", async () => {
    await lease("R-POLICY-AVAILABLE");
    await lease("R-POLICY-BANNED");
    await reportEvent("R-POLICY-AVAILABLE", "success", { latency_ms: 100 });
    await reportEvent("R-POLICY-BANNED", "success", { latency_ms: 100 });
    await reportEvent("R-POLICY-BANNED", "ban", { ttl_ms: 60_000 });

    const r = await recommendWithEnv(
      "proxy_ids=R-POLICY-BANNED,R-POLICY-AVAILABLE&include_unhealthy=1",
      { RECOMMEND_PROXY_POLICY_MODE: "policy" },
    );

    expect(r.body.recommendations[0].proxy_id).toBe("R-POLICY-AVAILABLE");
    expect(r.body.recommendations[1].proxy_id).toBe("R-POLICY-BANNED");
    expect(r.body.recommendations[1].rank_score).toBeLessThan(0);
  });
});
