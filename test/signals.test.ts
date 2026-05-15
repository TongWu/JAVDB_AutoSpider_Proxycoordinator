/**
 * W5.4 — Active degradation / circuit-breaker signals.
 *
 * Covers POST /signal validation + idempotent replace-by-id + resume
 * clears everything + GET /signals lists active + register/heartbeat
 * responses embed the live signal set + expired signals are pruned on
 * the read path.
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

interface Signal {
  id: string;
  kind: string;
  expires_at_ms: number;
  created_at_ms: number;
  reason?: string;
  factor?: number;
  proxy_id?: string;
}

interface SignalsBody {
  active_signals: Signal[];
  server_time: number;
  error?: string;
}

async function postSignal(
  body: Record<string, unknown>,
): Promise<{ status: number; body: SignalsBody }> {
  const req = new Request("https://test.invalid/signal", {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, body: (await res.json()) as SignalsBody };
}

async function listSignals(): Promise<{ status: number; body: SignalsBody }> {
  const req = new Request("https://test.invalid/signals", {
    method: "GET",
    headers: { ...AUTH },
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, body: (await res.json()) as SignalsBody };
}

async function clearSignals(): Promise<void> {
  // Push a `resume` signal — drops all active signals server-side.
  await postSignal({ kind: "resume" });
}

describe("W5.4 signals — POST /signal validation", () => {
  it("rejects unknown signal kinds", async () => {
    await clearSignals();
    const r = await postSignal({ kind: "explode", ttl_ms: 60_000 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/unknown signal kind/);
  });

  it("requires ttl_ms >= 1000 for non-resume kinds", async () => {
    await clearSignals();
    const r = await postSignal({ kind: "pause_all", ttl_ms: 500 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/ttl_ms/);
  });

  it("requires factor in [1, 100] for throttle_global", async () => {
    await clearSignals();
    const r1 = await postSignal({
      kind: "throttle_global", ttl_ms: 60_000, factor: 0.5,
    });
    expect(r1.status).toBe(400);
    const r2 = await postSignal({
      kind: "throttle_global", ttl_ms: 60_000, factor: 9999,
    });
    expect(r2.status).toBe(400);
  });

  it("requires proxy_id for ban_proxy", async () => {
    await clearSignals();
    const r = await postSignal({ kind: "ban_proxy", ttl_ms: 60_000 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/proxy_id/);
  });

  it("accepts a valid throttle_global signal", async () => {
    await clearSignals();
    const r = await postSignal({
      kind: "throttle_global",
      ttl_ms: 60_000,
      factor: 2.0,
      reason: "burst-storm",
    });
    expect(r.status).toBe(200);
    expect(r.body.active_signals).toHaveLength(1);
    const s = r.body.active_signals[0];
    expect(s.kind).toBe("throttle_global");
    expect(s.factor).toBe(2.0);
    expect(s.reason).toBe("burst-storm");
    expect(s.expires_at_ms).toBeGreaterThan(Date.now());
  });
});

describe("W5.4 signals — idempotent replace + resume", () => {
  it("replaces a signal in-place when the same id is posted again", async () => {
    await clearSignals();
    await postSignal({
      id: "sig-A", kind: "pause_all", ttl_ms: 60_000, reason: "v1",
    });
    const second = await postSignal({
      id: "sig-A", kind: "pause_all", ttl_ms: 120_000, reason: "v2",
    });
    expect(second.body.active_signals).toHaveLength(1);
    expect(second.body.active_signals[0].reason).toBe("v2");
  });

  it("resume drops every active signal in one go", async () => {
    await clearSignals();
    await postSignal({ kind: "pause_all", ttl_ms: 60_000 });
    await postSignal({
      kind: "throttle_global", ttl_ms: 60_000, factor: 3.0,
    });
    const before = await listSignals();
    expect(before.body.active_signals.length).toBeGreaterThanOrEqual(2);

    const r = await postSignal({ kind: "resume" });
    expect(r.status).toBe(200);
    expect(r.body.active_signals).toEqual([]);

    const after = await listSignals();
    expect(after.body.active_signals).toEqual([]);
  });
});

describe("W5.4 signals — register/heartbeat embedding", () => {
  async function register(holderId: string): Promise<Response> {
    const req = new Request("https://test.invalid/register", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ holder_id: holderId }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  async function heartbeat(holderId: string): Promise<Response> {
    const req = new Request("https://test.invalid/heartbeat", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ holder_id: holderId }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("register response carries currently-active signals", async () => {
    await clearSignals();
    await postSignal({
      kind: "throttle_global", ttl_ms: 60_000, factor: 1.5,
    });
    const res = await register("runner-w54-a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active_signals?: Signal[] };
    expect(body.active_signals).toBeDefined();
    expect(body.active_signals!.length).toBeGreaterThanOrEqual(1);
    expect(
      body.active_signals!.some((s) => s.kind === "throttle_global"),
    ).toBe(true);
  });

  it("heartbeat surfaces signals pushed after register", async () => {
    await clearSignals();
    await register("runner-w54-b");
    await postSignal({
      kind: "pause_all", ttl_ms: 60_000, reason: "ops freeze",
    });
    const res = await heartbeat("runner-w54-b");
    const body = (await res.json()) as { active_signals?: Signal[] };
    expect(body.active_signals).toBeDefined();
    expect(
      body.active_signals!.some(
        (s) => s.kind === "pause_all" && s.reason === "ops freeze",
      ),
    ).toBe(true);
  });

  it("heartbeat returns empty signal list after resume", async () => {
    await clearSignals();
    await register("runner-w54-c");
    await postSignal({ kind: "pause_all", ttl_ms: 60_000 });
    await postSignal({ kind: "resume" });
    const res = await heartbeat("runner-w54-c");
    const body = (await res.json()) as { active_signals?: Signal[] };
    expect(body.active_signals).toEqual([]);
  });
});
