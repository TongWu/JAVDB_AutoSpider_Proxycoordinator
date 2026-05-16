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

describe("login_event_log (Phase 2 / ADR-002)", () => {
  it("logs 'attempt' with outcome and holder_id from record_attempt", async () => {
    // record_attempt is the only login endpoint that takes a holder_id.
    // Look at types.ts RecordAttemptRequest for the exact body shape.
    // The typical shape (verify in code) is:
    //   { proxy_id?: string, success: boolean, holder_id?: string, detail?: string }
    await workerFetch("/login_state/record_attempt", "POST", {
      proxy_id: "P-1",
      success: false,
      holder_id: "h-login-attempt-1",
      detail: "wrong password",
    });

    const q = await workerFetch(
      "/login/history?from=0&to=" + (Date.now() + 1_000_000) + "&holder_id=h-login-attempt-1",
      "GET",
    );
    expect(q.status).toBe(200);
    const data = (await q.json()) as { rows?: Array<any> };
    const attempt = (data.rows ?? []).find(
      (r) => r.event_kind === "attempt" && r.holder_id === "h-login-attempt-1",
    );
    expect(attempt).toBeDefined();
    expect(attempt!.outcome).toBe("failure");
  });

  it("logs 'attempt' with outcome=success", async () => {
    await workerFetch("/login_state/record_attempt", "POST", {
      proxy_id: "P-2",
      success: true,
      holder_id: "h-login-attempt-2",
    });

    const q = await workerFetch(
      "/login/history?from=0&to=" + (Date.now() + 1_000_000) + "&holder_id=h-login-attempt-2",
      "GET",
    );
    const data = (await q.json()) as { rows?: Array<any> };
    const attempt = (data.rows ?? []).find(
      (r) => r.event_kind === "attempt" && r.holder_id === "h-login-attempt-2",
    );
    expect(attempt!.outcome).toBe("success");
  });

  it("logs 'lease_acquire' on acquire_lease", async () => {
    await workerFetch("/login_state/acquire_lease", "POST", {
      holder_id: "h-lease-1",
      ttl_ms: 60_000,
    });
    const q = await workerFetch(
      "/login/history?from=0&to=" + (Date.now() + 1_000_000) + "&holder_id=h-lease-1",
      "GET",
    );
    const data = (await q.json()) as { rows?: Array<any> };
    const ev = (data.rows ?? []).find((r) => r.event_kind === "lease_acquire");
    expect(ev).toBeDefined();
  });

  it("returns empty array when no events match the filter window", async () => {
    const q = await workerFetch(
      "/login/history?from=0&to=1000",
      "GET",
    );
    expect(q.status).toBe(200);
    const data = (await q.json()) as { rows?: Array<any> };
    expect(Array.isArray(data.rows)).toBe(true);
    // No events should have ts < 1000 (we're working in ms-since-epoch space, which is way beyond 1970)
    expect(data.rows!.length).toBe(0);
  });
});
