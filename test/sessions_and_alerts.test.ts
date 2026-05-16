/**
 * Phase-1 ADR-008 — tests for session lifecycle reporting + alert dispatch.
 *
 * Covers:
 *   - /register / /heartbeat / /unregister payloads with `session` field
 *   - /sessions endpoint returns active / recent_failed / recent_committed
 *   - /alerts endpoint surfaces session_failed records
 *   - /alerts/ack toggles the ack flag
 *   - /alerts/test produces a manual_test row
 *   - /proxies/ban + /proxies/unban mutate ban state
 *   - pipeline_paused_until is echoed on the register response
 */

import {
  env,
  createExecutionContext,
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

interface SessionRow {
  session_id: string;
  status: string;
  write_mode: string;
  failure_reason: string;
  workflow_run_id: string;
  workflow_name: string;
  holder_id: string;
  started_at: number;
  updated_at: number;
  ended_at: number;
}

interface SessionsResp {
  active: SessionRow[];
  recent_failed: SessionRow[];
  recent_committed: SessionRow[];
  server_time: number;
}

interface AlertRow {
  id: string;
  kind: string;
  ts: number;
  severity: string;
  summary: string;
  details: Record<string, unknown>;
  ack: number;
}

interface AlertsResp {
  alerts: AlertRow[];
  server_time: number;
}

describe("session lifecycle reporting", () => {
  it("register/heartbeat/unregister upserts session row", async () => {
    const holder = "phase1-holder-" + crypto.randomUUID().slice(0, 8);
    const sessionId = "20260516T120000.000000Z-aaaa-bbbb";
    await jsonPost("/register", {
      holder_id: holder,
      workflow_run_id: "wf-1",
      workflow_name: "DailyIngestion",
      session: {
        session_id: sessionId,
        status: "in_progress",
        write_mode: "pending",
        report_type: "daily",
      },
    });
    const after = await jsonGet<SessionsResp>("/sessions");
    const active = after.active.find((r) => r.session_id === sessionId);
    expect(active).toBeDefined();
    expect(active?.status).toBe("in_progress");
    expect(active?.write_mode).toBe("pending");
    expect(active?.holder_id).toBe(holder);

    // Heartbeat → finalizing
    await jsonPost("/heartbeat", {
      holder_id: holder,
      session: { session_id: sessionId, status: "finalizing" },
    });
    const mid = await jsonGet<SessionsResp>("/sessions");
    const inProgress = mid.active.find((r) => r.session_id === sessionId);
    expect(inProgress?.status).toBe("finalizing");

    // Unregister → committed
    await jsonPost("/unregister", {
      holder_id: holder,
      session: { session_id: sessionId, status: "committed" },
    });
    const end = await jsonGet<SessionsResp>("/sessions");
    expect(
      end.recent_committed.find((r) => r.session_id === sessionId),
    ).toBeDefined();
    expect(end.active.find((r) => r.session_id === sessionId)).toBeUndefined();
  });

  it("malformed session payload is silently dropped (fail-open)", async () => {
    const holder = "phase1-mal-" + crypto.randomUUID().slice(0, 8);
    // Missing required `status` — Worker MUST still accept the register.
    const resp = await jsonPost<{ registered: boolean }>("/register", {
      holder_id: holder,
      session: { session_id: "bad" },
    });
    expect(resp.registered).toBe(true);
    const after = await jsonGet<SessionsResp>("/sessions");
    expect(after.active.find((r) => r.session_id === "bad")).toBeUndefined();
  });
});

describe("alerts surface", () => {
  it("session_failed emits an alert that surfaces on /alerts", async () => {
    const holder = "phase1-fail-" + crypto.randomUUID().slice(0, 8);
    const sessionId = "20260516T120000.000000Z-cccc-dddd";
    // Register with in_progress, then heartbeat with failed → alert.
    await jsonPost("/register", {
      holder_id: holder,
      session: {
        session_id: sessionId,
        status: "in_progress",
        write_mode: "audit",
      },
    });
    await jsonPost("/heartbeat", {
      holder_id: holder,
      session: {
        session_id: sessionId,
        status: "failed",
        failure_reason: "spider crash: connection reset",
      },
    });
    const alerts = await jsonGet<AlertsResp>("/alerts");
    const myAlert = alerts.alerts.find((a) =>
      a.id === `sessfail-${sessionId}`,
    );
    expect(myAlert).toBeDefined();
    expect(myAlert?.kind).toBe("session_failed");
    expect(myAlert?.ack).toBe(0);
    expect(myAlert?.details?.failure_reason).toBe("spider crash: connection reset");

    // Repeated failed heartbeat should NOT multiply alerts (idempotent id).
    await jsonPost("/heartbeat", {
      holder_id: holder,
      session: { session_id: sessionId, status: "failed" },
    });
    const after = await jsonGet<AlertsResp>("/alerts");
    const dupes = after.alerts.filter((a) =>
      a.id === `sessfail-${sessionId}`,
    );
    expect(dupes.length).toBe(1);
  });

  it("/alerts/ack flips the ack flag", async () => {
    const holder = "phase1-ack-" + crypto.randomUUID().slice(0, 8);
    const sessionId = "20260516T120000.000000Z-eeee-ffff";
    await jsonPost("/register", {
      holder_id: holder,
      session: {
        session_id: sessionId,
        status: "failed",
        failure_reason: "ack-test",
      },
    });
    const before = await jsonGet<AlertsResp>("/alerts");
    const target = before.alerts.find((a) =>
      a.id === `sessfail-${sessionId}`,
    );
    expect(target?.ack).toBe(0);
    await jsonPost("/alerts/ack", { id: `sessfail-${sessionId}` });
    const after = await jsonGet<AlertsResp>("/alerts");
    const target2 = after.alerts.find((a) =>
      a.id === `sessfail-${sessionId}`,
    );
    expect(target2?.ack).toBe(1);
  });

  it("/alerts/test records a manual_test alert", async () => {
    await jsonPost("/alerts/test", { summary: "phase1 probe" });
    const alerts = await jsonGet<AlertsResp>("/alerts");
    const probe = alerts.alerts.find(
      (a) => a.kind === "manual_test" && a.summary === "phase1 probe",
    );
    expect(probe).toBeDefined();
    expect(probe?.details?.triggered_by).toBe("dashboard");
  });
});

describe("mutation buttons", () => {
  it("/proxies/ban followed by /proxies/unban toggles state", async () => {
    const proxy = "phase1-proxy-" + crypto.randomUUID().slice(0, 6);
    // Initial state should be live (no ban).
    const initial = await jsonGet<{ banned?: boolean }>(
      `/state?proxy_id=${proxy}`,
    );
    expect(initial.banned).not.toBe(true);
    await jsonPost("/proxies/ban", {
      proxy_id: proxy,
      ttl_ms: 60_000,
      reason: "unit test ban",
    });
    const banned = await jsonGet<{ banned?: boolean; bannedUntil?: number | null }>(
      `/state?proxy_id=${proxy}`,
    );
    expect(banned.banned).toBe(true);
    await jsonPost("/proxies/unban", {
      proxy_id: proxy,
      reason: "unit test unban",
    });
    const unbanned = await jsonGet<{ banned?: boolean }>(
      `/state?proxy_id=${proxy}`,
    );
    expect(unbanned.banned).not.toBe(true);
  });
});

describe("pipeline pause echo", () => {
  it("register echoes pipeline_paused_until from ConfigState", async () => {
    const future = Date.now() + 60 * 60_000;
    // Set the pause via PATCH /config (single-key shape supported by ConfigState).
    const res = await rawFetch("/config", {
      method: "PATCH",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        values: {
          pipeline_paused_until: String(future),
          pipeline_pause_reason: "phase1 unit test",
        },
      }),
    });
    expect(res.status).toBe(200);
    const reg = await jsonPost<{
      registered: boolean;
      pipeline_paused_until?: number;
      pipeline_pause_reason?: string;
    }>("/register", { holder_id: "phase1-paused" });
    expect(reg.pipeline_paused_until).toBe(future);
    expect(reg.pipeline_pause_reason).toBe("phase1 unit test");
  });
});
