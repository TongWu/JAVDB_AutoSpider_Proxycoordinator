/**
 * W5.6 — Worker-level token-bucket rate limit tests.
 *
 * Unit-tests target the pure decision helper with controllable nowMs so
 * we can deterministically verify the refill math. One integration test
 * pre-seeds a drained bucket and verifies the worker fetch handler
 * returns 429.
 */

import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker, {
  _resetRateLimitBucketsForTesting,
  _rateLimitAllowForTesting,
  _seedRateLimitBucketForTesting,
} from "../src/index";

const TOKEN = "test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

afterEach(() => {
  _resetRateLimitBucketsForTesting();
});

describe("W5.6 rate limit — pure decision helper", () => {
  it("starts with a full bucket and admits the first request", () => {
    expect(_rateLimitAllowForTesting("tok", 10, 1_000_000)).toBe(true);
  });

  it("admits up to capacity requests in a single instant, then rejects", () => {
    const t0 = 1_000_000;
    // No time advances → no refill. Capacity-10 bucket admits exactly 10.
    for (let i = 0; i < 10; i++) {
      expect(_rateLimitAllowForTesting("tok", 10, t0)).toBe(true);
    }
    expect(_rateLimitAllowForTesting("tok", 10, t0)).toBe(false);
  });

  it("refills linearly over the 60 s window", () => {
    const t0 = 1_000_000;
    // Drain the bucket.
    for (let i = 0; i < 10; i++) {
      _rateLimitAllowForTesting("tok", 10, t0);
    }
    expect(_rateLimitAllowForTesting("tok", 10, t0)).toBe(false);
    // Advance 6 s — that is 10% of the window → 1 token refills.
    expect(_rateLimitAllowForTesting("tok", 10, t0 + 6_000)).toBe(true);
    // Bucket is back to ~0; immediately retrying without more elapsed
    // time should be rejected.
    expect(_rateLimitAllowForTesting("tok", 10, t0 + 6_000)).toBe(false);
  });

  it("never refills above capacity", () => {
    const t0 = 1_000_000;
    // First call seeds the bucket at capacity-1 = 9.
    _rateLimitAllowForTesting("tok", 10, t0);
    // Advance 10 minutes — far past one full window — and check that
    // the bucket caps at capacity, not at capacity * (windows elapsed).
    const tFar = t0 + 10 * 60_000;
    // Drain it again; if the cap wasn't honoured, more than 10 calls
    // would pass before the bucket empties.
    let passes = 0;
    for (let i = 0; i < 20; i++) {
      if (_rateLimitAllowForTesting("tok", 10, tFar)) passes++;
    }
    expect(passes).toBe(10);
  });

  it("isolates buckets per token", () => {
    const t0 = 1_000_000;
    // Drain bucket A.
    for (let i = 0; i < 10; i++) {
      _rateLimitAllowForTesting("alice", 10, t0);
    }
    expect(_rateLimitAllowForTesting("alice", 10, t0)).toBe(false);
    // Bucket B is untouched and still full.
    expect(_rateLimitAllowForTesting("bob", 10, t0)).toBe(true);
  });

  it("treats capacity <= 0 as disabled (always admit)", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 1000; i++) {
      expect(_rateLimitAllowForTesting("tok", 0, t0)).toBe(true);
    }
    for (let i = 0; i < 1000; i++) {
      expect(_rateLimitAllowForTesting("tok", -5, t0)).toBe(true);
    }
  });
});

describe("W5.6 rate limit — fetch handler integration", () => {
  async function getActiveRunners(): Promise<Response> {
    const req = new Request("https://test.invalid/active_runners", {
      method: "GET",
      headers: { ...AUTH },
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("returns 200 for an authed request with a full bucket", async () => {
    const res = await getActiveRunners();
    expect(res.status).toBe(200);
  });

  it("returns 429 when the bucket is pre-seeded as drained", async () => {
    // Seed the bucket so the very next request finds it empty.
    _seedRateLimitBucketForTesting(TOKEN, 0, Date.now());
    const res = await getActiveRunners();
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("rate_limited");
  });

  it("does not consume bucket tokens on unauthenticated /health probes", async () => {
    _seedRateLimitBucketForTesting(TOKEN, 0, Date.now());
    // /health bypasses both auth and rate-limit.
    for (let i = 0; i < 5; i++) {
      const req = new Request("https://test.invalid/health");
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(200);
    }
    // Despite 5 /health calls, the authed bucket is still drained → 429.
    const limited = await getActiveRunners();
    expect(limited.status).toBe(429);
  });

  it("returns 401 (not 429) for missing Bearer header even when bucket empty", async () => {
    _seedRateLimitBucketForTesting(TOKEN, 0, Date.now());
    const req = new Request("https://test.invalid/active_runners");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });
});
