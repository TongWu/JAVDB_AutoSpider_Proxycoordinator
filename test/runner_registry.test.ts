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
// Helpers — same shape as test/movie_claim_state.test.ts so the suites share
// vocabulary and isolated-storage assumptions.  The registry is a singleton
// (`idFromName("runners")`) so we don't need a per-test shard ID.
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

// ── response-shape mirrors of src/types.ts ─────────────────────────────────

interface RunnerInfo {
  holder_id: string;
  workflow_run_id: string;
  workflow_name: string;
  started_at: number;
  last_heartbeat: number;
  proxy_pool_hash: string;
  page_range: string | null;
}

interface PoolHashSummary {
  hash: string;
  count: number;
}

interface RegisterResp {
  registered: boolean;
  active_runners: RunnerInfo[];
  pool_hash_summary: PoolHashSummary[];
  movie_claim_recommended?: boolean;
  movie_claim_min_runners?: number;
  server_time: number;
}

interface HeartbeatResp {
  alive: boolean;
  movie_claim_recommended?: boolean;
  movie_claim_min_runners?: number;
  server_time: number;
}

interface UnregisterResp {
  unregistered: boolean;
  server_time: number;
}

interface ActiveResp {
  active_runners: RunnerInfo[];
  pool_hash_summary: PoolHashSummary[];
  server_time: number;
}

interface RegistryStorage {
  runners: Record<string, RunnerInfo>;
}

// Convenience wrappers — every register call goes through the same JSON body
// shape so tests stay readable.

interface RegisterArgs {
  holder_id: string;
  workflow_run_id?: string;
  workflow_name?: string;
  started_at?: number;
  proxy_pool_hash?: string;
  page_range?: string | null;
}

async function register(args: RegisterArgs): Promise<RegisterResp> {
  return jsonPost<RegisterResp>("/register", args);
}

async function heartbeat(holderId: string): Promise<HeartbeatResp> {
  return jsonPost<HeartbeatResp>("/heartbeat", { holder_id: holderId });
}

async function unregister(holderId: string): Promise<UnregisterResp> {
  return jsonPost<UnregisterResp>("/unregister", { holder_id: holderId });
}

async function active(): Promise<ActiveResp> {
  return jsonGet<ActiveResp>("/active_runners");
}

// ─────────────────────────────────────────────────────────────────────────────
// auth & routing — every endpoint must reject anonymous + reject the wrong
// HTTP method.  This is the operational contract that lets us delete
// PROXY_COORDINATOR_URL and trust callers fall back to local-only behaviour
// instead of accidentally hitting an open registry.
// ─────────────────────────────────────────────────────────────────────────────

describe("auth & routing", () => {
  it("/register rejects anonymous requests", async () => {
    const res = await rawFetch("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ holder_id: "h" }),
    });
    expect(res.status).toBe(401);
  });

  it("/heartbeat rejects anonymous requests", async () => {
    const res = await rawFetch("/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ holder_id: "h" }),
    });
    expect(res.status).toBe(401);
  });

  it("/unregister rejects anonymous requests", async () => {
    const res = await rawFetch("/unregister", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ holder_id: "h" }),
    });
    expect(res.status).toBe(401);
  });

  it("/active_runners requires auth (anonymous → 401)", async () => {
    const anon = await rawFetch("/active_runners", { method: "GET" });
    expect(anon.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /register — fresh registration vs. re-registration; defaults applied to
// optional fields; payload responds with the active set so peer drift can be
// surfaced on the very first call.
// ─────────────────────────────────────────────────────────────────────────────

describe("/register", () => {
  it("registers a new runner with all metadata fields persisted", async () => {
    const r = await register({
      holder_id: "runner-A",
      workflow_run_id: "12345",
      workflow_name: "DailyIngestion",
      proxy_pool_hash: "abc123",
      page_range: "1-50",
    });
    expect(r.registered).toBe(true);
    expect(r.active_runners.length).toBe(1);
    const info = r.active_runners[0];
    expect(info.holder_id).toBe("runner-A");
    expect(info.workflow_run_id).toBe("12345");
    expect(info.workflow_name).toBe("DailyIngestion");
    expect(info.proxy_pool_hash).toBe("abc123");
    expect(info.page_range).toBe("1-50");
    expect(info.started_at).toBeLessThanOrEqual(info.last_heartbeat);
  });

  it("rejects payloads without holder_id", async () => {
    const res = await rawFetch("/register", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("treats a re-register as an implicit heartbeat that preserves started_at", async () => {
    const first = await register({
      holder_id: "runner-B",
      workflow_run_id: "1",
      proxy_pool_hash: "h",
    });
    expect(first.registered).toBe(true);
    const startedAt = first.active_runners[0].started_at;

    const second = await register({
      holder_id: "runner-B",
      workflow_run_id: "1",
      proxy_pool_hash: "h",
    });
    expect(second.registered).toBe(false);
    const after = second.active_runners.find((r) => r.holder_id === "runner-B")!;
    // started_at locked from first call; last_heartbeat refreshed.
    expect(after.started_at).toBe(startedAt);
    expect(after.last_heartbeat).toBeGreaterThanOrEqual(startedAt);
  });

  it("defaults missing optional fields safely", async () => {
    const r = await register({ holder_id: "runner-C" });
    expect(r.registered).toBe(true);
    const info = r.active_runners.find((x) => x.holder_id === "runner-C")!;
    expect(info.workflow_run_id).toBe("");
    expect(info.workflow_name).toBe("");
    expect(info.proxy_pool_hash).toBe("");
    expect(info.page_range).toBeNull();
  });

  it("clamps a far-future started_at to server time", async () => {
    // A buggy client passes a started_at 1 day in the future; server must
    // not store it (would skew "uptime" forever).
    const farFuture = Date.now() + 24 * 60 * 60_000;
    const r = await register({
      holder_id: "runner-D",
      started_at: farFuture,
    });
    const info = r.active_runners.find((x) => x.holder_id === "runner-D")!;
    expect(info.started_at).toBeLessThan(farFuture);
    expect(info.started_at).toBeLessThanOrEqual(info.last_heartbeat);
  });

  it("returns active_runners ordered by started_at for deterministic ops UIs", async () => {
    // Register runners in non-monotonic order; the ordering must stay
    // deterministic for callers that hash the response or render to a UI.
    await register({ holder_id: "runner-Z", proxy_pool_hash: "h" });
    await register({ holder_id: "runner-A2", proxy_pool_hash: "h" });
    await register({ holder_id: "runner-M", proxy_pool_hash: "h" });
    const r = await active();
    const startedAts = r.active_runners.map((x) => x.started_at);
    const sorted = [...startedAts].sort((a, b) => a - b);
    expect(startedAts).toEqual(sorted);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pool_hash_summary — the part of the contract that subsumes the original
// P3-B "drift detection" item.  Every register/active call returns the
// distribution of `proxy_pool_hash` across live runners so a newly-joining
// runner can `WARN` when its own hash is in the minority bucket.
// ─────────────────────────────────────────────────────────────────────────────

describe("pool_hash_summary (P3-B drift detection)", () => {
  it("groups runners by proxy_pool_hash and orders the buckets by count desc", async () => {
    await register({ holder_id: "r1", proxy_pool_hash: "majority" });
    await register({ holder_id: "r2", proxy_pool_hash: "majority" });
    await register({ holder_id: "r3", proxy_pool_hash: "majority" });
    await register({ holder_id: "r4", proxy_pool_hash: "drift" });

    const r = await active();
    expect(r.pool_hash_summary.length).toBe(2);
    expect(r.pool_hash_summary[0]).toEqual({ hash: "majority", count: 3 });
    expect(r.pool_hash_summary[1]).toEqual({ hash: "drift", count: 1 });
  });

  it("buckets empty hashes separately so the client can warn distinctly", async () => {
    await register({ holder_id: "r5", proxy_pool_hash: "h" });
    await register({ holder_id: "r6" }); // no hash
    const r = await active();
    const empty = r.pool_hash_summary.find((b) => b.hash === "");
    expect(empty).toBeDefined();
    expect(empty!.count).toBe(1);
  });

  it("first call from a fresh runner already surfaces the live distribution", async () => {
    // A new runner registering joins the conversation and immediately sees
    // who else is around — no extra round-trip required.
    await register({ holder_id: "r7", proxy_pool_hash: "h7" });
    const join = await register({ holder_id: "r8", proxy_pool_hash: "h8" });
    expect(join.registered).toBe(true);
    expect(join.pool_hash_summary.map((b) => b.hash).sort()).toEqual(["h7", "h8"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /heartbeat — refreshes last_heartbeat for known holders; returns alive=false
// (not an HTTP error) when the holder was already evicted, so the client can
// re-register without an extra exception path.
// ─────────────────────────────────────────────────────────────────────────────

describe("/heartbeat", () => {
  it("returns alive=true and refreshes last_heartbeat for a known holder", async () => {
    await register({ holder_id: "hb-1", proxy_pool_hash: "h" });
    const before = (await active()).active_runners.find((x) => x.holder_id === "hb-1")!;
    // Sleep tick so the timestamp can advance; vitest fake timers aren't
    // wired here, so we just await a microtask + short delay.
    await new Promise((r) => setTimeout(r, 5));
    const hb = await heartbeat("hb-1");
    expect(hb.alive).toBe(true);
    const after = (await active()).active_runners.find((x) => x.holder_id === "hb-1")!;
    expect(after.last_heartbeat).toBeGreaterThanOrEqual(before.last_heartbeat);
  });

  it("returns alive=false for an unknown holder without HTTP error", async () => {
    const hb = await heartbeat("never-registered");
    expect(hb.alive).toBe(false);
  });

  it("rejects payloads without holder_id", async () => {
    const res = await rawFetch("/heartbeat", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /unregister — atexit-style cleanup; idempotent for unknown holders so a
// double-call from `atexit` + signal handler never raises.
// ─────────────────────────────────────────────────────────────────────────────

describe("/unregister", () => {
  it("removes a known runner and reports unregistered=true", async () => {
    await register({ holder_id: "u-1" });
    const r = await unregister("u-1");
    expect(r.unregistered).toBe(true);
    const after = await active();
    expect(after.active_runners.find((x) => x.holder_id === "u-1")).toBeUndefined();
  });

  it("returns unregistered=false for an unknown holder (idempotent)", async () => {
    const r = await unregister("never-registered-2");
    expect(r.unregistered).toBe(false);
  });

  it("a re-registered holder after unregister is fresh (started_at advances)", async () => {
    const first = await register({ holder_id: "u-2", proxy_pool_hash: "h" });
    const t1 = first.active_runners[0].started_at;
    await unregister("u-2");
    await new Promise((r) => setTimeout(r, 5));
    const second = await register({ holder_id: "u-2", proxy_pool_hash: "h" });
    expect(second.registered).toBe(true);
    const t2 = second.active_runners.find((x) => x.holder_id === "u-2")!.started_at;
    expect(t2).toBeGreaterThanOrEqual(t1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /active_runners — read-only ops endpoint; safe to poll at high cadence.
// ─────────────────────────────────────────────────────────────────────────────

describe("/active_runners", () => {
  it("returns an empty registry without errors", async () => {
    const r = await active();
    expect(r.active_runners).toEqual([]);
    expect(r.pool_hash_summary).toEqual([]);
  });

  it("does NOT update last_heartbeat (read-only)", async () => {
    await register({ holder_id: "ar-1", proxy_pool_hash: "h" });
    const before = (await active()).active_runners[0].last_heartbeat;
    await new Promise((r) => setTimeout(r, 5));
    const after = (await active()).active_runners[0].last_heartbeat;
    expect(after).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DO Alarm GC — same direct-`alarm()` invocation pattern as the
// MovieClaimState suite (vitest-pool-workers' `runDurableObjectAlarm` trips
// over the synthetic last_heartbeat manipulation we use to age runners out).
// ─────────────────────────────────────────────────────────────────────────────

describe("alarm — GC of stale runners", () => {
  it("alarm() prunes runners with stale last_heartbeat", async () => {
    await register({ holder_id: "gc-stale", proxy_pool_hash: "h" });
    await register({ holder_id: "gc-fresh", proxy_pool_hash: "h" });

    if (!env.RUNNER_REGISTRY_DO) {
      throw new Error("RUNNER_REGISTRY_DO binding missing");
    }
    const id = env.RUNNER_REGISTRY_DO.idFromName("runners");
    const stub = env.RUNNER_REGISTRY_DO.get(id);

    await runInDurableObject(stub, async (instance, doState) => {
      // Age out the stale runner by an hour (well past the 10 min default).
      const data = (await doState.storage.get("state")) as RegistryStorage;
      data.runners["gc-stale"].last_heartbeat = Date.now() - 60 * 60_000;
      await doState.storage.put("state", data);
      // Reset the in-memory cache so alarm() reloads from storage.
      (instance as unknown as { cached: unknown }).cached = null;
      (instance as unknown as { alarmScheduled: boolean }).alarmScheduled = false;

      await (instance as unknown as { alarm: () => Promise<void> }).alarm();

      const after = (await doState.storage.get("state")) as RegistryStorage;
      expect(after.runners["gc-stale"]).toBeUndefined();
      expect(after.runners["gc-fresh"]).toBeDefined();
    });

    const r = await active();
    const ids = r.active_runners.map((x) => x.holder_id);
    expect(ids).toContain("gc-fresh");
    expect(ids).not.toContain("gc-stale");
  });

  it("alarm() re-arms itself when runners remain after GC", async () => {
    await register({ holder_id: "rearm-stale" });
    await register({ holder_id: "rearm-fresh" });

    if (!env.RUNNER_REGISTRY_DO) {
      throw new Error("RUNNER_REGISTRY_DO binding missing");
    }
    const id = env.RUNNER_REGISTRY_DO.idFromName("runners");
    const stub = env.RUNNER_REGISTRY_DO.get(id);

    await runInDurableObject(stub, async (instance, doState) => {
      const data = (await doState.storage.get("state")) as RegistryStorage;
      data.runners["rearm-stale"].last_heartbeat = Date.now() - 60 * 60_000;
      await doState.storage.put("state", data);
      (instance as unknown as { cached: unknown }).cached = null;
      (instance as unknown as { alarmScheduled: boolean }).alarmScheduled = false;
      await doState.storage.deleteAlarm();

      await (instance as unknown as { alarm: () => Promise<void> }).alarm();

      const alarmTime = await doState.storage.getAlarm();
      expect(alarmTime).not.toBeNull();
      expect(alarmTime!).toBeGreaterThan(Date.now());
    });
  });

  it("alarm() does NOT re-arm when no runners remain", async () => {
    await register({ holder_id: "lonely" });

    if (!env.RUNNER_REGISTRY_DO) {
      throw new Error("RUNNER_REGISTRY_DO binding missing");
    }
    const id = env.RUNNER_REGISTRY_DO.idFromName("runners");
    const stub = env.RUNNER_REGISTRY_DO.get(id);

    await runInDurableObject(stub, async (instance, doState) => {
      const data = (await doState.storage.get("state")) as RegistryStorage;
      data.runners["lonely"].last_heartbeat = Date.now() - 60 * 60_000;
      await doState.storage.put("state", data);
      (instance as unknown as { cached: unknown }).cached = null;
      (instance as unknown as { alarmScheduled: boolean }).alarmScheduled = false;
      await doState.storage.deleteAlarm();

      await (instance as unknown as { alarm: () => Promise<void> }).alarm();

      // Empty registry → alarm should stay disarmed (idle DO costs nothing).
      const alarmTime = await doState.storage.getAlarm();
      expect(alarmTime).toBeNull();
    });
  });

  it("scheduleAlarm() is idempotent across rapid registers", async () => {
    if (!env.RUNNER_REGISTRY_DO) {
      throw new Error("RUNNER_REGISTRY_DO binding missing");
    }
    // First register arms the alarm; subsequent registers must not thrash
    // setAlarm (the in-memory `alarmScheduled` flag short-circuits).
    await register({ holder_id: "idem-1" });
    const id = env.RUNNER_REGISTRY_DO.idFromName("runners");
    const stub = env.RUNNER_REGISTRY_DO.get(id);
    let firstAlarmTime: number | null = null;
    await runInDurableObject(stub, async (_instance, doState) => {
      firstAlarmTime = await doState.storage.getAlarm();
    });
    expect(firstAlarmTime).not.toBeNull();

    await register({ holder_id: "idem-2" });
    let secondAlarmTime: number | null = null;
    await runInDurableObject(stub, async (_instance, doState) => {
      secondAlarmTime = await doState.storage.getAlarm();
    });
    // Same alarm slot — never reset by the second register.
    expect(secondAlarmTime).toBe(firstAlarmTime);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Field clipping — defends the singleton DO against a buggy client that
// sends megabytes of workflow metadata.  Server-side clipping at
// RUNNER_FIELD_MAX_LEN (=512) keeps storage bounded.
// ─────────────────────────────────────────────────────────────────────────────

describe("field length clipping", () => {
  it("truncates oversize workflow_name without erroring", async () => {
    const overflow = "x".repeat(2000);
    const r = await register({
      holder_id: "clip-1",
      workflow_name: overflow,
    });
    const info = r.active_runners.find((x) => x.holder_id === "clip-1")!;
    expect(info.workflow_name.length).toBe(512);
    expect(info.workflow_name).toBe("x".repeat(512));
  });

  it("truncates oversize page_range string", async () => {
    const overflow = "y".repeat(2000);
    const r = await register({
      holder_id: "clip-2",
      page_range: overflow,
    });
    const info = r.active_runners.find((x) => x.holder_id === "clip-2")!;
    expect(info.page_range!.length).toBe(512);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// movie_claim_recommended — derived field returned to Python clients in
// `MOVIE_CLAIM_ENABLED=auto` mode.  The contract is "write self → read full
// set → derive `>= MOVIE_CLAIM_MIN_RUNNERS`"; DO single-thread serialization
// guarantees the second of two concurrent registers always observes the
// peer's record.  Tested at both endpoint level (register + heartbeat) so a
// future refactor can't silently regress one path.
// ─────────────────────────────────────────────────────────────────────────────
describe("movie_claim_recommended derived signal", () => {
  it("first runner sees recommended=false (single-runner cohort)", async () => {
    const r = await register({ holder_id: "mc-solo", proxy_pool_hash: "h" });
    expect(r.active_runners.length).toBe(1);
    expect(r.movie_claim_recommended).toBe(false);
    expect(r.movie_claim_min_runners).toBe(2);
  });

  it("second runner sees recommended=true and surfaces threshold", async () => {
    await register({ holder_id: "mc-A", proxy_pool_hash: "h" });
    const second = await register({ holder_id: "mc-B", proxy_pool_hash: "h" });
    expect(second.active_runners.length).toBe(2);
    expect(second.movie_claim_recommended).toBe(true);
    expect(second.movie_claim_min_runners).toBe(2);
  });

  it("first runner's next heartbeat picks up the recommendation flip", async () => {
    // Solo register is not enough for the recommendation; once a peer
    // registers, the original runner observes the change on its next
    // heartbeat tick (matches the Python loop's expected behaviour).
    const solo = await register({ holder_id: "mc-flip-A" });
    expect(solo.movie_claim_recommended).toBe(false);
    await register({ holder_id: "mc-flip-B" });
    const hb = await heartbeat("mc-flip-A");
    expect(hb.alive).toBe(true);
    expect(hb.movie_claim_recommended).toBe(true);
    expect(hb.movie_claim_min_runners).toBe(2);
  });

  it("heartbeat for an evicted holder still surfaces cohort recommendation", async () => {
    // Even when alive=false the response includes the threshold &
    // recommendation: the Python heartbeat loop re-registers right
    // after, but having the signal here keeps logs symmetric.
    await register({ holder_id: "mc-keep" });
    const hb = await heartbeat("mc-evicted-never-registered");
    expect(hb.alive).toBe(false);
    // Cohort has 1 live runner ("mc-keep"); recommendation = false.
    expect(hb.movie_claim_recommended).toBe(false);
    expect(hb.movie_claim_min_runners).toBe(2);
  });

  it("heartbeat after a peer registers returns recommended=true", async () => {
    await register({ holder_id: "mc-hb-A" });
    await register({ holder_id: "mc-hb-B" });
    const hb = await heartbeat("mc-hb-A");
    expect(hb.alive).toBe(true);
    expect(hb.movie_claim_recommended).toBe(true);
  });

  it("recommendation drops back to false after the peer unregisters", async () => {
    await register({ holder_id: "mc-drop-A" });
    await register({ holder_id: "mc-drop-B" });
    await unregister("mc-drop-B");
    const hb = await heartbeat("mc-drop-A");
    expect(hb.alive).toBe(true);
    expect(hb.movie_claim_recommended).toBe(false);
  });

  it("min_runners reflects the env var (bound to default 2 in this suite)", async () => {
    // The default vitest worker env is hardcoded in wrangler.toml /
    // vitest.config.ts; if the test fixture ever overrides
    // MOVIE_CLAIM_MIN_RUNNERS it should be reflected here.  This guards
    // against an accidental env-shadowing regression.
    const r = await register({ holder_id: "mc-thresh" });
    expect(r.movie_claim_min_runners).toBe(2);
  });
});
