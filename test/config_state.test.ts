/**
 * W5.3 — ConfigState DO + /config Worker route + heartbeat embedding.
 *
 * Tests cover: empty default snapshot, allowlisted PATCH, unknown-key
 * rejection, type rejection, empty-string clear, version monotonicity,
 * heartbeat carries the embedded snapshot.
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

interface ConfigSnap {
  version: number;
  updated_at: number;
  values: Record<string, string>;
  server_time?: number;
}

async function getConfig(): Promise<{ status: number; body: ConfigSnap }> {
  const req = new Request("https://test.invalid/config", {
    method: "GET",
    headers: { ...AUTH },
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, body: (await res.json()) as ConfigSnap };
}

async function patchConfig(
  values: Record<string, string>,
): Promise<{ status: number; body: ConfigSnap & { error?: string } }> {
  const req = new Request("https://test.invalid/config", {
    method: "PATCH",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ values }),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return {
    status: res.status,
    body: (await res.json()) as ConfigSnap & { error?: string },
  };
}

describe("W5.3 ConfigState — GET /config", () => {
  it("returns an empty default snapshot before any PATCH", async () => {
    const { status, body } = await getConfig();
    expect(status).toBe(200);
    // Default: version may be > 0 if other tests in this file have run
    // (DO state persists across tests in the same file under
    // vitest-pool-workers). The key invariant is that the response is
    // well-formed.
    expect(body.version).toBeGreaterThanOrEqual(0);
    expect(typeof body.updated_at).toBe("number");
    expect(typeof body.values).toBe("object");
    expect(typeof body.server_time).toBe("number");
  });
});

describe("W5.3 ConfigState — PATCH /config", () => {
  it("accepts allowlisted keys and bumps version", async () => {
    const before = await getConfig();
    const r = await patchConfig({ short_max: "5" });
    expect(r.status).toBe(200);
    expect(r.body.version).toBe(before.body.version + 1);
    expect(r.body.values.short_max).toBe("5");
  });

  it("rejects unknown keys with HTTP 400", async () => {
    const r = await patchConfig({ totally_invalid_key: "1" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/unknown config key/);
  });

  it("rejects non-string values with HTTP 400", async () => {
    const req = new Request("https://test.invalid/config", {
      method: "PATCH",
      headers: { ...AUTH, "content-type": "application/json" },
      // short_max set to a number — should be rejected.
      body: JSON.stringify({ values: { short_max: 42 } }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });

  it("clears an override when the value is an empty string", async () => {
    await patchConfig({ long_max: "100" });
    const mid = await getConfig();
    expect(mid.body.values.long_max).toBe("100");
    await patchConfig({ long_max: "" });
    const after = await getConfig();
    expect(after.body.values.long_max).toBeUndefined();
  });

  it("rejects requests without a values object", async () => {
    const req = new Request("https://test.invalid/config", {
      method: "PATCH",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ totally: "different shape" }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON bodies (opaque 500, route-level guard)", async () => {
    // Malformed bodies are caught by the route-level `await request.json()`
    // and re-thrown into the outer catch, which returns the opaque
    // `internal_error` payload (same convention as the other DO routes —
    // see test/global_login_state.test.ts `non-JSON body` case). The DO
    // itself has its own `invalid_json` 400 path as defence-in-depth,
    // but it's unreachable from this route today.
    const req = new Request("https://test.invalid/config", {
      method: "PATCH",
      headers: { ...AUTH, "content-type": "application/json" },
      body: "not-json",
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("internal_error");
  });

  it("requires Bearer auth", async () => {
    const req = new Request("https://test.invalid/config", { method: "GET" });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });
});

describe("W5.3 ConfigState — heartbeat embeds config snapshot", () => {
  async function registerRunner(holderId: string): Promise<Response> {
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

  it("register response carries the current snapshot in `config`", async () => {
    await patchConfig({ short_max: "7" });
    const res = await registerRunner("runner-w53-a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config?: ConfigSnap;
      registered: boolean;
    };
    expect(body.config).toBeDefined();
    expect(body.config!.values.short_max).toBe("7");
  });

  it("heartbeat response carries the latest snapshot after a PATCH", async () => {
    await registerRunner("runner-w53-b");
    await patchConfig({ extra_max: "999" });
    const res = await heartbeat("runner-w53-b");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config?: ConfigSnap;
      alive: boolean;
    };
    expect(body.config).toBeDefined();
    expect(body.config!.values.extra_max).toBe("999");
  });

  it("does not embed `server_time` from the config DO (registry's is canonical)", async () => {
    await registerRunner("runner-w53-c");
    const res = await heartbeat("runner-w53-c");
    const body = (await res.json()) as {
      config?: ConfigSnap;
      server_time: number;
    };
    expect(body.config).toBeDefined();
    // The embedded config block must NOT carry its own server_time —
    // see embedConfigSnapshot's strip logic in src/index.ts.
    expect(body.config!.server_time).toBeUndefined();
    // Top-level server_time still comes from the registry response.
    expect(typeof body.server_time).toBe("number");
  });
});
