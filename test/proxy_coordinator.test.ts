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

async function lease(proxyId: string, intendedSleepMs: number) {
  const req = new Request("https://test.invalid/lease", {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ proxy_id: proxyId, intended_sleep_ms: intendedSleepMs }),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    wait_ms: number;
    penalty_factor: number;
    server_time: number;
    reason: string;
  };
}

async function report(proxyId: string, kind: "cf" | "failure" = "cf") {
  const req = new Request("https://test.invalid/report", {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ proxy_id: proxyId, kind }),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    penalty_factor: number;
    recent_event_count: number;
    server_time: number;
  };
}

async function dumpState(proxyId: string) {
  const req = new Request(
    `https://test.invalid/state?proxy_id=${encodeURIComponent(proxyId)}`,
    { method: "GET", headers: { ...AUTH } },
  );
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    nextAvailableAt: number;
    requestTimestamps: number[];
    cfEvents: number[];
    penalty_factor: number;
    now: number;
  };
}

describe("auth", () => {
  it("rejects requests without bearer token", async () => {
    const req = new Request("https://test.invalid/lease", {
      method: "POST",
      body: JSON.stringify({ proxy_id: "p", intended_sleep_ms: 0 }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it("rejects requests with wrong bearer token", async () => {
    const req = new Request("https://test.invalid/lease", {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: JSON.stringify({ proxy_id: "p", intended_sleep_ms: 0 }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it("/health is unauthenticated", async () => {
    const req = new Request("https://test.invalid/health");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
  });
});

describe("lease — next_available_at", () => {
  it("first lease for a fresh proxy returns intended_sleep_ms (plus jitter)", async () => {
    const proxy = `fresh-${crypto.randomUUID()}`;
    const r = await lease(proxy, 1000);
    expect(r.wait_ms).toBeGreaterThanOrEqual(1000);
    // Jitter is at most JITTER_MAX_MS=500; also small chance of 0.
    expect(r.wait_ms).toBeLessThan(1000 + 500 + 50);
    expect(r.penalty_factor).toBe(1.0);
  });

  it("second lease must wait for the first slot to age out", async () => {
    const proxy = `seq-${crypto.randomUUID()}`;
    const first = await lease(proxy, 2000);
    const second = await lease(proxy, 10);
    /**
     * The second call's intended sleep is tiny but the DO already pushed
     * `next_available_at` ~2s into the future for the first lease.  So the
     * second lease must wait approximately first.wait_ms (minus the few ms
     * between the two calls).
     */
    expect(second.wait_ms).toBeGreaterThanOrEqual(first.wait_ms - 200);
  });

  it("requests at the same proxy serialize via next_available_at", async () => {
    const proxy = `serial-${crypto.randomUUID()}`;
    const wait1 = (await lease(proxy, 500)).wait_ms;
    const wait2 = (await lease(proxy, 500)).wait_ms;
    const wait3 = (await lease(proxy, 500)).wait_ms;
    // Each subsequent grant pushes nextAvailableAt forward by at least the
    // previous wait, so cumulative grants should be monotonically increasing
    // in absolute terms (we measure the wait each call returns).
    expect(wait2).toBeGreaterThanOrEqual(450);
    expect(wait3).toBeGreaterThanOrEqual(450);
  });

  it("different proxy_ids do not block each other", async () => {
    const a = `iso-a-${crypto.randomUUID()}`;
    const b = `iso-b-${crypto.randomUUID()}`;
    const wait1 = (await lease(a, 5000)).wait_ms;
    const wait2 = (await lease(b, 0)).wait_ms;
    expect(wait1).toBeGreaterThanOrEqual(5000);
    expect(wait2).toBeLessThan(600); // only jitter
  });
});

describe("lease — three-window throttle", () => {
  it("short window (3 slots) blocks the 4th call inside the window", async () => {
    const proxy = `short-${crypto.randomUUID()}`;
    // First three should fit (intended_sleep = 0 each → only jitter).
    // Lease 1 schedules at ~now + jitter.  By granting all three with tiny
    // intended sleeps, we pack them into a sub-second range, then the fourth
    // must slide forward to clear the SHORT_WINDOW_SEC=30s cap of 3.
    const w1 = (await lease(proxy, 0)).wait_ms;
    const w2 = (await lease(proxy, 0)).wait_ms;
    const w3 = (await lease(proxy, 0)).wait_ms;
    const w4 = await lease(proxy, 0);
    expect(w1).toBeLessThan(700);
    // w2 / w3 may already start sliding because nextAvailableAt has been
    // pushed slightly by w1's jitter; the strict assertion is on w4.
    expect(w4.wait_ms).toBeGreaterThan(20_000);
    expect(w4.reason).toMatch(/throttle_short|next_available/);
  });

  it("dump_state reflects the queued requestTimestamps", async () => {
    const proxy = `dump-${crypto.randomUUID()}`;
    await lease(proxy, 100);
    await lease(proxy, 100);
    const s = await dumpState(proxy);
    expect(s.requestTimestamps.length).toBe(2);
    expect(s.nextAvailableAt).toBeGreaterThan(s.now);
  });
});

describe("report — penalty_factor escalates and decays", () => {
  it("0 events → penalty 1.0", async () => {
    const proxy = `pen-0-${crypto.randomUUID()}`;
    const r = await lease(proxy, 0);
    expect(r.penalty_factor).toBe(1.0);
  });

  it("1 event → penalty 1.30", async () => {
    const proxy = `pen-1-${crypto.randomUUID()}`;
    const r = await report(proxy);
    expect(r.penalty_factor).toBe(1.3);
  });

  it("2 events → penalty 1.65", async () => {
    const proxy = `pen-2-${crypto.randomUUID()}`;
    await report(proxy);
    const r = await report(proxy);
    expect(r.penalty_factor).toBe(1.65);
  });

  it("4+ events → penalty 2.00", async () => {
    const proxy = `pen-4-${crypto.randomUUID()}`;
    await report(proxy);
    await report(proxy);
    await report(proxy);
    const r = await report(proxy);
    expect(r.penalty_factor).toBe(2.0);
  });

  it("lease after report returns the elevated penalty_factor", async () => {
    const proxy = `pen-lease-${crypto.randomUUID()}`;
    await report(proxy);
    await report(proxy);
    const r = await lease(proxy, 0);
    expect(r.penalty_factor).toBe(1.65);
  });
});

describe("payload validation", () => {
  it("missing proxy_id returns 400", async () => {
    const req = new Request("https://test.invalid/lease", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ intended_sleep_ms: 0 }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });
});
