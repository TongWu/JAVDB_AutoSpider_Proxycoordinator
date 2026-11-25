import {
  env,
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { loadBlockTtlMs } from "../src/global_login_state";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const TOKEN = "test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — keep the call sites concise so each test reads as a sequence of
// HTTP-style verbs against the Worker.  All helpers assert 2xx by default;
// negative-path tests use the lower-level `rawFetch` to inspect status.
//
// vitest-pool-workers handles per-test storage isolation automatically; we
// rely on that and never reach into the DO's storage from a `beforeEach`,
// which would corrupt the frame stack.  The previous version of this suite
// briefly worked around a related bug (DO response bodies leaking SQLite
// read transactions across the JSRPC boundary) by splitting into many
// single-test files, but the real fix landed in
// `forwardToGlobalLoginStateDo` — see the comment block in src/index.ts.
// ─────────────────────────────────────────────────────────────────────────────

async function rawFetch(path: string, init: RequestInit): Promise<Response> {
  const req = new Request(`https://test.invalid${path}`, init);
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function jsonPost<T>(path: string, body: unknown, expectStatus = 200): Promise<T> {
  const res = await rawFetch(path, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(expectStatus);
  return (await res.json()) as T;
}

async function jsonGet<T>(path: string): Promise<T> {
  const res = await rawFetch(path, { method: "GET", headers: { ...AUTH } });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

interface LoginStateGetResp {
  proxy_name: string | null;
  cookie: string | null;
  version: number;
  last_verified_at: number;
  has_active_lease: boolean;
  server_time: number;
  last_success_proxy?: string | null;
  login_blocked?: Record<string, number>;
}

interface AcquireLeaseResp {
  acquired: boolean;
  holder_id: string;
  target_proxy_name: string;
  lease_expires_at: number;
  cooldown_until_ms?: number;
  recent_attempt_count?: number;
  server_time: number;
}

interface RecordAttemptResp {
  recent_attempt_count: number;
  recent_failure_count: number;
  cooldown_until_ms: number;
  server_time: number;
}

interface PublishResp {
  ok: boolean;
  version: number;
  server_time: number;
}

interface InvalidateResp {
  invalidated: boolean;
  current_version: number;
  server_time: number;
}

interface ReleaseLeaseResp {
  released: boolean;
  server_time: number;
}

const getState = () => jsonGet<LoginStateGetResp>("/login_state");
const acquire = (holder: string, target: string, ttlMs: number) =>
  jsonPost<AcquireLeaseResp>("/login_state/acquire_lease", {
    holder_id: holder, target_proxy_name: target, ttl_ms: ttlMs,
  });
const publish = (holder: string, proxy: string, cookie: string, expectStatus = 200) =>
  jsonPost<PublishResp & { error?: string }>(
    "/login_state/publish",
    { holder_id: holder, proxy_name: proxy, cookie },
    expectStatus,
  );
const invalidate = (version: number) =>
  jsonPost<InvalidateResp>("/login_state/invalidate", { version });
const releaseLease = (holder: string) =>
  jsonPost<ReleaseLeaseResp>("/login_state/release_lease", { holder_id: holder });
const recordAttempt = (
  holder: string,
  proxy: string,
  outcome: "success" | "failure",
  expectStatus = 200,
) =>
  jsonPost<RecordAttemptResp & { error?: string }>(
    "/login_state/record_attempt",
    { holder_id: holder, proxy_name: proxy, outcome },
    expectStatus,
  );

/**
 * P2-C — drop a failure record at a synthetic past timestamp directly
 * into DO storage.  Letting tests "rewind the clock" lets us exercise
 * the cooldown ladder + window pruning without `setTimeout`-style waits.
 *
 * Each call appends a single failure entry whose ``at`` is ``now - ageSec``;
 * the helper preserves any pre-existing snapshot fields (lease, cookie,
 * etc.) so tests can mix this with the normal acquire/publish helpers.
 */
async function seedHistoricalFailure(ageSec: number): Promise<void> {
  const id = env.GLOBAL_LOGIN_STATE_DO.idFromName("global");
  const stub = env.GLOBAL_LOGIN_STATE_DO.get(id);
  await runInDurableObject(stub, async (_inst, state) => {
    const data = (await state.storage.get<any>("state")) ?? {
      proxy_name: null,
      cookie_ciphertext: null,
      version: 0,
      last_verified_at: 0,
      lease: null,
      recent_attempts: [],
    };
    data.recent_attempts = data.recent_attempts ?? [];
    data.recent_attempts.push({
      at: Date.now() - ageSec * 1000,
      proxy_name: "Pseed",
      outcome: "failure",
      holder_id: "seed",
    });
    await state.storage.put("state", data);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// auth — the new routes inherit the existing bearer check + GET on
// /login_state is whitelisted (other routes only accept POST).
// ─────────────────────────────────────────────────────────────────────────────

describe("auth", () => {
  it("rejects /login_state without bearer token", async () => {
    const res = await rawFetch("/login_state", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("rejects /login_state/acquire_lease with wrong bearer token", async () => {
    const res = await rawFetch("/login_state/acquire_lease", {
      method: "POST",
      headers: { authorization: "Bearer wrong", "content-type": "application/json" },
      body: JSON.stringify({ holder_id: "x", target_proxy_name: "P1", ttl_ms: 60_000 }),
    });
    expect(res.status).toBe(401);
  });

  it("/login_state accepts GET (whitelisted) and returns initial empty state", async () => {
    const s = await getState();
    expect(s.proxy_name).toBeNull();
    expect(s.cookie).toBeNull();
    expect(s.version).toBe(0);
    expect(s.last_verified_at).toBe(0);
    expect(s.has_active_lease).toBe(false);
  });

  it("rejects POST without auth on /login_state/publish", async () => {
    const res = await rawFetch("/login_state/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ holder_id: "x", proxy_name: "P1", cookie: "c=1" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns opaque internal_error on a non-JSON body (no raw err.message leak)", async () => {
    // The catch-all in the Worker fetch handler must NOT echo
    // ``err.message`` back to the caller — raw JSON-parse errors can
    // include byte offsets from the malformed input, and DO-side
    // exceptions can carry SQL fragments. The response body must be a
    // stable ``{"error":"internal_error"}`` shape.
    const res = await rawFetch("/login_state/acquire_lease", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: "not-json-at-all",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("internal_error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lease lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe("acquire_lease", () => {
  it("first call on a fresh DO acquires the lease", async () => {
    const r = await acquire("runner-A", "P1", 60_000);
    expect(r.acquired).toBe(true);
    expect(r.holder_id).toBe("runner-A");
    expect(r.target_proxy_name).toBe("P1");
    expect(r.lease_expires_at).toBeGreaterThan(r.server_time);
  });

  it("same holder renews idempotently and pushes expiry forward", async () => {
    const a = await acquire("runner-A", "P1", 30_000);
    await new Promise((res) => setTimeout(res, 25));
    const b = await acquire("runner-A", "P1", 60_000);
    expect(b.acquired).toBe(true);
    expect(b.lease_expires_at).toBeGreaterThan(a.lease_expires_at);
  });

  it("different holder is rejected while lease is alive", async () => {
    await acquire("runner-A", "P1", 60_000);
    const b = await acquire("runner-B", "P1", 60_000);
    expect(b.acquired).toBe(false);
    expect(b.holder_id).toBe("runner-A");
    expect(b.target_proxy_name).toBe("P1");
  });

  it("ttl_ms below floor is clamped to the minimum (5s)", async () => {
    const r = await acquire("runner-A", "P1", 100);
    const remaining = r.lease_expires_at - r.server_time;
    expect(remaining).toBeGreaterThanOrEqual(4_500);
    expect(remaining).toBeLessThanOrEqual(5_500);
  });

  it("ttl_ms above ceiling is clamped to 5min cap", async () => {
    const r = await acquire("runner-A", "P1", 9_999_999);
    const remaining = r.lease_expires_at - r.server_time;
    expect(remaining).toBeLessThanOrEqual(300_000);
    expect(remaining).toBeGreaterThanOrEqual(299_000);
  });

  it("expired lease is reclaimed by a new holder", async () => {
    // Acquire normally, then fast-forward `expires_at` directly in storage
    // instead of sleeping 5s in a unit test.
    await acquire("runner-A", "P1", 5_000);
    const id = env.GLOBAL_LOGIN_STATE_DO.idFromName("global");
    const stub = env.GLOBAL_LOGIN_STATE_DO.get(id);
    await runInDurableObject(stub, async (_inst, state) => {
      const data = (await state.storage.get<any>("state"))!;
      data.lease.expires_at = Date.now() - 1;
      await state.storage.put("state", data);
    });
    const b = await acquire("runner-B", "P1", 60_000);
    expect(b.acquired).toBe(true);
    expect(b.holder_id).toBe("runner-B");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// publish — must hold a live lease; bumps version atomically
// ─────────────────────────────────────────────────────────────────────────────

describe("publish", () => {
  it("rejects with 409 when no lease is held", async () => {
    const res = await rawFetch("/login_state/publish", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ holder_id: "runner-A", proxy_name: "P1", cookie: "c=1" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("lease_required");
  });

  it("rejects when caller's holder_id does not match current lease", async () => {
    await acquire("runner-A", "P1", 60_000);
    const res = await rawFetch("/login_state/publish", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ holder_id: "runner-B", proxy_name: "P1", cookie: "c=1" }),
    });
    expect(res.status).toBe(409);
  });

  it("rejects when publish proxy_name disagrees with the lease target", async () => {
    // Lease acquired for P1, but the publisher claims a cookie for P2.
    // The DO must refuse without mutating state — otherwise the singleton
    // `proxy_name` field would point at a proxy whose cookie was never
    // validated under this lease.
    await acquire("runner-A", "P1", 60_000);
    const res = await rawFetch("/login_state/publish", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        holder_id: "runner-A", proxy_name: "P2", cookie: "c=1",
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string; lease_target_proxy_name?: string;
    };
    expect(body.error).toBe("proxy_name_mismatch_with_lease");
    expect(body.lease_target_proxy_name).toBe("P1");
    // State must remain unmodified: no cookie was ever published, so
    // version stays 0 and proxy_name stays null.
    const snapshot = await getState();
    expect(snapshot.version).toBe(0);
    expect(snapshot.proxy_name).toBeNull();
    expect(snapshot.cookie).toBeNull();
  });

  it("succeeds for lease holder and bumps version monotonically", async () => {
    await acquire("runner-A", "P1", 60_000);
    const r1 = await publish("runner-A", "P1", "_jdb_session=alpha");
    expect(r1.ok).toBe(true);
    expect(r1.version).toBe(1);

    await acquire("runner-A", "P1", 60_000); // same-holder renew
    const r2 = await publish("runner-A", "P1", "_jdb_session=beta");
    expect(r2.version).toBe(2);
  });

  it("publish keeps the lease intact (caller must release explicitly)", async () => {
    await acquire("runner-A", "P1", 60_000);
    await publish("runner-A", "P1", "_jdb_session=alpha");
    const s = await getState();
    expect(s.has_active_lease).toBe(true);
  });

  it("rejects oversized cookie payloads with 413", async () => {
    await acquire("runner-A", "P1", 60_000);
    const big = "x".repeat(17 * 1024);
    const res = await rawFetch("/login_state/publish", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ holder_id: "runner-A", proxy_name: "P1", cookie: big }),
    });
    expect(res.status).toBe(413);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// get — round-trips decrypted plaintext, never leaks holder identity
// ─────────────────────────────────────────────────────────────────────────────

describe("get", () => {
  it("returns null cookie before any publish", async () => {
    const s = await getState();
    expect(s.cookie).toBeNull();
    expect(s.proxy_name).toBeNull();
  });

  it("returns the same plaintext that was published", async () => {
    await acquire("runner-A", "P1", 60_000);
    await publish("runner-A", "P1", "_jdb_session=alpha");
    const s = await getState();
    expect(s.cookie).toBe("_jdb_session=alpha");
    expect(s.proxy_name).toBe("P1");
    expect(s.version).toBe(1);
    expect(s.last_verified_at).toBeGreaterThan(0);
  });

  it("does not leak the lease holder identity (only has_active_lease boolean)", async () => {
    await acquire("runner-A", "P1", 60_000);
    const s = await getState();
    expect(s.has_active_lease).toBe(true);
    expect(Object.keys(s)).not.toContain("holder_id");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// invalidate — optimistic version lock guards against stale wipes
// ─────────────────────────────────────────────────────────────────────────────

describe("invalidate", () => {
  it("with matching version: clears cookie and bumps version", async () => {
    await acquire("runner-A", "P1", 60_000);
    const pub = await publish("runner-A", "P1", "_jdb_session=alpha");

    const r = await invalidate(pub.version);
    expect(r.invalidated).toBe(true);
    expect(r.current_version).toBe(pub.version + 1);

    const s = await getState();
    expect(s.cookie).toBeNull();
    expect(s.proxy_name).toBeNull();
  });

  it("with stale version: no-ops and surfaces the current version", async () => {
    await acquire("runner-A", "P1", 60_000);
    await publish("runner-A", "P1", "_jdb_session=alpha"); // version 1
    await acquire("runner-A", "P1", 60_000);
    const pub2 = await publish("runner-A", "P1", "_jdb_session=beta"); // version 2

    const r = await invalidate(0); // stale
    expect(r.invalidated).toBe(false);
    expect(r.current_version).toBe(pub2.version);

    const s = await getState();
    expect(s.cookie).toBe("_jdb_session=beta"); // untouched
  });

  it("does not release the lease (orthogonal concerns)", async () => {
    await acquire("runner-A", "P1", 60_000);
    const pub = await publish("runner-A", "P1", "_jdb_session=alpha");
    await invalidate(pub.version);
    const s = await getState();
    expect(s.has_active_lease).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// release_lease — only the owner may release
// ─────────────────────────────────────────────────────────────────────────────

describe("release_lease", () => {
  it("non-owner release returns released:false and leaves lease alone", async () => {
    await acquire("runner-A", "P1", 60_000);
    const r = await releaseLease("runner-B");
    expect(r.released).toBe(false);
    const s = await getState();
    expect(s.has_active_lease).toBe(true);
  });

  it("owner release clears the lease", async () => {
    await acquire("runner-A", "P1", 60_000);
    const r = await releaseLease("runner-A");
    expect(r.released).toBe(true);
    const s = await getState();
    expect(s.has_active_lease).toBe(false);
  });

  it("after release, a different holder can immediately acquire", async () => {
    await acquire("runner-A", "P1", 60_000);
    await releaseLease("runner-A");
    const b = await acquire("runner-B", "P2", 60_000);
    expect(b.acquired).toBe(true);
    expect(b.holder_id).toBe("runner-B");
    expect(b.target_proxy_name).toBe("P2");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AES-GCM encryption — IV randomness, plaintext fidelity, raw storage check
// ─────────────────────────────────────────────────────────────────────────────

describe("cookie encryption", () => {
  /**
   * Read the raw `cookie_ciphertext` directly out of DO storage to verify
   * encryption properties the public API intentionally hides.
   */
  async function readRawCiphertext(): Promise<string | null> {
    const id = env.GLOBAL_LOGIN_STATE_DO.idFromName("global");
    const stub = env.GLOBAL_LOGIN_STATE_DO.get(id);
    let captured: string | null = null;
    await runInDurableObject(stub, async (_inst, state) => {
      const data = await state.storage.get<{ cookie_ciphertext: string | null }>("state");
      captured = data?.cookie_ciphertext ?? null;
    });
    return captured;
  }

  it("publishing the same plaintext twice produces different ciphertexts (random IV)", async () => {
    await acquire("runner-A", "P1", 60_000);
    await publish("runner-A", "P1", "_jdb_session=alpha");
    const ct1 = await readRawCiphertext();
    expect(ct1).toBeTruthy();

    await acquire("runner-A", "P1", 60_000);
    await publish("runner-A", "P1", "_jdb_session=alpha");
    const ct2 = await readRawCiphertext();
    expect(ct2).toBeTruthy();

    expect(ct2).not.toBe(ct1);
  });

  it("non-ASCII / cookie-attribute-special characters round-trip intact", async () => {
    const tricky = "_jdb_session=测试; Path=/; HttpOnly; SameSite=Lax";
    await acquire("runner-A", "P1", 60_000);
    await publish("runner-A", "P1", tricky);
    const s = await getState();
    expect(s.cookie).toBe(tricky);
  });

  it("undecryptable ciphertext is surfaced as cookie:null (token rotation safety)", async () => {
    const id = env.GLOBAL_LOGIN_STATE_DO.idFromName("global");
    const stub = env.GLOBAL_LOGIN_STATE_DO.get(id);
    await runInDurableObject(stub, async (_inst, state) => {
      await state.storage.put("state", {
        proxy_name: "P1",
        cookie_ciphertext: "AAAAAAAAAAAAAAAA__not_real__ciphertext",
        version: 5,
        last_verified_at: Date.now(),
        lease: null,
      });
    });
    const s = await getState();
    expect(s.cookie).toBeNull();
    expect(s.proxy_name).toBe("P1");
    expect(s.version).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cross-DO isolation — ProxyCoordinator and GlobalLoginState share a Worker
// but must not interfere with each other's state.
// ─────────────────────────────────────────────────────────────────────────────

describe("cross-DO isolation", () => {
  it("/lease still works while a login state is published", async () => {
    await acquire("runner-A", "P1", 60_000);
    await publish("runner-A", "P1", "_jdb_session=alpha");

    const proxyId = `iso-${crypto.randomUUID()}`;
    const res = await rawFetch("/lease", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ proxy_id: proxyId, intended_sleep_ms: 100 }),
    });
    expect(res.status).toBe(200);
    const lease = (await res.json()) as { wait_ms: number };
    expect(lease.wait_ms).toBeGreaterThanOrEqual(100);

    const s = await getState();
    expect(s.cookie).toBe("_jdb_session=alpha");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// payload validation
// ─────────────────────────────────────────────────────────────────────────────

describe("payload validation", () => {
  it("acquire_lease without holder_id returns 400", async () => {
    const res = await rawFetch("/login_state/acquire_lease", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ target_proxy_name: "P1", ttl_ms: 60_000 }),
    });
    expect(res.status).toBe(400);
  });

  it("publish without cookie returns 400", async () => {
    await acquire("runner-A", "P1", 60_000);
    const res = await rawFetch("/login_state/publish", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ holder_id: "runner-A", proxy_name: "P1" }),
    });
    expect(res.status).toBe(400);
  });

  it("release_lease without holder_id returns 400", async () => {
    const res = await rawFetch("/login_state/release_lease", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P2-C: cross-runner login attempt cooldown
// ─────────────────────────────────────────────────────────────────────────────

describe("P2-C record_attempt", () => {
  it("auth: rejects without bearer token", async () => {
    const res = await rawFetch("/login_state/record_attempt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        holder_id: "runner-A", proxy_name: "P1", outcome: "failure",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("validates holder_id", async () => {
    const res = await rawFetch("/login_state/record_attempt", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ proxy_name: "P1", outcome: "failure" }),
    });
    expect(res.status).toBe(400);
  });

  it("validates proxy_name", async () => {
    const res = await rawFetch("/login_state/record_attempt", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ holder_id: "runner-A", outcome: "failure" }),
    });
    expect(res.status).toBe(400);
  });

  it("validates outcome must be success|failure", async () => {
    const res = await rawFetch("/login_state/record_attempt", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        holder_id: "runner-A", proxy_name: "P1", outcome: "neutral",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("first record on a fresh DO returns count=1, no cooldown", async () => {
    const r = await recordAttempt("runner-A", "P1", "failure");
    expect(r.recent_attempt_count).toBe(1);
    expect(r.recent_failure_count).toBe(1);
    expect(r.cooldown_until_ms).toBe(0);
  });

  it("success records also count toward attempt_count but not failure_count", async () => {
    await recordAttempt("runner-A", "P1", "failure");
    const r = await recordAttempt("runner-A", "P1", "success");
    expect(r.recent_attempt_count).toBe(2);
    expect(r.recent_failure_count).toBe(1);
    expect(r.cooldown_until_ms).toBe(0);
  });

  it("crossing the failure threshold emits a cooldown_until_ms anchored on last failure", async () => {
    // Threshold is 5 in the test env; record 5 failures.
    for (let i = 0; i < 4; i++) {
      const r = await recordAttempt("runner-A", "P1", "failure");
      expect(r.cooldown_until_ms).toBe(0);
    }
    const fifth = await recordAttempt("runner-A", "P1", "failure");
    expect(fifth.recent_failure_count).toBe(5);
    // Cooldown should be ~ now + 30 min (the default duration).
    const expectedMin = fifth.server_time + 29 * 60_000;
    expect(fifth.cooldown_until_ms).toBeGreaterThan(expectedMin);
  });

  it("attempts older than the window are pruned and don't count", async () => {
    // Seed 5 failures from 2h ago — outside the default 1h window.
    for (let i = 0; i < 5; i++) {
      await seedHistoricalFailure(7200);
    }
    // A single fresh failure should NOT trip the cooldown because the
    // pruned buffer only holds the new entry.
    const r = await recordAttempt("runner-A", "P1", "failure");
    expect(r.recent_attempt_count).toBe(1);
    expect(r.recent_failure_count).toBe(1);
    expect(r.cooldown_until_ms).toBe(0);
  });
});

describe("P2-C acquire_lease cooldown", () => {
  it("default response includes cooldown_until_ms=0 + recent_attempt_count=0", async () => {
    const r = await acquire("runner-A", "P1", 60_000);
    expect(r.acquired).toBe(true);
    expect(r.cooldown_until_ms).toBe(0);
    expect(r.recent_attempt_count).toBe(0);
  });

  it("acquire still grants the lease while cooldown is active", async () => {
    // Cross the threshold via record_attempt.
    for (let i = 0; i < 5; i++) {
      await recordAttempt("runner-A", "P1", "failure");
    }
    // Now attempt to acquire — must still succeed (P2-C contract).
    const r = await acquire("runner-B", "P1", 60_000);
    expect(r.acquired).toBe(true);
    expect(r.holder_id).toBe("runner-B");
    expect(r.cooldown_until_ms).toBeGreaterThan(r.server_time);
    expect(r.recent_attempt_count).toBe(5);
  });

  it("cooldown decays as failures age out of the window", async () => {
    // Seed 4 ancient failures (outside the window) + one fresh failure.
    for (let i = 0; i < 4; i++) {
      await seedHistoricalFailure(7200);
    }
    await recordAttempt("runner-A", "P1", "failure");
    // Only 1 in-window failure → below threshold.
    const r = await acquire("runner-A", "P1", 60_000);
    expect(r.cooldown_until_ms).toBe(0);
    expect(r.recent_attempt_count).toBe(1);
  });

  it("a successful login does NOT cancel an active cooldown", async () => {
    for (let i = 0; i < 5; i++) {
      await recordAttempt("runner-A", "P1", "failure");
    }
    const r1 = await acquire("runner-B", "P1", 60_000);
    expect(r1.cooldown_until_ms).toBeGreaterThan(r1.server_time);

    // Now a success — should NOT zero out the cooldown because the
    // failure count inside the window is still 5.
    await recordAttempt("runner-B", "P1", "success");
    const r2 = await acquire("runner-B", "P1", 60_000);
    expect(r2.cooldown_until_ms).toBeGreaterThan(r2.server_time);
  });

  it("legacy acquire response without record_attempt history is unchanged shape", async () => {
    // Pre-P2-C snapshots have no recent_attempts; loadState backfills.
    const id = env.GLOBAL_LOGIN_STATE_DO.idFromName("global");
    const stub = env.GLOBAL_LOGIN_STATE_DO.get(id);
    await runInDurableObject(stub, async (_inst, state) => {
      await state.storage.put("state", {
        proxy_name: null,
        cookie_ciphertext: null,
        version: 0,
        last_verified_at: 0,
        lease: null,
        // intentionally no recent_attempts field
      });
    });
    const r = await acquire("runner-A", "P1", 60_000);
    expect(r.acquired).toBe(true);
    expect(r.cooldown_until_ms).toBe(0);
    expect(r.recent_attempt_count).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADR-063 — last_success_proxy + login_blocked
// ─────────────────────────────────────────────────────────────────────────────

/** Merge `patch` into the stored snapshot (creating a blank one if needed). */
async function seedState(patch: Record<string, unknown>): Promise<void> {
  const id = env.GLOBAL_LOGIN_STATE_DO.idFromName("global");
  const stub = env.GLOBAL_LOGIN_STATE_DO.get(id);
  await runInDurableObject(stub, async (_inst, state) => {
    const data = (await state.storage.get<any>("state")) ?? {
      proxy_name: null,
      cookie_ciphertext: null,
      version: 0,
      last_verified_at: 0,
      lease: null,
      recent_attempts: [],
    };
    await state.storage.put("state", { ...data, ...patch });
  });
}

describe("ADR-063 login block state", () => {
  it("get returns null last_success_proxy and an empty login_blocked on a fresh DO", async () => {
    const s = await getState();
    expect(s.last_success_proxy).toBeNull();
    expect(s.login_blocked).toEqual({});
  });

  it("publish sets last_success_proxy", async () => {
    await acquire("runner-A", "P1", 60_000);
    await publish("runner-A", "P1", "_jdb_session=alpha");
    expect((await getState()).last_success_proxy).toBe("P1");
  });

  it("invalidate keeps last_success_proxy", async () => {
    await acquire("runner-A", "P1", 60_000);
    const pub = await publish("runner-A", "P1", "_jdb_session=alpha");
    await invalidate(pub.version);
    const s = await getState();
    expect(s.proxy_name).toBeNull();
    expect(s.last_success_proxy).toBe("P1");
  });

  it("an old snapshot without the new fields defaults last_success_proxy to proxy_name", async () => {
    await seedState({ proxy_name: "Pold" });
    const s = await getState();
    expect(s.last_success_proxy).toBe("Pold");
    expect(s.login_blocked).toEqual({});
  });

  it("publish clears the block entry of the publishing proxy only", async () => {
    const until = Date.now() + 60_000;
    await seedState({ login_blocked: { P1: until, P2: until } });
    await acquire("runner-A", "P1", 60_000);
    await publish("runner-A", "P1", "_jdb_session=alpha");
    expect((await getState()).login_blocked).toEqual({ P2: until });
  });

  it("get omits expired block entries", async () => {
    const until = Date.now() + 60_000;
    await seedState({ login_blocked: { P1: Date.now() - 1, P2: until } });
    expect((await getState()).login_blocked).toEqual({ P2: until });
  });
});

describe("ADR-063 record_attempt reason", () => {
  const post = (body: Record<string, unknown>) =>
    jsonPost<RecordAttemptResp>("/login_state/record_attempt", {
      holder_id: "runner-A", proxy_name: "P1", ...body,
    });

  it("cf_challenge failure blocks the proxy for the TTL", async () => {
    const r = await post({ outcome: "failure", reason: "cf_challenge" });
    const s = await getState();
    expect(Math.abs(s.login_blocked!.P1 - (r.server_time + 86_400_000))).toBeLessThan(2_000);
  });

  it("reason on a success is ignored", async () => {
    await post({ outcome: "success", reason: "cf_challenge" });
    expect((await getState()).login_blocked).toEqual({});
  });

  it("an unknown reason is ignored and the call still succeeds", async () => {
    await post({ outcome: "failure", reason: "other" });
    expect((await getState()).login_blocked).toEqual({});
  });

  it("no reason behaves as before", async () => {
    const r = await post({ outcome: "failure" });
    expect(r.recent_failure_count).toBe(1);
    expect((await getState()).login_blocked).toEqual({});
  });

  it("a cf_challenge failure still counts toward the P2-C buffer", async () => {
    const r = await post({ outcome: "failure", reason: "cf_challenge" });
    expect(r.recent_failure_count).toBe(1);
  });

  it("detail is stored verbatim", async () => {
    await post({ outcome: "failure", reason: "cf_challenge", detail: "challenge after clearance" });
    const hist = await jsonGet<{ rows: Array<{ event_kind: string; detail: string | null }> }>(
      "/login/history",
    );
    const attempt = hist.rows.find((r) => r.event_kind === "attempt");
    expect(attempt?.detail).toBe("challenge after clearance");
  });
});

describe("ADR-063 report_all_blocked", () => {
  interface Resp { all_blocked: boolean; first: boolean; blocked_until_ms: number; server_time: number }
  const report = (proxies: unknown, holder: unknown = "runner-A", status = 200) =>
    jsonPost<Resp>("/login_state/report_all_blocked", { holder_id: holder, proxies }, status);
  const alertsNow = () =>
    jsonGet<{ alerts: Array<{ id: string; kind: string }> }>("/alerts").then((r) =>
      r.alerts.filter((a) => a.kind === "login_all_blocked"));

  it("all listed proxies blocked: first once, then false", async () => {
    const t1 = Date.now() + 120_000;
    await seedState({ login_blocked: { P1: t1, P2: t1 + 5_000 } });
    const a = await report(["P1", "P2"]);
    expect(a).toMatchObject({ all_blocked: true, first: true, blocked_until_ms: t1 });
    const b = await report(["P1", "P2"]);
    expect(b).toMatchObject({ all_blocked: true, first: false });
  });

  it("a new episode alerts again once the previous alert's blocks have expired", async () => {
    const t1 = Date.now() + 120_000;
    await seedState({ login_blocked: { P1: t1 } });
    expect((await report(["P1"])).first).toBe(true);
    await seedState({
      last_all_blocked_alert_until: Date.now() - 1,
      login_blocked: { P1: t1 + 60_000 },
    });
    expect((await report(["P1"])).first).toBe(true);
  });

  it("a rolling re-block inside the alerted window does not alert again", async () => {
    const now = Date.now();
    await seedState({ login_blocked: { P1: now + 60_000, P2: now + 120_000, P3: now + 180_000 } });
    expect((await report(["P1", "P2", "P3"])).first).toBe(true);
    // P1 is re-tested, challenged again and re-blocked: the earliest value changes.
    await seedState({ login_blocked: { P1: now + 400_000, P2: now + 120_000, P3: now + 180_000 } });
    expect((await report(["P1", "P2", "P3"])).first).toBe(false);
  });

  it("different proxy lists inside the window do not flip-flop the alert", async () => {
    const t1 = Date.now() + 120_000;
    await seedState({ login_blocked: { P1: t1, P2: t1 + 1_000 } });
    expect((await report(["P1", "P2"])).first).toBe(true);
    expect((await report(["P2"])).first).toBe(false);
    expect((await report(["P1", "P2"])).first).toBe(false);
  });

  it("one proxy unblocked: not all blocked, nothing recorded", async () => {
    await seedState({ login_blocked: { P1: Date.now() + 120_000 } });
    const r = await report(["P1", "P2"]);
    expect(r).toMatchObject({ all_blocked: false, first: false, blocked_until_ms: 0 });
    expect(await alertsNow()).toHaveLength(0);
  });

  it("expired entries do not count as blocked", async () => {
    await seedState({ login_blocked: { P1: Date.now() - 1, P2: Date.now() + 120_000 } });
    expect((await report(["P1", "P2"])).all_blocked).toBe(false);
  });

  it("the alert id is deterministic and recorded once", async () => {
    const t1 = Date.now() + 120_000;
    await seedState({ login_blocked: { P1: t1 } });
    await report(["P1"]);
    await report(["P1"]);
    const rows = await alertsNow();
    expect(rows.map((r) => r.id)).toEqual([`loginblk-${t1}`]);
  });

  it("400 on bad bodies, and never an alert", async () => {
    await seedState({ login_blocked: { P1: Date.now() + 120_000 } });
    await report([], "runner-A", 400);
    await report("P1", "runner-A", 400);
    await report(["P1", ""], "runner-A", 400);
    await report(["P1", "   "], "runner-A", 400);
    await report(["P1", 123], "runner-A", 400);
    await report(Array.from({ length: 65 }, (_, i) => `P${i}`), "runner-A", 400);
    await report(["P1"], "", 400);
    expect(await alertsNow()).toHaveLength(0);
  });

  it("is authenticated", async () => {
    const res = await rawFetch("/login_state/report_all_blocked", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ holder_id: "x", proxies: ["P1"] }),
    });
    expect(res.status).toBe(401);
  });
});

describe("ADR-063 review follow-ups", () => {
  it("invalidate keeps login_blocked", async () => {
    const until = Date.now() + 120_000;
    await acquire("runner-A", "P1", 60_000);
    const pub = await publish("runner-A", "P1", "_jdb_session=alpha");
    await seedState({ login_blocked: { P2: until } });
    await invalidate(pub.version);
    expect((await getState()).login_blocked).toEqual({ P2: until });
  });

  it("a malformed stored login_blocked is reset to empty", async () => {
    await seedState({ login_blocked: ["P1"] });
    expect((await getState()).login_blocked).toEqual({});
  });

  it("the success:false alias shape also applies the cf_challenge reason", async () => {
    await jsonPost("/login_state/record_attempt", {
      holder_id: "runner-A", proxy_id: "P1", success: false, reason: "cf_challenge",
    });
    expect(Object.keys((await getState()).login_blocked!)).toEqual(["P1"]);
  });

  it("login_blocked is capped at 256 entries, dropping the soonest-expiring", async () => {
    const base = Date.now() + 1_000_000;
    const seeded: Record<string, number> = {};
    for (let i = 0; i < 256; i++) seeded[`S${i}`] = base + i;
    await seedState({ login_blocked: seeded });
    await jsonPost("/login_state/record_attempt", {
      holder_id: "runner-A", proxy_name: "NEW", outcome: "failure", reason: "cf_challenge",
    });
    const blocked = (await getState()).login_blocked!;
    expect(Object.keys(blocked)).toHaveLength(256);
    expect(blocked.NEW).toBeDefined();
    expect(blocked.S0).toBeUndefined();
  });

  it("a proxy name longer than 256 characters is never stored as a block, and last_success_proxy keeps it whole", async () => {
    const longName = "L".repeat(300);
    await jsonPost("/login_state/record_attempt", {
      holder_id: "runner-A", proxy_name: longName, outcome: "failure", reason: "cf_challenge",
    });
    expect((await getState()).login_blocked).toEqual({});
    await acquire("runner-A", longName, 60_000);
    await publish("runner-A", longName, "_jdb_session=alpha");
    expect((await getState()).last_success_proxy).toBe(longName);
  });

  it("two names sharing a 256-character prefix never collide", async () => {
    const a = "P".repeat(256) + "a";
    const b = "P".repeat(256) + "b";
    await jsonPost("/login_state/record_attempt", {
      holder_id: "runner-A", proxy_name: a, outcome: "failure", reason: "cf_challenge",
    });
    const r = await jsonPost<{ all_blocked: boolean }>(
      "/login_state/report_all_blocked", { holder_id: "runner-A", proxies: [b] }, 400,
    );
    expect((r as any).error).toBeDefined();
  });

  it.each(["constructor", "toString", "hasOwnProperty", "valueOf"])(
    "inherited property name %s is an ordinary proxy name",
    async (name) => {
      const none = await jsonPost<{ all_blocked: boolean; first: boolean }>(
        "/login_state/report_all_blocked", { holder_id: "runner-A", proxies: [name] },
      );
      expect(none).toMatchObject({ all_blocked: false, first: false });
      await jsonPost("/login_state/record_attempt", {
        holder_id: "runner-A", proxy_name: name, outcome: "failure", reason: "cf_challenge",
      });
      expect(Object.keys((await getState()).login_blocked!)).toEqual([name]);
      const yes = await jsonPost<{ all_blocked: boolean; first: boolean }>(
        "/login_state/report_all_blocked", { holder_id: "runner-A", proxies: [name] },
      );
      expect(yes).toMatchObject({ all_blocked: true, first: true });
    },
  );

  it("__proto__ is rejected by report_all_blocked and never stored as a block", async () => {
    await jsonPost("/login_state/record_attempt", {
      holder_id: "runner-A", proxy_name: "__proto__", outcome: "failure", reason: "cf_challenge",
    });
    expect((await getState()).login_blocked).toEqual({});
    await jsonPost("/login_state/report_all_blocked", { holder_id: "runner-A", proxies: ["__proto__"] }, 400);
  });

  it.each([
    [undefined, 86_400_000],
    ["", 86_400_000],
    ["abc", 86_400_000],
    ["0", 86_400_000],
    ["-5", 86_400_000],
    ["3600", 3_600_000],
    ["99999999999", 30 * 86_400_000],
  ])("loadBlockTtlMs(%j) is %d ms", (raw, expected) => {
    expect(loadBlockTtlMs({ LOGIN_PROXY_BLOCK_TTL_SEC: raw } as Env)).toBe(expected);
  });
});
