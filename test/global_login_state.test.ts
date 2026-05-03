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
}

interface AcquireLeaseResp {
  acquired: boolean;
  holder_id: string;
  target_proxy_name: string;
  lease_expires_at: number;
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
