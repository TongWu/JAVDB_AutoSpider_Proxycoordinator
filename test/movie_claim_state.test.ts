import {
  env,
  createExecutionContext,
  runInDurableObject,
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — same shape as test/global_login_state.test.ts so the suites share
// vocabulary and isolated-storage assumptions.  vitest-pool-workers gives
// each test its own per-DO storage frame; we never reach into raw storage
// directly except through `runInDurableObject` for alarm tests.
// ─────────────────────────────────────────────────────────────────────────────

async function rawFetch(path: string, init: RequestInit): Promise<Response> {
  const req = new Request(`https://test.invalid${path}`, init);
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function jsonPost<T>(
  path: string,
  body: unknown,
  expectStatus = 200,
): Promise<T> {
  const res = await rawFetch(path, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(expectStatus);
  return (await res.json()) as T;
}

async function jsonGet<T>(path: string, expectStatus = 200): Promise<T> {
  const res = await rawFetch(path, { method: "GET", headers: { ...AUTH } });
  expect(res.status).toBe(expectStatus);
  return (await res.json()) as T;
}

interface ClaimResp {
  acquired: boolean;
  current_holder_id: string;
  expires_at: number;
  already_completed: boolean;
  cooldown_until?: number;
  last_error_kind?: string;
  fail_count?: number;
  server_time: number;
}

interface ReleaseResp {
  released: boolean;
  server_time: number;
}

interface CompleteResp {
  completed: boolean;
  href: string;
  server_time: number;
}

interface StatusResp {
  current_holder_id: string | null;
  expires_at: number;
  already_completed: boolean;
  cooldown_until?: number;
  last_error_kind?: string;
  fail_count?: number;
  server_time: number;
}

const FIXED_DATE = "2026-05-03";

const claim = (
  href: string,
  holderId: string,
  ttlMs?: number,
  date: string = FIXED_DATE,
) =>
  jsonPost<ClaimResp>("/claim_movie", {
    href,
    holder_id: holderId,
    ttl_ms: ttlMs,
    date,
  });

const release = (href: string, holderId: string, date: string = FIXED_DATE) =>
  jsonPost<ReleaseResp>("/release_movie", {
    href,
    holder_id: holderId,
    date,
  });

const complete = (href: string, holderId: string, date: string = FIXED_DATE) =>
  jsonPost<CompleteResp>("/complete_movie", {
    href,
    holder_id: holderId,
    date,
  });

const status = (href: string, date: string = FIXED_DATE) =>
  jsonGet<StatusResp>(
    `/movie_status?href=${encodeURIComponent(href)}&date=${date}`,
  );

// ─────────────────────────────────────────────────────────────────────────────
// Auth + routing
// ─────────────────────────────────────────────────────────────────────────────

describe("auth & routing", () => {
  it("rejects /claim_movie without bearer token", async () => {
    const res = await rawFetch("/claim_movie", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ href: "/v/abc", holder_id: "h" }),
    });
    expect(res.status).toBe(401);
  });

  it("/movie_status is GET-allowed (in GET_ALLOWED_PATHS)", async () => {
    // Returns 400 for missing href — the important assertion is that we got
    // past the GET method check (would be 405 otherwise).
    const res = await rawFetch("/movie_status", {
      method: "GET",
      headers: { ...AUTH },
    });
    expect(res.status).toBe(400);
  });

  it("400 on missing href in claim_movie", async () => {
    await jsonPost("/claim_movie", { holder_id: "h", date: FIXED_DATE }, 400);
  });

  it("400 on missing holder_id in claim_movie", async () => {
    await jsonPost("/claim_movie", { href: "/v/abc", date: FIXED_DATE }, 400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// claim_movie — happy path & contention
// ─────────────────────────────────────────────────────────────────────────────

describe("claim_movie — fresh acquire", () => {
  it("first claim succeeds and returns the caller as current holder", async () => {
    const r = await claim("/v/movie-A", "holder-1");
    expect(r.acquired).toBe(true);
    expect(r.current_holder_id).toBe("holder-1");
    expect(r.expires_at).toBeGreaterThan(r.server_time);
    expect(r.already_completed).toBe(false);
  });

  it("returns the configured default TTL when ttl_ms is omitted", async () => {
    const r = await claim("/v/movie-default-ttl", "holder-1");
    // Default = 30 min = 1_800_000 ms (DEFAULT_MOVIE_CLAIM_TTL_MS).
    expect(r.expires_at - r.server_time).toBeGreaterThan(1_700_000);
    expect(r.expires_at - r.server_time).toBeLessThanOrEqual(1_801_000);
  });

  it("clamps a tiny ttl_ms up to MOVIE_CLAIM_TTL_MIN_MS (60 s)", async () => {
    const r = await claim("/v/movie-tiny-ttl", "holder-1", 100);
    expect(r.expires_at - r.server_time).toBeGreaterThanOrEqual(60_000 - 100);
  });

  it("clamps a huge ttl_ms down to MOVIE_CLAIM_TTL_MAX_MS (2 h)", async () => {
    const r = await claim("/v/movie-huge-ttl", "holder-1", 999_999_999);
    expect(r.expires_at - r.server_time).toBeLessThanOrEqual(2 * 60 * 60 * 1000 + 100);
  });
});

describe("claim_movie — contention", () => {
  it("a second holder is denied while the first is still active", async () => {
    const first = await claim("/v/movie-B", "holder-1");
    expect(first.acquired).toBe(true);

    const second = await claim("/v/movie-B", "holder-2");
    expect(second.acquired).toBe(false);
    expect(second.current_holder_id).toBe("holder-1");
    expect(second.already_completed).toBe(false);
  });

  it("the same holder gets idempotent renewal (acquired=true, expiry refreshed)", async () => {
    const first = await claim("/v/movie-C", "holder-1", 60_000);
    const second = await claim("/v/movie-C", "holder-1", 90_000);
    expect(second.acquired).toBe(true);
    expect(second.current_holder_id).toBe("holder-1");
    // TTL was refreshed — expires_at must be later than the first claim.
    expect(second.expires_at).toBeGreaterThanOrEqual(first.expires_at);
  });
});

describe("release_movie", () => {
  it("the owner can release; a fresh claim from another holder then succeeds", async () => {
    await claim("/v/movie-D", "holder-1");
    const released = await release("/v/movie-D", "holder-1");
    expect(released.released).toBe(true);

    const second = await claim("/v/movie-D", "holder-2");
    expect(second.acquired).toBe(true);
    expect(second.current_holder_id).toBe("holder-2");
  });

  it("a non-owner release is silently ignored (released:false)", async () => {
    await claim("/v/movie-E", "holder-1");
    const released = await release("/v/movie-E", "holder-2");
    expect(released.released).toBe(false);

    // Confirm the original claim is still in place.
    const second = await claim("/v/movie-E", "holder-3");
    expect(second.acquired).toBe(false);
    expect(second.current_holder_id).toBe("holder-1");
  });

  it("releasing an unknown href returns released:false (and does not error)", async () => {
    const r = await release("/v/nonexistent", "holder-1");
    expect(r.released).toBe(false);
  });
});

describe("complete_movie", () => {
  it("the owner can complete; subsequent claim returns already_completed=true", async () => {
    await claim("/v/movie-F", "holder-1");
    const completed = await complete("/v/movie-F", "holder-1");
    expect(completed.completed).toBe(true);
    expect(completed.href).toBe("/v/movie-F");

    const re = await claim("/v/movie-F", "holder-2");
    expect(re.acquired).toBe(false);
    expect(re.already_completed).toBe(true);
  });

  it("complete is idempotent: repeating after success returns completed:true", async () => {
    await claim("/v/movie-G", "holder-1");
    const first = await complete("/v/movie-G", "holder-1");
    expect(first.completed).toBe(true);

    // Repeated complete (any holder) — once it's in `completed[]`, idempotent.
    const second = await complete("/v/movie-G", "holder-2");
    expect(second.completed).toBe(true);
  });

  it("a stale-holder complete returns completed:false", async () => {
    await claim("/v/movie-H", "holder-1");
    const stale = await complete("/v/movie-H", "holder-2");
    expect(stale.completed).toBe(false);

    // The original claim must still be intact.
    const s = await status("/v/movie-H");
    expect(s.current_holder_id).toBe("holder-1");
    expect(s.already_completed).toBe(false);
  });
});

describe("movie_status (debug GET)", () => {
  it("returns null/0/false for an unknown href", async () => {
    const s = await status("/v/never-claimed");
    expect(s.current_holder_id).toBeNull();
    expect(s.expires_at).toBe(0);
    expect(s.already_completed).toBe(false);
  });

  it("surfaces the active claim while in flight", async () => {
    await claim("/v/movie-I", "holder-1");
    const s = await status("/v/movie-I");
    expect(s.current_holder_id).toBe("holder-1");
    expect(s.expires_at).toBeGreaterThan(s.server_time);
    expect(s.already_completed).toBe(false);
  });

  it("surfaces already_completed after complete_movie", async () => {
    await claim("/v/movie-J", "holder-1");
    await complete("/v/movie-J", "holder-1");
    const s = await status("/v/movie-J");
    expect(s.already_completed).toBe(true);
    expect(s.current_holder_id).toBeNull();
    expect(s.expires_at).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-day sharding — different `date` values must isolate state.
// ─────────────────────────────────────────────────────────────────────────────

describe("per-day sharding", () => {
  it("a claim in day-1 does not block the same href in day-2", async () => {
    const first = await claim("/v/movie-shared", "holder-1", 60_000, "2026-01-01");
    expect(first.acquired).toBe(true);

    const second = await claim("/v/movie-shared", "holder-2", 60_000, "2026-01-02");
    expect(second.acquired).toBe(true);
    expect(second.current_holder_id).toBe("holder-2");
  });

  it("/movie_status uses the same per-day shard as /claim_movie", async () => {
    await claim("/v/movie-shard-status", "holder-1", 60_000, "2026-02-15");
    const s1 = await status("/v/movie-shard-status", "2026-02-15");
    expect(s1.current_holder_id).toBe("holder-1");

    // Different shard → no record.
    const s2 = await status("/v/movie-shard-status", "2026-02-16");
    expect(s2.current_holder_id).toBeNull();
  });

  it("an invalid date string falls back to 'today' rather than 400ing", async () => {
    // `resolveClaimShard` rejects malformed dates and rolls forward to the
    // server's Asia/Singapore date — the contract is "always succeed; pick a
    // sensible default".  We just assert the call doesn't error out.
    const r = await jsonPost<ClaimResp>("/claim_movie", {
      href: "/v/movie-bad-date",
      holder_id: "holder-1",
      date: "not-a-date",
    });
    expect(r.acquired).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DO Alarm GC — verifies that a stale claim is cleared by the alarm handler
// and that the alarm is re-armed when the shard still has live claims.
// ─────────────────────────────────────────────────────────────────────────────

describe("alarm — GC of expired claims", () => {
  // We intentionally invoke `instance.alarm()` directly inside
  // ``runInDurableObject`` rather than going through the framework's
  // ``runDurableObjectAlarm(stub)`` helper.  The latter spans an extra JSRPC
  // boundary which, combined with the synthetic storage mutation we use to
  // age out a claim, trips vitest-pool-workers' "Failed to pop isolated
  // storage stack frame" guard (see the comment on `forwardToGlobalLoginStateDo`
  // in `src/index.ts`).  Calling the method directly keeps every read/write
  // inside one frame and is sufficient — the alarm handler itself is the
  // unit under test, not the alarm scheduler.

  it("alarm() prunes expired claims and frees the slot", async () => {
    const r1 = await claim("/v/movie-K", "holder-1", 60_000, FIXED_DATE);
    expect(r1.acquired).toBe(true);

    if (!env.MOVIE_CLAIM_DO) throw new Error("MOVIE_CLAIM_DO binding missing");
    const id = env.MOVIE_CLAIM_DO.idFromName(FIXED_DATE);
    const stub = env.MOVIE_CLAIM_DO.get(id);

    await runInDurableObject(stub, async (instance, doState) => {
      // Force the claim into the past so alarm() prunes it on the next sweep.
      const existing = (await doState.storage.get("state")) as {
        claims: Record<string, { holder_id: string; claimed_at: number; expires_at: number }>;
        completed: string[];
      };
      existing.claims["/v/movie-K"].expires_at = Date.now() - 1000;
      await doState.storage.put("state", existing);
      // Drop the in-memory cache so alarm() reloads from storage.
      (instance as unknown as { cached: unknown }).cached = null;

      // Invoke the alarm handler directly.
      await (instance as unknown as { alarm: () => Promise<void> }).alarm();

      // Verify the entry was pruned in storage.
      const after = (await doState.storage.get("state")) as {
        claims: Record<string, unknown>;
        completed: string[];
      };
      expect(after.claims["/v/movie-K"]).toBeUndefined();
    });

    // After GC the slot is free → a different holder can claim it.
    const r2 = await claim("/v/movie-K", "holder-2", 60_000, FIXED_DATE);
    expect(r2.acquired).toBe(true);
    expect(r2.current_holder_id).toBe("holder-2");
  });

  it("alarm() preserves completed[] (completion outcomes are not GC'd)", async () => {
    await claim("/v/movie-L", "holder-1", 60_000);
    await complete("/v/movie-L", "holder-1");

    if (!env.MOVIE_CLAIM_DO) throw new Error("MOVIE_CLAIM_DO binding missing");
    const id = env.MOVIE_CLAIM_DO.idFromName(FIXED_DATE);
    const stub = env.MOVIE_CLAIM_DO.get(id);

    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { alarm: () => Promise<void> }).alarm();
    });

    const s = await status("/v/movie-L");
    expect(s.already_completed).toBe(true);
  });

  it("alarm() re-arms itself when claims remain after GC", async () => {
    await claim("/v/movie-M-stale", "holder-1", 60_000, FIXED_DATE);
    await claim("/v/movie-M-fresh", "holder-2", 60_000, FIXED_DATE);

    if (!env.MOVIE_CLAIM_DO) throw new Error("MOVIE_CLAIM_DO binding missing");
    const id = env.MOVIE_CLAIM_DO.idFromName(FIXED_DATE);
    const stub = env.MOVIE_CLAIM_DO.get(id);

    await runInDurableObject(stub, async (instance, doState) => {
      const existing = (await doState.storage.get("state")) as {
        claims: Record<string, { holder_id: string; claimed_at: number; expires_at: number }>;
        completed: string[];
      };
      existing.claims["/v/movie-M-stale"].expires_at = Date.now() - 1000;
      await doState.storage.put("state", existing);
      // Reset cache + the alarmScheduled bookkeeping so scheduleAlarm()
      // actually re-arms (otherwise the "already scheduled" short-circuit
      // would prevent the call from reaching storage.setAlarm).
      (instance as unknown as { cached: unknown }).cached = null;
      (instance as unknown as { alarmScheduled: boolean }).alarmScheduled = false;
      // Clear any previously-set alarm so we observe the new arming
      // unambiguously.
      await doState.storage.deleteAlarm();

      await (instance as unknown as { alarm: () => Promise<void> }).alarm();

      const alarmTime = await doState.storage.getAlarm();
      expect(alarmTime).not.toBeNull();
      expect(alarmTime!).toBeGreaterThan(Date.now());
    });
  });

  it("alarm() does NOT re-arm when no claims remain", async () => {
    if (!env.MOVIE_CLAIM_DO) throw new Error("MOVIE_CLAIM_DO binding missing");
    const id = env.MOVIE_CLAIM_DO.idFromName("2026-09-01");
    const stub = env.MOVIE_CLAIM_DO.get(id);

    await runInDurableObject(stub, async (instance, doState) => {
      // Seed an empty-claims snapshot directly so the alarm sees nothing
      // to prune AND nothing to schedule against.
      await doState.storage.put("state", { claims: {}, completed: [] });
      (instance as unknown as { cached: unknown }).cached = null;
      (instance as unknown as { alarmScheduled: boolean }).alarmScheduled = false;
      await doState.storage.deleteAlarm();

      await (instance as unknown as { alarm: () => Promise<void> }).alarm();

      const alarmTime = await doState.storage.getAlarm();
      expect(alarmTime).toBeNull();
    });
  });

  it("scheduleAlarm() arms an alarm on the first claim", async () => {
    if (!env.MOVIE_CLAIM_DO) throw new Error("MOVIE_CLAIM_DO binding missing");
    const shard = "2026-10-01";
    await claim("/v/first-claim", "holder-1", 60_000, shard);

    const id = env.MOVIE_CLAIM_DO.idFromName(shard);
    const stub = env.MOVIE_CLAIM_DO.get(id);
    await runInDurableObject(stub, async (_instance, doState) => {
      const alarmTime = await doState.storage.getAlarm();
      expect(alarmTime).not.toBeNull();
      expect(alarmTime!).toBeGreaterThan(Date.now());
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cached state — every write path refreshes the in-memory cache so subsequent
// reads in the same DO instance observe fresh data without a storage round-trip.
// ─────────────────────────────────────────────────────────────────────────────

describe("cached state coherence", () => {
  it("claim → status (same DO instance) sees the new holder without going to storage", async () => {
    await claim("/v/movie-N", "holder-1");
    const s = await status("/v/movie-N");
    expect(s.current_holder_id).toBe("holder-1");
  });

  it("complete → claim (same DO instance) sees already_completed=true", async () => {
    await claim("/v/movie-O", "holder-1");
    await complete("/v/movie-O", "holder-1");
    const r = await claim("/v/movie-O", "holder-2");
    expect(r.already_completed).toBe(true);
    expect(r.acquired).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P2-A — failure / cooldown / dead-letter on top of the MovieClaim DO.
// ─────────────────────────────────────────────────────────────────────────────

interface ReportFailureResp {
  fail_count: number;
  cooldown_until: number;
  dead_lettered: boolean;
  server_time: number;
}

const reportFailure = (
  href: string,
  holderId: string = "h",
  errorKind: string = "http_500",
  cooldownMs?: number,
  date: string = FIXED_DATE,
) =>
  jsonPost<ReportFailureResp>("/report_failure", {
    href,
    holder_id: holderId,
    error_kind: errorKind,
    cooldown_ms: cooldownMs,
    date,
  });

describe("P2-A — report_failure & cooldown", () => {
  it("first failure puts the href in the 60 s cooldown bucket", async () => {
    const r = await reportFailure("/v/p2a-1", "holder-1");
    expect(r.fail_count).toBe(1);
    expect(r.dead_lettered).toBe(false);
    // Default ladder for fail_count=1 is 60 s.
    expect(r.cooldown_until - r.server_time).toBeGreaterThanOrEqual(59_000);
    expect(r.cooldown_until - r.server_time).toBeLessThanOrEqual(61_000);
  });

  it("claim is rejected while cooldown is active and surfaces the metadata", async () => {
    await reportFailure("/v/p2a-2", "holder-1", "parse_error");

    const r = await claim("/v/p2a-2", "holder-fresh");
    expect(r.acquired).toBe(false);
    expect(r.already_completed).toBe(false);
    expect(r.cooldown_until).toBeGreaterThan(r.server_time);
    expect(r.last_error_kind).toBe("parse_error");
    expect(r.fail_count).toBe(1);
  });

  it("claim is allowed once cooldown expires (caller-overridden 1 ms)", async () => {
    // Use a 1 ms override so the test doesn't sleep for 60 s.  The DO
    // applies the override directly when present.
    const f = await reportFailure("/v/p2a-3", "holder-1", "k", 1);
    expect(f.cooldown_until - f.server_time).toBeLessThanOrEqual(50);

    // Wait a couple of ticks for the cooldown to elapse.
    await new Promise((r) => setTimeout(r, 20));

    const r = await claim("/v/p2a-3", "holder-2");
    expect(r.acquired).toBe(true);
  });

  it("cooldown bumps with each consecutive failure (ladder schedule)", async () => {
    const r1 = await reportFailure("/v/p2a-4", "h");
    const r2 = await reportFailure("/v/p2a-4", "h");
    expect(r1.fail_count).toBe(1);
    expect(r2.fail_count).toBe(2);
    expect(r2.cooldown_until - r2.server_time).toBeGreaterThan(
      r1.cooldown_until - r1.server_time,
    );
  });

  it("dead-letters after the threshold (default 8 failures)", async () => {
    for (let i = 0; i < 7; i++) await reportFailure("/v/p2a-dl", "h");
    const r = await reportFailure("/v/p2a-dl", "h");
    expect(r.fail_count).toBe(8);
    expect(r.dead_lettered).toBe(true);
  });

  it("complete after recovery wipes the failure record", async () => {
    // Use 1 ms cooldown so we don't have to wait the real 60 s.
    await reportFailure("/v/p2a-5", "holder-1", "k", 1);
    await new Promise((r) => setTimeout(r, 20));
    const acq = await claim("/v/p2a-5", "holder-1");
    expect(acq.acquired).toBe(true);

    await complete("/v/p2a-5", "holder-1");

    // /movie_status now sees no failure record.
    const s = await status("/v/p2a-5");
    expect(s.fail_count).toBe(0);
    expect(s.cooldown_until).toBe(0);
    expect(s.last_error_kind).toBe("");
  });

  it("report_failure releases the active claim if the reporter holds it", async () => {
    const acq = await claim("/v/p2a-6", "holder-1");
    expect(acq.acquired).toBe(true);

    await reportFailure("/v/p2a-6", "holder-1", "timeout", 1);
    await new Promise((r) => setTimeout(r, 20));

    // Slot is free for a new holder once cooldown elapses.
    const next = await claim("/v/p2a-6", "holder-2");
    expect(next.acquired).toBe(true);
    expect(next.current_holder_id).toBe("holder-2");
  });

  it("non-owner failure leaves the claim alone but still increments fail_count", async () => {
    const acq = await claim("/v/p2a-7", "holder-A");
    expect(acq.acquired).toBe(true);

    // A different holder reports failure (e.g. observer running ops checks).
    const fr = await reportFailure("/v/p2a-7", "holder-B", "side-channel");
    expect(fr.fail_count).toBe(1);

    // Slot still belongs to holder-A.
    const status1 = await status("/v/p2a-7");
    expect(status1.current_holder_id).toBe("holder-A");
  });

  it("400 on missing href in /report_failure", async () => {
    await jsonPost("/report_failure", { holder_id: "h", date: FIXED_DATE }, 400);
  });

  it("/movie_status surfaces fail_count + last_error_kind for ops dashboards", async () => {
    await reportFailure("/v/p2a-status", "h", "http_503");
    const s = await status("/v/p2a-status");
    expect(s.fail_count).toBe(1);
    expect(s.last_error_kind).toBe("http_503");
    expect(s.cooldown_until).toBeGreaterThan(s.server_time);
  });
});

describe("P2-A — alarm GC of stale failure records", () => {
  it("alarm() prunes failure entries older than MOVIE_CLAIM_FAILURE_TTL_MS", async () => {
    // Use a unique date so other tests' state doesn't leak in.
    const D = "2026-09-09";
    await reportFailure("/v/p2a-gc", "h", "k", 1, D);

    if (!env.MOVIE_CLAIM_DO) throw new Error("MOVIE_CLAIM_DO binding missing");
    const id = env.MOVIE_CLAIM_DO.idFromName(D);
    const stub = env.MOVIE_CLAIM_DO.get(id);

    await runInDurableObject(stub, async (instance, doState) => {
      const data = (await doState.storage.get("state")) as {
        claims: Record<string, unknown>;
        completed: string[];
        failures: Record<string, { last_failure_at: number }>;
      };
      // Age the failure record past the 24h TTL.
      data.failures["/v/p2a-gc"].last_failure_at = Date.now() - 25 * 60 * 60_000;
      await doState.storage.put("state", data);
      (instance as unknown as { cached: unknown }).cached = null;
      (instance as unknown as { alarmScheduled: boolean }).alarmScheduled = false;

      await (instance as unknown as { alarm: () => Promise<void> }).alarm();

      const after = (await doState.storage.get("state")) as {
        failures: Record<string, unknown>;
      };
      expect(after.failures["/v/p2a-gc"]).toBeUndefined();
    });
  });
});
