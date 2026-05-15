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

interface HealthSnapshotResp {
  success_count: number;
  failure_count: number;
  latency_ema_ms: number;
  score: number;
}

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
    banned?: boolean;
    banned_until?: number | null;
    requires_cf_bypass?: boolean;
    cf_bypass_until?: number | null;
    health?: HealthSnapshotResp | null;
  };
}

interface ReportBody {
  proxy_id: string;
  kind: "cf" | "failure" | "ban" | "unban" | "cf_bypass" | "success";
  ttl_ms?: number;
  reason?: string;
  latency_ms?: number;
}

async function report(
  proxyId: string,
  kind: ReportBody["kind"] = "cf",
  extras: { ttl_ms?: number; reason?: string; latency_ms?: number } = {},
) {
  const body: ReportBody = { proxy_id: proxyId, kind, ...extras };
  const req = new Request("https://test.invalid/report", {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify(body),
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
    bannedUntil: number | null;
    cfBypassUntil: number | null;
    successEvents?: number[];
    failureEvents?: number[];
    latencyEma?: number;
    penalty_factor: number;
    banned: boolean;
    requires_cf_bypass: boolean;
    health?: HealthSnapshotResp;
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

  it("non-finite intended_sleep_ms returns 400 (B.14)", async () => {
    // B.14 (2026-05-12): NaN / Infinity / negative / unbounded large
    // values used to be silently coerced to 0 or clamped further inside
    // the lease arithmetic.  Now we reject upfront so a malicious or
    // buggy caller can't push the DO's storage near Number.MAX_VALUE.
    // Each iteration uses a fresh proxy_id so the early-reject path
    // never touches DO storage (the test harness asserts on
    // isolated-storage state between tests).
    for (const bad of ["NaN", "Infinity", "-Infinity", -1, Number.MAX_VALUE]) {
      const req = new Request("https://test.invalid/lease", {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          proxy_id: `bad-sleep-${crypto.randomUUID()}`,
          intended_sleep_ms: bad,
        }),
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_intended_sleep_ms");
    }
  });

  it("unknown report.kind returns 400 (Q3 / sibling P0-1)", async () => {
    // Q3 (2026-05-12): a typo'd ``rawKind`` (e.g. "succss") used to fall
    // through to the legacy ``else`` branch and inflate cfEvents — the
    // worker's penalty_factor would then climb spuriously and tax every
    // peer lease for ``penaltyWindowSec`` seconds. The 400 here surfaces
    // the typo at the caller and leaves DO state untouched.
    const req = new Request("https://test.invalid/report", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        proxy_id: `unk-${crypto.randomUUID()}`,
        kind: "succss",
      }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string; allowed_kinds: string[];
    };
    expect(body.error).toBe("invalid_kind");
    expect(body.allowed_kinds).toEqual(
      ["ban", "cf", "cf_bypass", "failure", "success", "unban"],
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P1-A — cross-runner proxy ban + CF bypass piggy-backed on /lease.  These
// tests cover (a) the new ReportRequest.kind values mutating bannedUntil /
// cfBypassUntil, (b) lease responses surfacing the booleans + reason="banned",
// (c) auto-expiry, and (d) backwards-compat defaults so old clients that don't
// send the new fields keep working unchanged.
// ─────────────────────────────────────────────────────────────────────────────

describe("P1-A — fresh proxy reports default ban/cf_bypass state", () => {
  it("lease on a fresh proxy reports banned=false, requires_cf_bypass=false", async () => {
    const proxy = `p1a-fresh-${crypto.randomUUID()}`;
    const r = await lease(proxy, 0);
    expect(r.banned).toBe(false);
    expect(r.banned_until).toBeNull();
    expect(r.requires_cf_bypass).toBe(false);
    expect(r.cf_bypass_until).toBeNull();
    expect(r.reason).not.toBe("banned");
  });
});

describe("P1-A — ban / unban", () => {
  it("kind=ban with explicit ttl_ms flags banned=true and reason='banned'", async () => {
    const proxy = `p1a-ban-${crypto.randomUUID()}`;
    await report(proxy, "ban", { ttl_ms: 60_000, reason: "manual" });
    const r = await lease(proxy, 0);
    expect(r.banned).toBe(true);
    expect(r.reason).toBe("banned");
    expect(r.banned_until).not.toBeNull();
    expect(r.banned_until!).toBeGreaterThan(r.server_time);
    expect(r.banned_until!).toBeLessThanOrEqual(r.server_time + 61_000);
  });

  it("kind=ban without ttl_ms uses ~3 day default", async () => {
    const proxy = `p1a-ban-default-${crypto.randomUUID()}`;
    await report(proxy, "ban");
    const r = await lease(proxy, 0);
    expect(r.banned).toBe(true);
    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    expect(r.banned_until!).toBeGreaterThan(r.server_time + THREE_DAYS_MS - 60_000);
    expect(r.banned_until!).toBeLessThanOrEqual(r.server_time + THREE_DAYS_MS + 60_000);
  });

  it("kind=ban does NOT push a cfEvent and does NOT raise penalty_factor", async () => {
    const proxy = `p1a-ban-no-penalty-${crypto.randomUUID()}`;
    await report(proxy, "ban", { ttl_ms: 60_000 });
    const r = await lease(proxy, 0);
    expect(r.penalty_factor).toBe(1.0);
  });

  it("two concurrent bans take the longer TTL (max-monotonic policy)", async () => {
    const proxy = `p1a-ban-max-${crypto.randomUUID()}`;
    await report(proxy, "ban", { ttl_ms: 600_000 });
    const after_long = await lease(proxy, 0);
    expect(after_long.banned).toBe(true);
    const longUntil = after_long.banned_until!;
    // Now apply a SHORTER ban — should NOT shorten the existing window.
    await report(proxy, "ban", { ttl_ms: 1_000 });
    const after_short = await lease(proxy, 0);
    expect(after_short.banned_until!).toBeGreaterThanOrEqual(longUntil - 100);
  });

  it("kind=unban clears bannedUntil immediately", async () => {
    const proxy = `p1a-unban-${crypto.randomUUID()}`;
    await report(proxy, "ban", { ttl_ms: 600_000 });
    const banned = await lease(proxy, 0);
    expect(banned.banned).toBe(true);
    await report(proxy, "unban");
    const after = await lease(proxy, 0);
    expect(after.banned).toBe(false);
    expect(after.banned_until).toBeNull();
    expect(after.reason).not.toBe("banned");
  });
});

describe("P1-A — cf_bypass tri-state (>0 / 0 / null)", () => {
  it("kind=cf_bypass with ttl_ms>0 sets a TTL window", async () => {
    const proxy = `p1a-cfb-ttl-${crypto.randomUUID()}`;
    await report(proxy, "cf_bypass", { ttl_ms: 30_000 });
    const r = await lease(proxy, 0);
    expect(r.requires_cf_bypass).toBe(true);
    expect(r.cf_bypass_until).not.toBeNull();
    expect(r.cf_bypass_until!).toBeGreaterThan(r.server_time);
  });

  it("kind=cf_bypass with ttl_ms=0 means permanent for this session", async () => {
    const proxy = `p1a-cfb-permanent-${crypto.randomUUID()}`;
    await report(proxy, "cf_bypass", { ttl_ms: 0 });
    const r = await lease(proxy, 0);
    expect(r.requires_cf_bypass).toBe(true);
    expect(r.cf_bypass_until).toBe(0);
  });

  it("kind=cf_bypass with omitted ttl_ms also defaults to permanent", async () => {
    const proxy = `p1a-cfb-omitted-${crypto.randomUUID()}`;
    await report(proxy, "cf_bypass");
    const r = await lease(proxy, 0);
    expect(r.requires_cf_bypass).toBe(true);
    expect(r.cf_bypass_until).toBe(0);
  });

  it("permanent (0) is sticky: a follow-up ttl-bounded request does not downgrade", async () => {
    const proxy = `p1a-cfb-sticky-${crypto.randomUUID()}`;
    await report(proxy, "cf_bypass", { ttl_ms: 0 });
    await report(proxy, "cf_bypass", { ttl_ms: 5_000 });
    const r = await lease(proxy, 0);
    // Persisted value should remain 0 (permanent), even after a smaller TTL
    // attempt.  Implementation note: ``cfBypassUntil === 0`` is treated as
    // greater than any finite ``newCfBypassUntil`` so the max-monotonic policy
    // keeps the permanent flag.
    expect(r.cf_bypass_until).toBe(0);
  });
});

describe("P1-A — backwards compat", () => {
  it("legacy kind=cf still pushes a cfEvent and updates penalty_factor", async () => {
    const proxy = `p1a-cf-back-${crypto.randomUUID()}`;
    await report(proxy, "cf");
    const r = await lease(proxy, 0);
    expect(r.penalty_factor).toBe(1.3);
    expect(r.banned).toBe(false);
  });

  it("legacy kind=failure still pushes a cfEvent and updates penalty_factor", async () => {
    const proxy = `p1a-fail-back-${crypto.randomUUID()}`;
    await report(proxy, "failure");
    const r = await lease(proxy, 0);
    expect(r.penalty_factor).toBe(1.3);
  });
});

describe("P1-A — state dump surfaces effective banned/requires_cf_bypass", () => {
  it("after a ban, /state returns banned=true and bannedUntil>now", async () => {
    const proxy = `p1a-dump-ban-${crypto.randomUUID()}`;
    await report(proxy, "ban", { ttl_ms: 60_000 });
    const s = await dumpState(proxy);
    expect(s.banned).toBe(true);
    expect(s.bannedUntil).not.toBeNull();
    expect(s.bannedUntil!).toBeGreaterThan(s.now);
  });

  it("after a permanent cf_bypass, /state returns requires_cf_bypass=true and cfBypassUntil=0", async () => {
    const proxy = `p1a-dump-cfb-${crypto.randomUUID()}`;
    await report(proxy, "cf_bypass", { ttl_ms: 0 });
    const s = await dumpState(proxy);
    expect(s.requires_cf_bypass).toBe(true);
    expect(s.cfBypassUntil).toBe(0);
  });
});

describe("P2-D — health snapshot", () => {
  it("fresh proxy returns neutral score=0.5 (no data yet)", async () => {
    const proxy = `p2d-fresh-${crypto.randomUUID()}`;
    const r = await lease(proxy, 0);
    expect(r.health).toBeDefined();
    expect(r.health!.success_count).toBe(0);
    expect(r.health!.failure_count).toBe(0);
    expect(r.health!.latency_ema_ms).toBe(0);
    expect(r.health!.score).toBe(0.5);
  });

  it("kind=success bumps successEvents but not cfEvents", async () => {
    const proxy = `p2d-success-${crypto.randomUUID()}`;
    await report(proxy, "success");
    const r = await lease(proxy, 0);
    expect(r.health!.success_count).toBe(1);
    expect(r.health!.failure_count).toBe(0);
    // Penalty factor stays at the no-cf default (1.0).
    expect(r.penalty_factor).toBe(1.0);
  });

  it("kind=failure bumps both cfEvents AND failureEvents", async () => {
    const proxy = `p2d-failure-${crypto.randomUUID()}`;
    await report(proxy, "failure");
    const r = await lease(proxy, 0);
    expect(r.health!.failure_count).toBe(1);
    expect(r.health!.success_count).toBe(0);
    // failure also updates the penalty factor (legacy behaviour).
    expect(r.penalty_factor).toBeGreaterThanOrEqual(1.3);
  });

  it("score reflects success/failure ratio", async () => {
    const proxy = `p2d-ratio-${crypto.randomUUID()}`;
    // 4 successes, 1 failure → ratio 0.8
    for (let i = 0; i < 4; i++) await report(proxy, "success");
    await report(proxy, "failure");
    const r = await lease(proxy, 0);
    expect(r.health!.score).toBeGreaterThan(0.7);
    expect(r.health!.score).toBeLessThanOrEqual(0.8);
  });

  it("latency_ms folds into the EMA on any kind", async () => {
    const proxy = `p2d-latency-${crypto.randomUUID()}`;
    // First success at 1000ms → EMA = 1000 (initial = sample directly)
    await report(proxy, "success", { latency_ms: 1000 });
    const r1 = await lease(proxy, 0);
    expect(r1.health!.latency_ema_ms).toBe(1000);

    // Second success at 500ms → EMA = 1000*0.8 + 500*0.2 = 900
    await report(proxy, "success", { latency_ms: 500 });
    const r2 = await lease(proxy, 0);
    expect(r2.health!.latency_ema_ms).toBeCloseTo(900, 0);
  });

  it("high latency penalises the score even with 100% success ratio", async () => {
    const proxy = `p2d-slow-${crypto.randomUUID()}`;
    // 5 successes at 1500ms (1000 over baseline → -0.1 penalty).
    for (let i = 0; i < 5; i++) {
      await report(proxy, "success", { latency_ms: 1500 });
    }
    const r = await lease(proxy, 0);
    // EMA after 5 samples of 1500: starts at 1500, stays at 1500.
    expect(r.health!.latency_ema_ms).toBeCloseTo(1500, 0);
    // Score: ratio 1.0 minus latency penalty 0.1 = 0.9.
    expect(r.health!.score).toBeCloseTo(0.9, 1);
  });

  it("legacy kind=cf does NOT bump successEvents/failureEvents", async () => {
    const proxy = `p2d-cf-${crypto.randomUUID()}`;
    await report(proxy, "cf");
    const r = await lease(proxy, 0);
    expect(r.health!.success_count).toBe(0);
    expect(r.health!.failure_count).toBe(0);
  });

  it("ban / unban / cf_bypass do NOT bump successEvents/failureEvents", async () => {
    const proxy = `p2d-noband-${crypto.randomUUID()}`;
    await report(proxy, "ban", { ttl_ms: 60_000 });
    await report(proxy, "unban");
    await report(proxy, "cf_bypass", { ttl_ms: 60_000 });
    const r = await lease(proxy, 0);
    expect(r.health!.success_count).toBe(0);
    expect(r.health!.failure_count).toBe(0);
  });

  it("/state surfaces health alongside other derived fields", async () => {
    const proxy = `p2d-dump-${crypto.randomUUID()}`;
    await report(proxy, "success", { latency_ms: 800 });
    const s = await dumpState(proxy);
    expect(s.health).toBeDefined();
    expect(s.health!.success_count).toBe(1);
    expect(s.health!.latency_ema_ms).toBe(800);
    expect(s.successEvents).toBeDefined();
    expect(s.successEvents!.length).toBe(1);
  });
});

// ── E.4.3 — Extra-window saturation, max_wait cap, purgeExpired ──────

describe("E.4.3 — edge-case throttle tests", () => {
  it("extra-window saturation: many leases back-to-back eventually throttle", async () => {
    const proxy = `e43-sat-${crypto.randomUUID()}`;
    let lastWait = 0;
    let throttled = false;
    for (let i = 0; i < 30; i++) {
      const r = await lease(proxy, 0);
      if (r.reason === "throttle_extra" || r.reason === "throttle_long" || r.reason === "throttle_short") {
        throttled = true;
        break;
      }
      lastWait = r.wait_ms;
    }
    expect(throttled).toBe(true);
  });

  it("max_wait_capped is enforced when windows are fully saturated", async () => {
    const proxy = `e43-cap-${crypto.randomUUID()}`;
    for (let i = 0; i < 50; i++) {
      await lease(proxy, 0);
    }
    const r = await lease(proxy, 0);
    // MAX_LEASE_WAIT_MS = 300_000 (5 min)
    expect(r.wait_ms).toBeLessThanOrEqual(300_000);
  });

  it("purgeExpired drops timestamps older than the extra-window horizon", async () => {
    const proxy = `e43-purge-${crypto.randomUUID()}`;
    // Issue some leases so there are timestamps
    for (let i = 0; i < 5; i++) {
      await lease(proxy, 0);
    }
    // Dump state and verify timestamps exist
    const s1 = await dumpState(proxy);
    expect(s1.requestTimestamps.length).toBeGreaterThan(0);
    // All timestamps should be recent (within extra-window horizon of 7200s default)
    const now = Date.now();
    for (const ts of s1.requestTimestamps) {
      expect(ts).toBeGreaterThan(now - 7200 * 1000);
    }
  });
});
