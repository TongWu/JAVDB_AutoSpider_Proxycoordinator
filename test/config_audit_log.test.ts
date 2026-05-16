/**
 * Phase 2 / ADR-002 — config_audit_log in ConfigState DO.
 *
 * All requests go through the Worker's auth layer (Bearer token required),
 * which then buffers the DO response body before forwarding — this avoids
 * the vitest-pool-workers isolated-storage WAL-file snapshot error that
 * occurs when SQLite-backed DOs are called via direct stub.fetch().
 *
 * The /config/history route is added here as part of Task 6 even though
 * the full Task 11 forwarding is deferred — the Worker route is a
 * single-line addition needed to keep tests off direct stub.fetch().
 */
import { describe, it, expect } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";

const TOKEN = env.PROXY_COORDINATOR_TOKEN;
const AUTH = { authorization: `Bearer ${TOKEN}` };

async function workerFetch(
  path: string,
  method: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const ctx = createExecutionContext();
  const req = new Request(`https://worker.test${path}`, {
    method,
    headers: { ...AUTH, "content-type": "application/json", ...(extraHeaders ?? {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const resp = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return resp;
}

describe("config_audit_log (Phase 2 / ADR-002)", () => {
  it("records old/new values + actor + actor_kind on PATCH", async () => {
    // First PATCH: short_max = "5" with actor headers
    // Keys are normalised to lowercase (mirror wrangler.toml [vars] convention).
    const r1 = await workerFetch(
      "/config",
      "PATCH",
      { key: "short_max", value: "5", reason: "loosen for promo run" },
      { "x-actor": "operator-test", "x-actor-kind": "operator" },
    );
    expect(r1.status).toBe(200);

    // Second PATCH: short_max = "3"
    const r2 = await workerFetch(
      "/config",
      "PATCH",
      { key: "short_max", value: "3", reason: "back to default" },
      { "x-actor": "operator-test", "x-actor-kind": "operator" },
    );
    expect(r2.status).toBe(200);

    // Read via /config/history (added to the Worker as part of Task 6,
    // full Task 11 will extend this endpoint further).
    const q = await workerFetch(
      `/config/history?from=0&to=${Date.now() + 1_000_000}&key=short_max`,
      "GET",
    );
    expect(q.status).toBe(200);
    const { rows } = (await q.json()) as { rows: Array<any> };

    // All rows are filtered to key=short_max by the query param.
    // Rows are in ts DESC order; take the last 2 we just wrote.
    const matching = rows.slice(0, 2);
    expect(matching).toHaveLength(2);
    // matching[0] is the second PATCH ("3"), matching[1] is the first ("5").
    expect(matching[0]).toMatchObject({ new_value: "3", actor_kind: "operator", reason: "back to default" });
    expect(matching[1]).toMatchObject({ new_value: "5", actor_kind: "operator", reason: "loosen for promo run" });
    // The second PATCH's old_value should be "5".
    expect(matching[0].old_value).toBe("5");
  });

  it("defaults actor_kind='system' when header missing", async () => {
    const r = await workerFetch(
      "/config",
      "PATCH",
      { key: "long_max", value: "50" },
    );
    expect(r.status).toBe(200);

    const q = await workerFetch(
      `/config/history?from=0&to=${Date.now() + 1_000_000}&key=long_max`,
      "GET",
    );
    expect(q.status).toBe(200);
    const { rows } = (await q.json()) as { rows: Array<any> };
    const recent = rows[0];
    expect(recent).toBeDefined();
    expect(recent.actor_kind).toBe("system");
  });

  it("returns all keys when no key filter", async () => {
    const q = await workerFetch(
      `/config/history?from=0&to=${Date.now() + 1_000_000}`,
      "GET",
    );
    expect(q.status).toBe(200);
    const { rows } = (await q.json()) as { rows: Array<any> };
    expect(Array.isArray(rows)).toBe(true);
    // Sanity: rows are in ts DESC order
    if (rows.length >= 2) {
      expect(rows[0].ts).toBeGreaterThanOrEqual(rows[1].ts);
    }
  });
});
