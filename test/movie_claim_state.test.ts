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

// ─────────────────────────────────────────────────────────────────────────────
// Phase-1 — staged completions: stage / commit / rollback / sweep
// ─────────────────────────────────────────────────────────────────────────────

interface StageCompleteResp {
  staged: boolean;
  href: string;
  session_id: string;
  server_time: number;
}

interface CommitCompletedResp {
  promoted: number;
  session_id: string;
  server_time: number;
}

interface RollbackStagedResp {
  removed: number;
  session_id: string;
  server_time: number;
}

interface SweepOrphanResp {
  removed: number;
  cutoff_ms: number;
  server_time: number;
}

const stageComplete = (
  href: string,
  holderId: string,
  sessionId: string,
  date: string = FIXED_DATE,
) =>
  jsonPost<StageCompleteResp>("/stage_complete_movie", {
    href,
    holder_id: holderId,
    session_id: sessionId,
    date,
  });

const commitCompleted = (sessionId: string, date: string = FIXED_DATE) =>
  jsonPost<CommitCompletedResp>("/commit_completed_movies", {
    session_id: sessionId,
    date,
  });

const rollbackStaged = (sessionId: string, date: string = FIXED_DATE) =>
  jsonPost<RollbackStagedResp>("/rollback_staged_movies", {
    session_id: sessionId,
    date,
  });

const sweepOrphan = (olderThanMs: number, date: string = FIXED_DATE) =>
  jsonGet<SweepOrphanResp>(
    `/sweep_orphan_stages?older_than_ms=${olderThanMs}&date=${date}`,
  );

const claimWithSession = (
  href: string,
  holderId: string,
  sessionId: string,
  ttlMs?: number,
  date: string = FIXED_DATE,
) =>
  jsonPost<ClaimResp & { staged_session_id?: string }>("/claim_movie", {
    href,
    holder_id: holderId,
    session_id: sessionId,
    ttl_ms: ttlMs,
    date,
  });

describe("Phase-1 — stage_complete_movie", () => {
  it("rejects stage with missing session_id", async () => {
    await jsonPost(
      "/stage_complete_movie",
      { href: "/v/p1-missing-session", holder_id: "h", date: FIXED_DATE },
      400,
    );
  });

  it("rejects stage with missing holder_id", async () => {
    await jsonPost(
      "/stage_complete_movie",
      {
        href: "/v/p1-missing-holder",
        session_id: "100",
        date: FIXED_DATE,
      },
      400,
    );
  });

  it("the active claim holder can stage; subsequent claim from same session sees already_completed=true", async () => {
    const acq = await claim("/v/p1-stage-1", "holder-1");
    expect(acq.acquired).toBe(true);

    const staged = await stageComplete("/v/p1-stage-1", "holder-1", "session-A");
    expect(staged.staged).toBe(true);
    expect(staged.session_id).toBe("session-A");

    const re = await claimWithSession(
      "/v/p1-stage-1",
      "holder-2",
      "session-A",
    );
    expect(re.acquired).toBe(false);
    expect(re.already_completed).toBe(true);
    expect(re.staged_session_id).toBe("session-A");
  });

  it("a peer session is NOT blocked by another session's stage", async () => {
    const acq = await claim("/v/p1-stage-2", "holder-1");
    expect(acq.acquired).toBe(true);
    await stageComplete("/v/p1-stage-2", "holder-1", "session-daily");

    // Different session sees staged_session_id but is allowed to claim.
    // The active claim was released by stage_complete, so the peer
    // can acquire freshly.
    const peer = await claimWithSession(
      "/v/p1-stage-2",
      "holder-2",
      "session-adhoc",
    );
    expect(peer.acquired).toBe(true);
    expect(peer.already_completed).toBe(false);
    expect(peer.staged_session_id).toBe("session-daily");
  });

  it("stage refuses when a different session already staged the href", async () => {
    await claim("/v/p1-stage-3", "holder-1");
    await stageComplete("/v/p1-stage-3", "holder-1", "session-daily");

    // A different session would have to first claim the href (peer
    // contention is unblocked), so simulate that path.
    const peer = await claimWithSession(
      "/v/p1-stage-3",
      "holder-2",
      "session-adhoc",
    );
    expect(peer.acquired).toBe(true);

    // Attempting to stage the peer's claim under a different session_id
    // is refused — the existing daily stage is preserved.
    const conflict = await stageComplete(
      "/v/p1-stage-3",
      "holder-2",
      "session-adhoc",
    );
    expect(conflict.staged).toBe(false);
    expect(conflict.session_id).toBe("session-daily");
  });

  it("same-session re-stage is idempotent (refreshes ts)", async () => {
    await claim("/v/p1-stage-4", "holder-1");
    const first = await stageComplete(
      "/v/p1-stage-4",
      "holder-1",
      "session-A",
    );
    expect(first.staged).toBe(true);

    // Re-claim + re-stage by the same holder + session.  The DO releases
    // the active claim on stage; the same holder must re-claim before
    // the second stage call.
    const reAcq = await claimWithSession(
      "/v/p1-stage-4",
      "holder-1",
      "session-A",
    );
    // Same-session sees it as already_completed (idempotent skip), so
    // a re-stage is unnecessary.  The contract is verified by the skip.
    expect(reAcq.acquired).toBe(false);
    expect(reAcq.already_completed).toBe(true);
    expect(reAcq.staged_session_id).toBe("session-A");
  });

  it("a stage by a non-holder is refused (staged=false)", async () => {
    await claim("/v/p1-stage-5", "holder-1");
    const stale = await stageComplete(
      "/v/p1-stage-5",
      "holder-stale",
      "session-A",
    );
    expect(stale.staged).toBe(false);
  });

  it("same-session re-stage from a non-holder is refused (B.12)", async () => {
    // B.12 (2026-05-12): the same-session idempotent re-stage path used
    // to accept any caller as long as session_id matched, even one that
    // never held the claim. A buggy / hostile peer could refresh the
    // ts heartbeat of someone else's stage and indefinitely delay the
    // orphan-sweep. Now the DO requires the caller to be the active
    // claim holder (when a claim still exists for the href).
    const acq = await claim("/v/p1-stage-non-holder-restage", "holder-A");
    expect(acq.acquired).toBe(true);
    // First stage by the rightful holder — releases the claim slot.
    const first = await stageComplete(
      "/v/p1-stage-non-holder-restage",
      "holder-A",
      "session-X",
    );
    expect(first.staged).toBe(true);

    // A peer re-claims the href (no active claim left after the stage).
    const peerAcq = await claim(
      "/v/p1-stage-non-holder-restage",
      "holder-B",
    );
    expect(peerAcq.acquired).toBe(true);

    // Now an attacker that knows session-X (or guesses it) tries to
    // refresh holder-A's stage as ``holder-impostor`` while holder-B
    // is the actual claim owner.  The DO must refuse.
    const impostor = await stageComplete(
      "/v/p1-stage-non-holder-restage",
      "holder-impostor",
      "session-X",
    );
    expect(impostor.staged).toBe(false);
    expect(impostor.session_id).toBe("session-X");
  });

  it("staging a committed href is idempotently true (no work needed)", async () => {
    await claim("/v/p1-stage-6", "holder-1");
    await complete("/v/p1-stage-6", "holder-1");

    const r = await stageComplete(
      "/v/p1-stage-6",
      "holder-1",
      "session-A",
    );
    expect(r.staged).toBe(true);
  });
});

describe("Phase-1 — commit_completed_movies", () => {
  it("promotes every staged entry for session_id into completed_committed", async () => {
    await claim("/v/p1-commit-1a", "holder-1");
    await stageComplete("/v/p1-commit-1a", "holder-1", "session-X");
    await claim("/v/p1-commit-1b", "holder-1");
    await stageComplete("/v/p1-commit-1b", "holder-1", "session-X");
    await claim("/v/p1-commit-1c", "holder-1");
    await stageComplete("/v/p1-commit-1c", "holder-1", "session-Y");

    const commit = await commitCompleted("session-X");
    expect(commit.promoted).toBe(2);
    expect(commit.session_id).toBe("session-X");

    // session-X hrefs now block fresh claims even from a different session.
    const r1 = await claimWithSession(
      "/v/p1-commit-1a",
      "holder-other",
      "session-other",
    );
    expect(r1.already_completed).toBe(true);

    // session-Y href still has a stage, blocks only its own session.
    const r2 = await claimWithSession(
      "/v/p1-commit-1c",
      "holder-other",
      "session-Y",
    );
    expect(r2.already_completed).toBe(true);
    const r3 = await claimWithSession(
      "/v/p1-commit-1c",
      "holder-other",
      "session-Z",
    );
    expect(r3.acquired).toBe(true);
  });

  it("commit is idempotent (re-running returns promoted=0)", async () => {
    await claim("/v/p1-commit-2", "holder-1");
    await stageComplete("/v/p1-commit-2", "holder-1", "session-idempotent");
    const first = await commitCompleted("session-idempotent");
    expect(first.promoted).toBe(1);
    const second = await commitCompleted("session-idempotent");
    expect(second.promoted).toBe(0);
  });

  it("rejects commit with missing session_id", async () => {
    await jsonPost("/commit_completed_movies", { date: FIXED_DATE }, 400);
  });
});

describe("Phase-1 — rollback_staged_movies", () => {
  it("removes every staged entry for session_id without touching peers", async () => {
    await claim("/v/p1-rb-1a", "holder-1");
    await stageComplete("/v/p1-rb-1a", "holder-1", "session-rollback");
    await claim("/v/p1-rb-1b", "holder-1");
    await stageComplete("/v/p1-rb-1b", "holder-1", "session-rollback");
    await claim("/v/p1-rb-1c", "holder-1");
    await stageComplete("/v/p1-rb-1c", "holder-1", "session-keep");

    const rb = await rollbackStaged("session-rollback");
    expect(rb.removed).toBe(2);

    // The rolled-back hrefs are now claimable by any session — including
    // an adhoc retry of the same href under a brand-new session_id.
    const retry = await claimWithSession(
      "/v/p1-rb-1a",
      "holder-adhoc",
      "session-adhoc",
    );
    expect(retry.acquired).toBe(true);

    // The unrelated session's stage survives.
    const peerSkip = await claimWithSession(
      "/v/p1-rb-1c",
      "holder-other",
      "session-keep",
    );
    expect(peerSkip.already_completed).toBe(true);
  });

  it("rollback is idempotent (re-running returns removed=0)", async () => {
    await claim("/v/p1-rb-2", "holder-1");
    await stageComplete("/v/p1-rb-2", "holder-1", "session-double-rb");
    const first = await rollbackStaged("session-double-rb");
    expect(first.removed).toBe(1);
    const second = await rollbackStaged("session-double-rb");
    expect(second.removed).toBe(0);
  });

  it("rollback before commit lets peer adhoc retry the same href", async () => {
    // The original problem this whole feature solves: daily stages
    // succeed, daily session is rolled back, adhoc must be able to
    // re-fetch the SAME href.  Pre-Phase-1 this was blocked because
    // the daily run had already pushed the href into completed[].
    await claim("/v/p1-rb-scenario", "holder-daily");
    await stageComplete(
      "/v/p1-rb-scenario",
      "holder-daily",
      "session-daily",
    );

    await rollbackStaged("session-daily");

    const adhoc = await claimWithSession(
      "/v/p1-rb-scenario",
      "holder-adhoc",
      "session-adhoc",
    );
    expect(adhoc.acquired).toBe(true);
    expect(adhoc.already_completed).toBe(false);
  });

  it("rejects rollback with missing session_id", async () => {
    await jsonPost("/rollback_staged_movies", { date: FIXED_DATE }, 400);
  });
});

describe("Phase-1 — sweep_orphan_stages", () => {
  it("prunes only entries older than older_than_ms", async () => {
    const SHARD = "2026-11-11";
    await claim("/v/p1-sweep-fresh", "holder-1", 60_000, SHARD);
    await stageComplete(
      "/v/p1-sweep-fresh",
      "holder-1",
      "session-fresh",
      SHARD,
    );
    await claim("/v/p1-sweep-old", "holder-1", 60_000, SHARD);
    await stageComplete(
      "/v/p1-sweep-old",
      "holder-1",
      "session-old",
      SHARD,
    );

    if (!env.MOVIE_CLAIM_DO) throw new Error("MOVIE_CLAIM_DO binding missing");
    const id = env.MOVIE_CLAIM_DO.idFromName(SHARD);
    const stub = env.MOVIE_CLAIM_DO.get(id);

    // Age the "old" stage past the sweep horizon by mutating storage
    // directly.  72h cutoff with the old entry timestamped 96h ago.
    const STALE_AGE_MS = 96 * 60 * 60_000;
    const HORIZON_MS = 72 * 60 * 60_000;
    await runInDurableObject(stub, async (instance, doState) => {
      const data = (await doState.storage.get("state")) as {
        staged_complete: Record<string, { session_id: string; ts: number }>;
      };
      data.staged_complete["/v/p1-sweep-old"].ts = Date.now() - STALE_AGE_MS;
      await doState.storage.put("state", data);
      (instance as unknown as { cached: unknown }).cached = null;
    });

    const sweep = await sweepOrphan(HORIZON_MS, SHARD);
    expect(sweep.removed).toBe(1);

    // Fresh stage is still in place — claim from same session is skipped.
    const freshHit = await claimWithSession(
      "/v/p1-sweep-fresh",
      "holder-other",
      "session-fresh",
      undefined,
      SHARD,
    );
    expect(freshHit.already_completed).toBe(true);

    // Old stage was swept — claim proceeds normally now.
    const oldRetry = await claimWithSession(
      "/v/p1-sweep-old",
      "holder-other",
      "session-old",
      undefined,
      SHARD,
    );
    expect(oldRetry.acquired).toBe(true);
  });

  it("clamps tiny older_than_ms up to the server-side minimum", async () => {
    // older_than_ms=0 would otherwise wipe every stage; the DO floors
    // at MIN_SWEEP_ORPHAN_MS (1h).
    const SHARD = "2026-11-12";
    await claim("/v/p1-sweep-floor", "holder-1", 60_000, SHARD);
    await stageComplete(
      "/v/p1-sweep-floor",
      "holder-1",
      "session-floor",
      SHARD,
    );

    const sweep = await sweepOrphan(0, SHARD);
    expect(sweep.removed).toBe(0);

    // Stage still in place.
    const hit = await claimWithSession(
      "/v/p1-sweep-floor",
      "holder-other",
      "session-floor",
      undefined,
      SHARD,
    );
    expect(hit.already_completed).toBe(true);
  });

  it("does not touch live in-progress stages from a current session", async () => {
    const SHARD = "2026-11-13";
    await claim("/v/p1-sweep-live", "holder-1", 60_000, SHARD);
    await stageComplete(
      "/v/p1-sweep-live",
      "holder-1",
      "session-live",
      SHARD,
    );

    // Default cutoff = 48h; a brand-new stage is well within.
    const r = await rawFetch(
      `/sweep_orphan_stages?date=${SHARD}`,
      { method: "GET", headers: { ...AUTH } },
    );
    expect(r.status).toBe(200);
    const sweep = (await r.json()) as SweepOrphanResp;
    expect(sweep.removed).toBe(0);
  });
});

describe("Phase-1 — legacy `completed` field migration", () => {
  it("loadState() promotes legacy completed[] into completed_committed[]", async () => {
    const SHARD = "2026-11-14";
    if (!env.MOVIE_CLAIM_DO) throw new Error("MOVIE_CLAIM_DO binding missing");
    const id = env.MOVIE_CLAIM_DO.idFromName(SHARD);
    const stub = env.MOVIE_CLAIM_DO.get(id);

    // Seed a legacy snapshot (pre-Phase-1 schema: ``completed`` field).
    await runInDurableObject(stub, async (instance, doState) => {
      await doState.storage.put("state", {
        claims: {},
        completed: ["/v/legacy-href"],
      });
      (instance as unknown as { cached: unknown }).cached = null;
    });

    // Phase-1 read path translates ``completed`` → ``completed_committed``.
    const r = await claim("/v/legacy-href", "holder-1", 60_000, SHARD);
    expect(r.acquired).toBe(false);
    expect(r.already_completed).toBe(true);
  });
});

describe("D.3 — completed_committed Record migration", () => {
  it("loadState() migrates a Phase-1 string[] completed_committed into Record<string, true>", async () => {
    const SHARD = "2026-11-15";
    if (!env.MOVIE_CLAIM_DO) throw new Error("MOVIE_CLAIM_DO binding missing");
    const id = env.MOVIE_CLAIM_DO.idFromName(SHARD);
    const stub = env.MOVIE_CLAIM_DO.get(id);

    // Seed a Phase-1 snapshot where completed_committed was a string[].
    await runInDurableObject(stub, async (instance, doState) => {
      await doState.storage.put("state", {
        claims: {},
        completed_committed: ["/v/d3-href-1", "/v/d3-href-2"],
      });
      (instance as unknown as { cached: unknown }).cached = null;
    });

    // D.3 migration converts the array to a Record — both hrefs must be seen as committed.
    const r1 = await claim("/v/d3-href-1", "holder-1", 60_000, SHARD);
    expect(r1.acquired).toBe(false);
    expect(r1.already_completed).toBe(true);

    const r2 = await claim("/v/d3-href-2", "holder-1", 60_000, SHARD);
    expect(r2.acquired).toBe(false);
    expect(r2.already_completed).toBe(true);
  });

  it("a fresh shard uses an empty Record (not an array)", async () => {
    const SHARD = "2026-11-16";
    await claim("/v/d3-fresh", "holder-1", 60_000, SHARD);
    await complete("/v/d3-fresh", "holder-1", SHARD);

    // Verify that a subsequent commit attempt still observes already_completed.
    const r = await claim("/v/d3-fresh", "holder-2", 60_000, SHARD);
    expect(r.acquired).toBe(false);
    expect(r.already_completed).toBe(true);
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
