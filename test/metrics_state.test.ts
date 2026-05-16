/**
 * Phase 2 / ADR-003 — MetricsState DO tests.
 *
 * All requests go through the Worker's auth layer (Bearer token required),
 * which then buffers the DO response body before forwarding — this avoids
 * the vitest-pool-workers isolated-storage WAL-file snapshot error that
 * occurs when SQLite-backed DOs are called via direct stub.fetch().
 *
 * Covers: active write, idle skip, active→idle transition marker, 5s bucket
 * dedup via INSERT OR REPLACE, top-of-hour heartbeat anchor, range query
 * bounds, and retention prune.
 */

import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, it, expect } from "vitest";
import worker, { _resetRateLimitBucketsForTesting } from "../src/index";

const TOKEN = "test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

afterEach(() => {
  _resetRateLimitBucketsForTesting();
});

async function rawFetch(path: string, init: RequestInit): Promise<Response> {
  const req = new Request(`https://test.invalid${path}`, init);
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function postMetrics(path: string, body: unknown): Promise<Response> {
  return rawFetch(path, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getMetricsRange(from: number, to: number): Promise<Response> {
  return rawFetch(`/metrics/range?from=${from}&to=${to}`, {
    method: "GET",
    headers: { ...AUTH },
  });
}

describe("MetricsState", () => {
  describe("recordSnapshot", () => {
    it("writes a row when state is active", async () => {
      const activePayload = {
        runners: { active_runners: [{ holder_id: "h1" }] },
        signals: { active_signals: [] },
        proxies: [],
      };
      const r = await postMetrics("/metrics/record", {
        ts: 10_000, payload: activePayload, source: "cron",
      });
      expect(r.status).toBe(200);
      const queryR = await getMetricsRange(0, 20000);
      const { rows } = (await queryR.json()) as any;
      expect(rows).toHaveLength(1);
      expect(rows[0].ts).toBe(10_000);
      expect(rows[0].source).toBe("cron");
    });

    it("skips the write when state is idle", async () => {
      const idlePayload = {
        runners: { active_runners: [] },
        signals: { active_signals: [] },
        proxies: [],
        work: { queued: 0, in_flight: 0 },
      };
      const r = await postMetrics("/metrics/record", {
        ts: 10_000, payload: idlePayload, source: "cron",
      });
      const { skipped } = (await r.json()) as any;
      expect(skipped).toBe(true);
      const queryR = await getMetricsRange(0, 20000);
      const { rows } = (await queryR.json()) as any;
      expect(rows).toHaveLength(0);
    });

    it("writes a transition marker on active→idle boundary", async () => {
      const active = {
        runners: { active_runners: [{ holder_id: "h1" }] },
        signals: { active_signals: [] },
        proxies: [],
      };
      const idle = {
        runners: { active_runners: [] },
        signals: { active_signals: [] },
        proxies: [],
        work: { queued: 0, in_flight: 0 },
      };
      await postMetrics("/metrics/record", { ts: 10_000, payload: active, source: "cron" });
      await postMetrics("/metrics/record", { ts: 70_000, payload: idle, source: "cron" });
      const queryR = await getMetricsRange(0, 120000);
      const { rows } = (await queryR.json()) as any;
      expect(rows.map((r: any) => r.ts)).toEqual([10_000, 70_000]);
      expect(rows[1].is_transition_marker).toBe(true);
    });

    it("dedupes writes within the same 5s bucket via INSERT OR REPLACE", async () => {
      const active = {
        runners: { active_runners: [{ holder_id: "h1" }] },
        signals: { active_signals: [] },
        proxies: [],
      };
      // ts=10_000 and ts=12_500 both bucket to 10_000 (floor 12500/5000 = 2 * 5000 = 10_000)
      await postMetrics("/metrics/record", { ts: 10_000, payload: active, source: "cron" });
      await postMetrics("/metrics/record", { ts: 12_500, payload: active, source: "dashboard" });
      const queryR = await getMetricsRange(0, 20000);
      const { rows } = (await queryR.json()) as any;
      expect(rows).toHaveLength(1);
      expect(rows[0].ts).toBe(10_000);
      expect(rows[0].source).toBe("dashboard");
    });

    it("writes an hourly heartbeat anchor even when idle", async () => {
      const idle = {
        runners: { active_runners: [] },
        signals: { active_signals: [] },
        proxies: [],
        work: { queued: 0, in_flight: 0 },
      };
      // 3600_000 ms = 1:00:00 — top-of-hour. ts % HOUR_MS < BUCKET_MS triggers anchor.
      const TOP_OF_HOUR = 3600_000;
      const r = await postMetrics("/metrics/record", {
        ts: TOP_OF_HOUR, payload: idle, source: "cron",
      });
      const { skipped } = (await r.json()) as any;
      expect(skipped).toBeFalsy();
      const queryR = await getMetricsRange(0, 7200000);
      const { rows } = (await queryR.json()) as any;
      expect(rows).toHaveLength(1);
      expect(rows[0].is_heartbeat_anchor).toBe(true);
    });
  });

  describe("range query", () => {
    it("returns rows within [from, to] in ascending ts order", async () => {
      const active = {
        runners: { active_runners: [{ holder_id: "h1" }] },
        signals: { active_signals: [] },
        proxies: [],
      };
      for (const ts of [60_000, 120_000, 180_000]) {
        await postMetrics("/metrics/record", { ts, payload: active, source: "cron" });
      }
      const queryR = await getMetricsRange(100000, 150000);
      const { rows } = (await queryR.json()) as any;
      expect(rows.map((r: any) => r.ts)).toEqual([120_000]);
    });
  });

  describe("retention sweep", () => {
    it("drops rows older than METRICS_RETENTION_DAYS on prune", async () => {
      const active = {
        runners: { active_runners: [{ holder_id: "h1" }] },
        signals: { active_signals: [] },
        proxies: [],
      };
      const ONE_DAY_MS = 86_400_000;
      const NOW = ONE_DAY_MS * 100;
      await postMetrics("/metrics/record", { ts: NOW - 40 * ONE_DAY_MS, payload: active, source: "cron" });
      await postMetrics("/metrics/record", { ts: NOW - 10 * ONE_DAY_MS, payload: active, source: "cron" });

      const r = await postMetrics("/metrics/prune", {
        now_ms: NOW, retention_days: 30, max_rows: 1000,
      });
      expect(r.status).toBe(200);

      const queryR = await getMetricsRange(0, NOW);
      const { rows } = (await queryR.json()) as any;
      expect(rows).toHaveLength(1);
      expect(rows[0].ts).toBe(NOW - 10 * ONE_DAY_MS);
    });
  });
});
