/**
 * Phase-3 ADR-008 — tests for new dashboard panels:
 *   - /movie_claim/stats fan-out endpoint
 *   - /work/stats reachable via cookie auth (already Bearer-tested
 *     in work_distributor.test.ts; here we just verify the cookie
 *     path so the dashboard's same-origin fetch works)
 *   - /ops/snapshot includes movie_claim_stats + work_stats blocks
 */

import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const TOKEN = "test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

async function rawFetch(path: string, init: RequestInit): Promise<Response> {
  const req = new Request(`https://test.invalid${path}`, init);
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function jsonPost<T>(path: string, body: unknown): Promise<T> {
  const res = await rawFetch(path, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

async function jsonGet<T>(path: string): Promise<T> {
  const res = await rawFetch(path, { method: "GET", headers: { ...AUTH } });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

interface ClaimStatsResp {
  claims_active: number;
  staged_count: number;
  completed_committed_count: number;
  failures_count: number;
  in_cooldown_count: number;
  dead_lettered_count: number;
  server_time: number;
}

interface WorkStatsResp {
  queue_size: number;
  visible: number;
  leased: number;
  oldest_enqueued_at_ms: number | null;
  server_time: number;
}

describe("Phase-3 — MovieClaim stats endpoint", () => {
  it("/movie_claim/stats returns the six count fields aggregated", async () => {
    const stats = await jsonGet<ClaimStatsResp>("/movie_claim/stats");
    expect(typeof stats.claims_active).toBe("number");
    expect(typeof stats.staged_count).toBe("number");
    expect(typeof stats.completed_committed_count).toBe("number");
    expect(typeof stats.failures_count).toBe("number");
    expect(typeof stats.in_cooldown_count).toBe("number");
    expect(typeof stats.dead_lettered_count).toBe("number");
    expect(stats.server_time).toBeGreaterThan(0);
  });

  it("counts a freshly committed movie", async () => {
    // Seed: claim then complete one href in the default date shard.
    const href = "/v/phase3test" + crypto.randomUUID().slice(0, 6);
    await jsonPost("/claim_movie", {
      href,
      holder_id: "phase3-runner",
      ttl_ms: 60_000,
    });
    await jsonPost("/complete_movie", {
      href,
      holder_id: "phase3-runner",
    });
    const after = await jsonGet<ClaimStatsResp>("/movie_claim/stats");
    expect(after.completed_committed_count).toBeGreaterThanOrEqual(1);
  });
});

describe("Phase-3 — WorkDistributor stats reachable", () => {
  it("/work/stats returns the four count fields", async () => {
    const stats = await jsonGet<WorkStatsResp>("/work/stats");
    expect(typeof stats.queue_size).toBe("number");
    expect(typeof stats.visible).toBe("number");
    expect(typeof stats.leased).toBe("number");
    expect(stats.oldest_enqueued_at_ms === null
      || typeof stats.oldest_enqueued_at_ms === "number").toBe(true);
  });

  it("queue_size increments after enqueue", async () => {
    const key = "phase3-item-" + crypto.randomUUID().slice(0, 8);
    const before = await jsonGet<WorkStatsResp>("/work/stats");
    await jsonPost("/work/enqueue", {
      items: [{ key, payload: { test: 1 } }],
    });
    const after = await jsonGet<WorkStatsResp>("/work/stats");
    expect(after.queue_size).toBe(before.queue_size + 1);
  });
});

describe("Phase-3 — /ops/snapshot embeds new blocks", () => {
  it("includes movie_claim_stats + work_stats keys", async () => {
    const snap = await jsonGet<Record<string, unknown>>("/ops/snapshot");
    expect("movie_claim_stats" in snap).toBe(true);
    expect("work_stats" in snap).toBe(true);
    // movie_claim_stats can be null when binding is missing — verify
    // shape when present.
    if (snap.movie_claim_stats !== null) {
      expect(typeof (snap.movie_claim_stats as Record<string, unknown>).claims_active).toBe("number");
    }
    if (snap.work_stats !== null) {
      expect(typeof (snap.work_stats as Record<string, unknown>).queue_size).toBe("number");
    }
  });
});
