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

describe("runners_event_log (Phase 2 / ADR-002)", () => {
  it("logs 'register' and 'unregister' events", async () => {
    await workerFetch("/register", "POST", {
      holder_id: "rlog-A",
      workflow_run_id: "run-1",
      workflow_name: "DailyIngestion",
      proxy_pool_hash: "deadbeef0000beef",
    });
    await workerFetch("/unregister", "POST", { holder_id: "rlog-A" });

    const q = await workerFetch(
      "/runners/history?from=0&to=" + (Date.now() + 1_000_000) + "&holder_id=rlog-A",
      "GET",
    );
    expect(q.status).toBe(200);
    const data = (await q.json()) as { rows?: Array<any> };
    const kinds = (data.rows ?? []).map((r) => r.event_kind).sort();
    expect(kinds).toContain("register");
    expect(kinds).toContain("unregister");
    const unreg = (data.rows ?? []).find((r) => r.event_kind === "unregister");
    expect(unreg.final_status).toBe("completed");
  });

  it("queries via /runners/history with holder_id filter", async () => {
    await workerFetch("/register", "POST", {
      holder_id: "rlog-filter",
      workflow_run_id: "run-2",
      workflow_name: "AdHoc",
    });
    const q = await workerFetch(
      "/runners/history?from=0&to=" + (Date.now() + 1_000_000) + "&holder_id=rlog-filter",
      "GET",
    );
    expect(q.status).toBe(200);
    const data = (await q.json()) as { rows?: Array<any> };
    expect(data.rows?.every((r) => r.holder_id === "rlog-filter")).toBe(true);
    expect(data.rows?.length).toBeGreaterThan(0);
  });

  it("returns all runners when no holder_id filter", async () => {
    const q = await workerFetch(
      "/runners/history?from=0&to=" + (Date.now() + 1_000_000),
      "GET",
    );
    expect(q.status).toBe(200);
    const data = (await q.json()) as { rows?: Array<any> };
    // Just confirm it doesn't crash; row count depends on prior tests in same suite
    expect(Array.isArray(data.rows)).toBe(true);
  });
});
