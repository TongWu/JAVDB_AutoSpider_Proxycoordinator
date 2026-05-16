/**
 * Phase 2 / ADR-004 — proxies_seen table in RunnerRegistry DO.
 *
 * Verifies that:
 * - register with proxy_pool persists entries to proxies_seen
 * - repeat register refreshes last_seen_ms (upsert semantics)
 * - missing proxy_pool field on register is a backward-compat no-op
 * - DELETE /proxies_seen?id=X removes the specific entry
 */

import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const TOKEN = "test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

async function workerFetch(
  path: string,
  method: string,
  body?: unknown,
): Promise<Response> {
  const req = new Request(`https://worker.test${path}`, {
    method,
    headers: { ...AUTH, "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("proxies_seen table (Phase 2 / ADR-004)", () => {
  it("populates proxies_seen from proxy_pool on register", async () => {
    const r = await workerFetch("/register", "POST", {
      holder_id: "holder-A",
      proxy_pool: [
        { id: "P-A", name: "P-A" },
        { id: "P-B", name: "P-B" },
      ],
    });
    expect(r.status).toBe(200);

    const list = await workerFetch("/proxies_seen", "GET");
    expect(list.status).toBe(200);
    const data = (await list.json()) as {
      proxies?: Array<{ id: string; name: string }>;
    };
    const ids = (data.proxies ?? []).map((p) => p.id).sort();
    expect(ids).toContain("P-A");
    expect(ids).toContain("P-B");
  });

  it("updates last_seen_ms on repeat register", async () => {
    await workerFetch("/register", "POST", {
      holder_id: "holder-B",
      proxy_pool: [{ id: "P-Refresh", name: "P-Refresh" }],
    });
    const list1 = await workerFetch("/proxies_seen", "GET");
    const data1 = (await list1.json()) as {
      proxies?: Array<{ id: string; last_seen_ms: number }>;
    };
    const firstSeen =
      data1.proxies?.find((p) => p.id === "P-Refresh")?.last_seen_ms ?? 0;
    expect(firstSeen).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 10));

    await workerFetch("/register", "POST", {
      holder_id: "holder-B",
      proxy_pool: [{ id: "P-Refresh", name: "P-Refresh" }],
    });
    const list2 = await workerFetch("/proxies_seen", "GET");
    const data2 = (await list2.json()) as {
      proxies?: Array<{ id: string; last_seen_ms: number; first_seen_ms: number }>;
    };
    const refreshed = data2.proxies?.find((p) => p.id === "P-Refresh");
    expect(refreshed).toBeDefined();
    expect(refreshed!.last_seen_ms).toBeGreaterThanOrEqual(firstSeen);
  });

  it("tolerates missing proxy_pool field on register (backward compat)", async () => {
    const r = await workerFetch("/register", "POST", { holder_id: "holder-old" });
    expect(r.status).toBe(200);
    // proxies_seen must still be queryable (may or may not have new rows; just don't crash)
    const list = await workerFetch("/proxies_seen", "GET");
    expect(list.status).toBe(200);
  });

  it("DELETE /proxies_seen removes the entry", async () => {
    await workerFetch("/register", "POST", {
      holder_id: "holder-del",
      proxy_pool: [{ id: "P-Delete-Me", name: "P-Delete-Me" }],
    });
    const before = await workerFetch("/proxies_seen", "GET");
    const dataBefore = (await before.json()) as {
      proxies?: Array<{ id: string }>;
    };
    expect(dataBefore.proxies?.some((p) => p.id === "P-Delete-Me")).toBe(true);

    const del = await workerFetch("/proxies_seen?id=P-Delete-Me", "DELETE");
    expect(del.status).toBe(200);

    const after = await workerFetch("/proxies_seen", "GET");
    const dataAfter = (await after.json()) as {
      proxies?: Array<{ id: string }>;
    };
    expect(dataAfter.proxies?.some((p) => p.id === "P-Delete-Me")).toBe(false);
  });
});
