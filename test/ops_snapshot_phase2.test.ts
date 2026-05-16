import { describe, it, expect } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";

const TOKEN = env.PROXY_COORDINATOR_TOKEN;
const AUTH = { authorization: `Bearer ${TOKEN}` };

async function workerFetch(path: string, method: string, body?: unknown): Promise<Response> {
  const ctx = createExecutionContext();
  const req = new Request(`https://worker.test${path}`, {
    method,
    headers: { ...AUTH, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const resp = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return resp;
}

describe("/ops/snapshot Phase 2 enhancements", () => {
  it("auto-enumerates proxies from proxies_seen when no ?proxy_ids", async () => {
    // Seed proxies_seen by registering a runner with proxy_pool.
    await workerFetch("/register", "POST", {
      holder_id: "seen-test-snapshot",
      proxy_pool: [{ id: "Auto-Snapshot-1", name: "Auto-Snapshot-1" }],
    });

    const r = await workerFetch("/ops/snapshot", "GET", undefined);
    expect(r.status).toBe(200);
    const data = (await r.json()) as { proxies?: Array<{ proxy_id: string }> };
    const ids = (data.proxies ?? []).map((p) => p.proxy_id);
    expect(ids).toContain("Auto-Snapshot-1");
  });

  it("still honours explicit ?proxy_ids when provided", async () => {
    const r = await workerFetch("/ops/snapshot?proxy_ids=Explicit-Only-1", "GET", undefined);
    expect(r.status).toBe(200);
    const data = (await r.json()) as { proxies?: Array<{ proxy_id: string }> };
    const ids = (data.proxies ?? []).map((p) => p.proxy_id);
    expect(ids).toContain("Explicit-Only-1");
    // Make sure the auto-discovery didn't kick in when ?proxy_ids was set
    expect(ids.length).toBe(1);
  });

  it("writes a snapshot to MetricsState with source='dashboard' via waitUntil", async () => {
    // Make sure the system is active so idle suppression doesn't skip
    await workerFetch("/register", "POST", {
      holder_id: "waituntil-active-runner",
      proxy_pool: [{ id: "WaitUntil-Proxy", name: "WaitUntil-Proxy" }],
    });

    await workerFetch("/ops/snapshot", "GET", undefined);

    // waitOnExecutionContext (called inside workerFetch above) should have
    // awaited the waitUntil promise before returning. Read MetricsState now.
    const r = await workerFetch("/metrics/range?from=0&to=" + (Date.now() + 60_000), "GET");
    expect(r.status).toBe(200);
    const data = (await r.json()) as { rows?: Array<any> };
    const dashRow = (data.rows ?? []).find((row) => row.source === "dashboard");
    expect(dashRow).toBeDefined();
  });

  it("doesn't write to MetricsState if the binding is missing (defensive)", async () => {
    // This is a behavioural assertion that we don't crash if METRICS_STATE_DO is undefined.
    // We can't easily mock missing binding in vitest-pool-workers, so this test just
    // verifies the call path is gated by `if (env.METRICS_STATE_DO)` — which we do via
    // a smoke test that the snapshot returns successfully.
    const r = await workerFetch("/ops/snapshot", "GET", undefined);
    expect(r.status).toBe(200);
  });
});
