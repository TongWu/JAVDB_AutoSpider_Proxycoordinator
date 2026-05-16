import {
  Env,
  WorkCompleteRequest,
  WorkCompleteResponse,
  WorkEnqueueRequest,
  WorkEnqueueResponse,
  WorkItem,
  WorkLease,
  WorkPullRequest,
  WorkPullResponse,
  WorkReleaseRequest,
  WorkReleaseResponse,
  WorkStatsResponse,
} from "./types";

/**
 * WorkDistributor — singleton DO that maintains a deduplicated FIFO
 * work queue with visibility leases (W5.2).
 *
 * Addressed by ``idFromName("global-work")`` from
 * {@link forwardToWorkDistributorDo} in {@link ./index.ts}.
 *
 * Semantics:
 *
 * - Items are keyed by a caller-supplied string. Re-enqueue of an
 *   existing key is a no-op by default (idempotent producers); pass
 *   ``replace_existing=true`` to overwrite the payload while
 *   preserving the existing ``attempt_count``.
 *
 * - ``POST /work/pull`` returns up to ``max_items`` items that are NOT
 *   currently leased to another holder (or whose leases have expired).
 *   Each pulled item gets a fresh lease for the caller's
 *   ``visibility_timeout_ms``. The DO's single-threaded execution
 *   model guarantees two concurrent pulls cannot lease the same item.
 *
 * - ``POST /work/complete`` removes items entirely. Non-owner completes
 *   are silently skipped (a stale holder whose lease expired and was
 *   reclaimed by another puller shouldn't be able to drop an item the
 *   new holder is still working on).
 *
 * - ``POST /work/release`` returns items to the visible pool without
 *   marking them done. Same non-owner skip rule.
 *
 * - The DO's GC alarm purges expired leases every 5 minutes so a
 *   crashed runner's leases eventually free up even if no other
 *   puller hits the visible-pool filter.
 *
 * Coexists with MovieClaim: the queue's per-key dedup is the primary
 * cross-runner exclusivity primitive when this DO is in use, but the
 * Python client keeps the MovieClaim mutex as a defence-in-depth
 * layer — operators can flip between the two coordination models
 * without a coordinated client deploy.
 *
 * Storage layout (single-key snapshot, mirrors RunnerRegistry):
 *
 *   - ``state`` → ``{ items: Record<key, WorkItem>, leases: Record<key, WorkLease> }``
 */

const STORAGE_KEY = "state";
const ALARM_INTERVAL_MS = 5 * 60 * 1000; // 5 min

const ENQUEUE_MAX_ITEMS_PER_CALL = 100;
const PULL_MAX_ITEMS_PER_CALL = 100;
const PULL_DEFAULT_MAX_ITEMS = 10;
const PULL_DEFAULT_VISIBILITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
const PULL_MIN_VISIBILITY_TIMEOUT_MS = 1_000;
const PULL_MAX_VISIBILITY_TIMEOUT_MS = 60 * 60 * 1000; // 1 h

const KEY_MAX_LEN = 512;

interface WorkData {
  items: Record<string, WorkItem>;
  leases: Record<string, WorkLease>;
}

export class WorkDistributor implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private cached: WorkData | null = null;
  private alarmScheduled = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/do/work/enqueue":
          return await this.handleEnqueue(request);
        case "/do/work/pull":
          return await this.handlePull(request);
        case "/do/work/complete":
          return await this.handleComplete(request);
        case "/do/work/release":
          return await this.handleRelease(request);
        case "/do/work/stats":
          return await this.handleStats();
        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("WorkDistributor DO handler error", {
        path: url.pathname,
        error: message,
      });
      return jsonResponse({ error: "internal_error" }, 500);
    }
  }

  /**
   * GC alarm — purge expired leases so a crashed holder's items
   * become visible again even if no one is polling. Items themselves
   * are never auto-deleted; that's the producer's responsibility via
   * /work/complete.
   */
  async alarm(): Promise<void> {
    const data = await this.loadState();
    const now = Date.now();
    const before = Object.keys(data.leases).length;
    for (const key of Object.keys(data.leases)) {
      if (data.leases[key].expires_at_ms <= now) {
        delete data.leases[key];
      }
    }
    const purged = before - Object.keys(data.leases).length;
    if (purged > 0) {
      await this.persistState(data);
    }
    if (
      Object.keys(data.leases).length > 0 ||
      Object.keys(data.items).length > 0
    ) {
      await this.scheduleAlarm();
    } else {
      this.alarmScheduled = false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private async handleEnqueue(request: Request): Promise<Response> {
    let body: WorkEnqueueRequest;
    try {
      body = (await request.json()) as WorkEnqueueRequest;
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }
    if (
      body === null ||
      typeof body !== "object" ||
      !Array.isArray(body.items)
    ) {
      return jsonResponse({ error: "items array required" }, 400);
    }
    if (body.items.length > ENQUEUE_MAX_ITEMS_PER_CALL) {
      return jsonResponse(
        { error: `items exceeds cap of ${ENQUEUE_MAX_ITEMS_PER_CALL}` },
        400,
      );
    }

    const data = await this.loadState();
    const now = Date.now();
    const enqueued: string[] = [];
    const duplicates: string[] = [];
    const replaceExisting = body.replace_existing === true;

    for (const entry of body.items) {
      if (entry === null || typeof entry !== "object") {
        return jsonResponse({ error: "each item must be an object" }, 400);
      }
      const rawKey = typeof entry.key === "string" ? entry.key.trim() : "";
      if (!rawKey || rawKey.length > KEY_MAX_LEN) {
        return jsonResponse(
          { error: `each item.key must be 1..${KEY_MAX_LEN} chars` },
          400,
        );
      }
      const existing = data.items[rawKey];
      if (existing !== undefined) {
        duplicates.push(rawKey);
        if (replaceExisting) {
          data.items[rawKey] = {
            key: rawKey,
            payload: entry.payload,
            // Replace preserves enqueued_at so age-based monitoring is
            // unaffected by operator retries, and preserves the
            // attempt counter so poison-pill detection still works.
            enqueued_at_ms: existing.enqueued_at_ms,
            attempt_count: existing.attempt_count,
          };
        }
        continue;
      }
      data.items[rawKey] = {
        key: rawKey,
        payload: entry.payload,
        enqueued_at_ms: now,
        attempt_count: 0,
      };
      enqueued.push(rawKey);
    }

    if (enqueued.length > 0 || (replaceExisting && duplicates.length > 0)) {
      await this.persistState(data);
      await this.scheduleAlarm();
    }

    const response: WorkEnqueueResponse = {
      enqueued,
      duplicates,
      queue_size: Object.keys(data.items).length,
      server_time: now,
    };
    return jsonResponse(response);
  }

  private async handlePull(request: Request): Promise<Response> {
    let body: WorkPullRequest;
    try {
      body = (await request.json()) as WorkPullRequest;
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }
    if (
      body === null ||
      typeof body !== "object" ||
      typeof body.holder_id !== "string" ||
      !body.holder_id.trim()
    ) {
      return jsonResponse({ error: "holder_id required" }, 400);
    }
    const holderId = body.holder_id.trim();
    const maxRaw = Number(body.max_items);
    const maxItems = Math.min(
      PULL_MAX_ITEMS_PER_CALL,
      Number.isFinite(maxRaw) && maxRaw > 0 ? Math.floor(maxRaw) : PULL_DEFAULT_MAX_ITEMS,
    );
    const visRaw = Number(body.visibility_timeout_ms);
    const visibility = Number.isFinite(visRaw) && visRaw > 0
      ? Math.min(
          PULL_MAX_VISIBILITY_TIMEOUT_MS,
          Math.max(PULL_MIN_VISIBILITY_TIMEOUT_MS, visRaw),
        )
      : PULL_DEFAULT_VISIBILITY_TIMEOUT_MS;

    const data = await this.loadState();
    const now = Date.now();

    // Inline GC of expired leases so the pull always sees a fresh view.
    for (const key of Object.keys(data.leases)) {
      if (data.leases[key].expires_at_ms <= now) {
        delete data.leases[key];
      }
    }

    // Visible = items whose key is NOT in a live lease. Sort by
    // enqueued_at_ms so FIFO holds across retries / GC.
    const visibleKeys: string[] = [];
    for (const key of Object.keys(data.items)) {
      if (data.leases[key] === undefined) visibleKeys.push(key);
    }
    visibleKeys.sort(
      (a, b) => data.items[a].enqueued_at_ms - data.items[b].enqueued_at_ms,
    );

    const claimedKeys = visibleKeys.slice(0, maxItems);
    const result: WorkItem[] = [];
    for (const key of claimedKeys) {
      const item = data.items[key];
      item.attempt_count = (item.attempt_count ?? 0) + 1;
      data.items[key] = item;
      data.leases[key] = {
        key,
        holder_id: holderId,
        expires_at_ms: now + visibility,
      };
      result.push({ ...item });
    }

    if (result.length > 0) {
      await this.persistState(data);
      await this.scheduleAlarm();
    }

    const response: WorkPullResponse = {
      items: result,
      queue_size: Object.keys(data.items).length,
      server_time: now,
    };
    return jsonResponse(response);
  }

  private async handleComplete(request: Request): Promise<Response> {
    let body: WorkCompleteRequest;
    try {
      body = (await request.json()) as WorkCompleteRequest;
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }
    if (
      body === null ||
      typeof body !== "object" ||
      typeof body.holder_id !== "string" ||
      !body.holder_id.trim() ||
      !Array.isArray(body.keys)
    ) {
      return jsonResponse(
        { error: "holder_id + keys[] required" },
        400,
      );
    }
    const holderId = body.holder_id.trim();
    const data = await this.loadState();
    const now = Date.now();
    const completed: string[] = [];
    const skipped: string[] = [];

    for (const rawKey of body.keys) {
      const key = typeof rawKey === "string" ? rawKey.trim() : "";
      if (!key) {
        skipped.push(typeof rawKey === "string" ? rawKey : "");
        continue;
      }
      const lease = data.leases[key];
      // Non-owner skip: if no lease exists OR the lease holder differs,
      // someone else might already be working on a refreshed pull. Don't
      // remove the item under their feet — let them complete / release
      // it through their own holder_id.
      if (lease === undefined || lease.holder_id !== holderId) {
        skipped.push(key);
        continue;
      }
      delete data.leases[key];
      delete data.items[key];
      completed.push(key);
    }

    if (completed.length > 0) {
      await this.persistState(data);
    }

    const response: WorkCompleteResponse = {
      completed,
      skipped,
      server_time: now,
    };
    return jsonResponse(response);
  }

  private async handleRelease(request: Request): Promise<Response> {
    let body: WorkReleaseRequest;
    try {
      body = (await request.json()) as WorkReleaseRequest;
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }
    if (
      body === null ||
      typeof body !== "object" ||
      typeof body.holder_id !== "string" ||
      !body.holder_id.trim() ||
      !Array.isArray(body.keys)
    ) {
      return jsonResponse(
        { error: "holder_id + keys[] required" },
        400,
      );
    }
    const holderId = body.holder_id.trim();
    const data = await this.loadState();
    const now = Date.now();
    const released: string[] = [];
    const skipped: string[] = [];

    for (const rawKey of body.keys) {
      const key = typeof rawKey === "string" ? rawKey.trim() : "";
      if (!key) {
        skipped.push(typeof rawKey === "string" ? rawKey : "");
        continue;
      }
      const lease = data.leases[key];
      if (lease === undefined || lease.holder_id !== holderId) {
        skipped.push(key);
        continue;
      }
      delete data.leases[key];
      released.push(key);
    }

    if (released.length > 0) {
      await this.persistState(data);
    }

    const response: WorkReleaseResponse = {
      released,
      skipped,
      server_time: now,
    };
    return jsonResponse(response);
  }

  private async handleStats(): Promise<Response> {
    const data = await this.loadState();
    const now = Date.now();
    // Filter expired leases inline so stats reflect the visible pool
    // operators actually see, not what storage happens to hold.
    let leased = 0;
    for (const lease of Object.values(data.leases)) {
      if (lease.expires_at_ms > now) leased += 1;
    }
    const queueSize = Object.keys(data.items).length;
    const visible = queueSize - leased;
    let oldest: number | null = null;
    for (const item of Object.values(data.items)) {
      if (oldest === null || item.enqueued_at_ms < oldest) {
        oldest = item.enqueued_at_ms;
      }
    }
    const response: WorkStatsResponse = {
      queue_size: queueSize,
      visible,
      leased,
      oldest_enqueued_at_ms: oldest,
      server_time: now,
    };
    return jsonResponse(response);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Storage helpers
  // ─────────────────────────────────────────────────────────────────────────

  private async loadState(): Promise<WorkData> {
    if (this.cached !== null) return this.cached;
    const stored = (await this.state.storage.get<WorkData>(STORAGE_KEY)) ?? null;
    this.cached = stored ?? { items: {}, leases: {} };
    return this.cached;
  }

  private async persistState(data: WorkData): Promise<void> {
    await this.state.storage.put(STORAGE_KEY, data);
    this.cached = data;
  }

  private async scheduleAlarm(): Promise<void> {
    if (this.alarmScheduled) return;
    const existing = await this.state.storage.getAlarm();
    const now = Date.now();
    if (existing !== null && existing > now) {
      this.alarmScheduled = true;
      return;
    }
    await this.state.storage.setAlarm(now + ALARM_INTERVAL_MS);
    this.alarmScheduled = true;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
