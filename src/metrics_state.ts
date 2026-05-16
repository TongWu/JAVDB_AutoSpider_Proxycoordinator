import { pruneLogTable } from "./event_log_helpers";
import { Env } from "./types";

/**
 * Phase 2 / ADR-003 — MetricsState Durable Object.
 *
 * Persists time-series snapshots of the /ops/snapshot payload for
 * dashboard charts and history drill-downs.
 *
 * Schema:
 *   metrics_snapshots(
 *     ts INTEGER PRIMARY KEY,            -- 5s bucket: floor(write_ts_ms / 5000) * 5000
 *     payload TEXT NOT NULL,             -- JSON of /ops/snapshot payload
 *     source TEXT NOT NULL,              -- 'cron' | 'dashboard'
 *     is_transition_marker INTEGER DEFAULT 0,  -- 1 = active→idle boundary write
 *     is_heartbeat_anchor INTEGER DEFAULT 0    -- 1 = top-of-hour anchor (even if idle)
 *   );
 *
 *   metrics_state(
 *     key TEXT PRIMARY KEY,              -- singleton row: "last_state"
 *     was_active INTEGER NOT NULL,       -- 0 or 1, previous write's activity flag
 *     last_ts_ms INTEGER NOT NULL        -- bucket ts of the previous write
 *   );
 *
 * Idle suppression rules (see ADR-003):
 *   - active state → always write
 *   - active → idle (first idle tick after active): write transition marker
 *   - idle → idle (consecutive idle): skip, UNLESS top-of-hour (write heartbeat anchor)
 *   - idle → active: write, clear idle tracking
 *
 * 5-second bucket primary key plus INSERT OR REPLACE means cron 1-min and
 * dashboard 5-sec writes naturally deduplicate when they coincide.
 *
 * Storage note: all state (snapshots + idle-tracking) lives in SQLite so the
 * DO uses a single storage backend. Mixing `storage.put/get` (KV) with
 * `storage.sql` in the same DO causes vitest-pool-workers' isolated-storage
 * snapshot mechanism to fail (it sees both `.sqlite` and KV files and can't
 * reconcile the frame boundary).
 */

const BUCKET_MS = 5_000;
const HOUR_MS = 3_600_000;

interface RecordRequest {
  ts: number;
  payload: Record<string, unknown>;
  source: "cron" | "dashboard";
}

function bucketKey(ts: number): number {
  return Math.floor(ts / BUCKET_MS) * BUCKET_MS;
}

function isPayloadActive(payload: Record<string, unknown>): boolean {
  const runners = (payload as any).runners?.active_runners ?? [];
  const signals = (payload as any).signals?.active_signals ?? [];
  const work = (payload as any).work ?? {};
  if (Array.isArray(runners) && runners.length > 0) return true;
  if (Array.isArray(signals) && signals.length > 0) return true;
  if (typeof work.queued === "number" && work.queued > 0) return true;
  if (typeof work.in_flight === "number" && work.in_flight > 0) return true;
  return false;
}

function isHourAnchor(ts: number): boolean {
  return ts % HOUR_MS < BUCKET_MS;
}

export class MetricsState implements DurableObject {
  private sql: SqlStorage;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.sql = state.storage.sql;
    this.env = env;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS metrics_snapshots (
        ts INTEGER PRIMARY KEY,
        payload TEXT NOT NULL,
        source TEXT NOT NULL,
        is_transition_marker INTEGER DEFAULT 0,
        is_heartbeat_anchor INTEGER DEFAULT 0
      );
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_source
      ON metrics_snapshots(source, ts);
    `);
    // Singleton row for idle-suppression state. Using SQLite (not storage.put)
    // keeps all state in one storage backend to avoid vitest isolated-storage
    // frame mismatches when mixing KV and SQL writes.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS metrics_state (
        key TEXT PRIMARY KEY,
        was_active INTEGER NOT NULL DEFAULT 0,
        last_ts_ms INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/do/metrics/record" && request.method === "POST") {
      return this.handleRecord((await request.json()) as RecordRequest);
    }
    if (url.pathname === "/do/metrics/range" && request.method === "GET") {
      const from = parseInt(url.searchParams.get("from") ?? "0", 10);
      const to = parseInt(url.searchParams.get("to") ?? `${Date.now()}`, 10);
      return this.handleRange(from, to);
    }
    if (url.pathname === "/do/metrics/prune" && request.method === "POST") {
      const body = (await request.json()) as {
        now_ms?: number; retention_days?: number; max_rows?: number;
      };
      const now = body.now_ms ?? Date.now();
      const retentionDays = body.retention_days ?? parseInt(this.env.METRICS_RETENTION_DAYS ?? "30", 10);
      const maxRows = body.max_rows ?? parseInt(this.env.METRICS_MAX_ROWS ?? "100000", 10);
      pruneLogTable(this.sql, "metrics_snapshots", retentionDays * 86_400_000, maxRows, now);
      return new Response(JSON.stringify({ pruned: true }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }

  private handleRecord(req: RecordRequest): Response {
    const bucket = bucketKey(req.ts);
    const active = isPayloadActive(req.payload);
    const anchor = isHourAnchor(req.ts);

    // Read idle-tracking state from the singleton metrics_state row.
    // Use Array.from + [0] instead of .one() so an empty table returns null
    // rather than throwing "Expected exactly one result".
    const lastRows = Array.from(
      this.sql.exec<{ was_active: number; last_ts_ms: number }>(
        `SELECT was_active, last_ts_ms FROM metrics_state WHERE key = 'last_state'`,
      ),
    );
    const lastRow = lastRows[0] ?? null;
    const wasActive = lastRow !== null && Boolean(lastRow.was_active);

    let shouldWrite = false;
    let isTransition = false;
    let isAnchor = false;

    if (active) {
      shouldWrite = true;
    } else if (wasActive) {
      // First idle tick after an active period — write transition marker.
      shouldWrite = true;
      isTransition = true;
    } else if (anchor) {
      // Consecutive idle but top-of-hour — write heartbeat anchor.
      shouldWrite = true;
      isAnchor = true;
    }

    if (!shouldWrite) {
      return new Response(JSON.stringify({ skipped: true }), {
        headers: { "content-type": "application/json" },
      });
    }

    this.sql.exec(
      `INSERT OR REPLACE INTO metrics_snapshots
       (ts, payload, source, is_transition_marker, is_heartbeat_anchor)
       VALUES (?, ?, ?, ?, ?)`,
      bucket,
      JSON.stringify(req.payload),
      req.source,
      isTransition ? 1 : 0,
      isAnchor ? 1 : 0,
    );

    // Upsert the idle-tracking state.
    this.sql.exec(
      `INSERT OR REPLACE INTO metrics_state (key, was_active, last_ts_ms)
       VALUES ('last_state', ?, ?)`,
      active ? 1 : 0,
      bucket,
    );

    return new Response(JSON.stringify({ skipped: false, bucket }), {
      headers: { "content-type": "application/json" },
    });
  }

  private handleRange(from: number, to: number): Response {
    const rows = Array.from(
      this.sql.exec<{
        ts: number;
        payload: string;
        source: string;
        is_transition_marker: number;
        is_heartbeat_anchor: number;
      }>(
        `SELECT ts, payload, source, is_transition_marker, is_heartbeat_anchor
         FROM metrics_snapshots
         WHERE ts >= ? AND ts <= ?
         ORDER BY ts ASC`,
        from,
        to,
      ),
    ).map((r) => ({
      ts: r.ts,
      payload: JSON.parse(r.payload),
      source: r.source,
      is_transition_marker: Boolean(r.is_transition_marker),
      is_heartbeat_anchor: Boolean(r.is_heartbeat_anchor),
    }));
    return new Response(JSON.stringify({ rows }), {
      headers: { "content-type": "application/json" },
    });
  }
}
