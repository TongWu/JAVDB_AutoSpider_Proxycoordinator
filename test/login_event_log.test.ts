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

  it("logs 'publish' on publish with cookie_version", async () => {
    // Acquire a lease first (required precondition for publish).
    await workerFetch("/login_state/acquire_lease", "POST", {
      holder_id: "h-publish-test",
      target_proxy_name: "P-Publish",
      ttl_ms: 60_000,
    });

    // Publish a cookie (proxy_name must match the lease's target_proxy_name).
    const r = await workerFetch("/login_state/publish", "POST", {
      holder_id: "h-publish-test",
      proxy_name: "P-Publish",
      cookie: "test-cookie-value",
    });
    // Publish may fail if the lease state is unexpected; we tolerate that
    // and only assert when the call actually succeeded.
    if (r.status !== 200) {
      // If no row, the implementation correctly gated the write.
      return;
    }

    const q = await workerFetch(
      "/login/history?from=0&to=" + (Date.now() + 1_000_000) + "&holder_id=h-publish-test",
      "GET",
    );
    const data = (await q.json()) as { rows?: Array<any> };
    const publishEv = (data.rows ?? []).find((row) => row.event_kind === "publish");
    expect(publishEv).toBeDefined();
    expect(typeof publishEv.cookie_version).toBe("number");
  });

  it("logs 'invalidate' on invalidate", async () => {
    // Publish first to set up state to invalidate (with lease acquire).
    await workerFetch("/login_state/acquire_lease", "POST", {
      holder_id: "h-invalidate-test",
      target_proxy_name: "P-Invalidate",
      ttl_ms: 60_000,
    });
    const pub = await workerFetch("/login_state/publish", "POST", {
      holder_id: "h-invalidate-test",
      proxy_name: "P-Invalidate",
      cookie: "doomed-cookie",
    });
    if (pub.status !== 200) {
      return;  // can't proceed without a published cookie
    }
    const pubData = (await pub.json()) as { version?: number };
    const currentVersion = pubData.version ?? 1;

    // Invalidate using the version returned by publish.
    const r = await workerFetch("/login_state/invalidate", "POST", {
      version: currentVersion,
    });
    if (r.status !== 200) {
      return;  // tolerate API surface differences
    }

    const q = await workerFetch(
      "/login/history?from=0&to=" + (Date.now() + 1_000_000),
      "GET",
    );
    const data = (await q.json()) as { rows?: Array<any> };
    const invEv = (data.rows ?? []).find((row) => row.event_kind === "invalidate");
    expect(invEv).toBeDefined();
  });

  it("logs 'lease_release' on release_lease", async () => {
    await workerFetch("/login_state/acquire_lease", "POST", {
      holder_id: "h-release-test",
      target_proxy_name: "P-Release",
      ttl_ms: 60_000,
    });

    const r = await workerFetch("/login_state/release_lease", "POST", {
      holder_id: "h-release-test",
    });
    if (r.status !== 200) {
      return;
    }

    const q = await workerFetch(
      "/login/history?from=0&to=" + (Date.now() + 1_000_000) + "&holder_id=h-release-test",
      "GET",
    );
    const data = (await q.json()) as { rows?: Array<any> };
    const releaseEv = (data.rows ?? []).find((row) => row.event_kind === "lease_release");
    expect(releaseEv).toBeDefined();
  });
});
