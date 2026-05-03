import {
  ActiveRunnersResponse,
  DEFAULT_RUNNER_STALE_TTL_MS,
  Env,
  HeartbeatRequest,
  HeartbeatResponse,
  RUNNER_FIELD_MAX_LEN,
  RUNNER_REGISTRY_ALARM_INTERVAL_MS,
  RegisterRunnerRequest,
  RegisterRunnerResponse,
  RunnerInfo,
  UnregisterRunnerRequest,
  UnregisterRunnerResponse,
} from "./types";

/**
 * RunnerRegistry — singleton DO that tracks live spider runners across
 * GH Actions workflow runs (P2-E).
 *
 * Addressed by ``idFromName("runners")`` from {@link forwardToRunnerRegistryDo}
 * in {@link ./index.ts}; a single instance holds the registry for the entire
 * deployment.  Subsumes the original P3-B "configuration drift detection"
 * item by piggy-backing a ``proxy_pool_hash`` on every register payload and
 * surfacing a hash-distribution summary on every response.
 *
 * Storage layout (single-key snapshot, mirrors `MovieClaimState`):
 *
 *   - `runners[holder_id]` → ``RunnerInfo`` for each live runner.
 *   - The DO's in-memory ``cached`` is refreshed on every write so peer
 *     calls within the same DO instance observe consistent reads.
 *
 * GC: a DO Alarm fires every {@link RUNNER_REGISTRY_ALARM_INTERVAL_MS}
 * (5 min) and prunes runners whose ``last_heartbeat`` is older than
 * the stale TTL ({@link DEFAULT_RUNNER_STALE_TTL_MS} = 10 min, configurable
 * via ``env.RUNNER_STALE_TTL_MS``).  This is essential because crashed
 * runners can't run their atexit handler — without alarm GC, a hung
 * runner would haunt the registry forever and skew drift detection.
 *
 * Fail-open semantics on the *Worker* side: missing/optional fields are
 * coerced to safe defaults (empty strings, null page_range, hash="");
 * the DO never rejects a syntactically valid request, so a misbehaving
 * client can't break the registry for everyone.  Auth is enforced one
 * layer up in `src/index.ts`.
 */

interface RegistryData {
  /**
   * Live runner records keyed by ``holder_id``.  Pruned by the GC alarm
   * (and read-time defensive prune in `pruneStale`).  We deliberately do
   * NOT keep a tombstone array of unregistered holders — registry intent
   * is "who is alive RIGHT NOW", not "who was ever alive".
   */
  runners: Record<string, RunnerInfo>;
}

const STORAGE_KEY = "state";

export class RunnerRegistry implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  /** In-memory snapshot mirror; all write paths refresh this before
   *  returning so concurrent reads on the same DO instance see latest. */
  private cached: RegistryData | null = null;
  /** Tracks whether the GC alarm is already armed, to avoid setAlarm
   *  thrash on every register/heartbeat call. */
  private alarmScheduled: boolean = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/do/register":
          return await this.handleRegister(request);
        case "/do/heartbeat":
          return await this.handleHeartbeat(request);
        case "/do/unregister":
          return await this.handleUnregister(request);
        case "/do/active_runners":
          return await this.handleActive();
        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse({ error: message }, 500);
    }
  }

  /**
   * DO Alarm handler — fires every {@link RUNNER_REGISTRY_ALARM_INTERVAL_MS}
   * (5 min) and removes runners whose last heartbeat is older than the
   * stale TTL.  Only re-arms the alarm when the registry still has
   * non-empty content; an idle registry stops costing alarm invocations
   * until the next register/heartbeat arrives.
   */
  async alarm(): Promise<void> {
    const data = await this.loadState();
    const stale = loadStaleTtlMs(this.env);
    const now = Date.now();
    let purged = 0;
    for (const holder of Object.keys(data.runners)) {
      if (data.runners[holder].last_heartbeat <= now - stale) {
        delete data.runners[holder];
        purged += 1;
      }
    }
    if (purged > 0) {
      await this.persistState(data);
    }
    if (Object.keys(data.runners).length > 0) {
      await this.scheduleAlarm();
    } else {
      this.alarmScheduled = false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Endpoint handlers
  // ─────────────────────────────────────────────────────────────────────────

  private async handleRegister(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<RegisterRunnerRequest>;
    const holderId = clipString(body.holder_id ?? "");
    if (!holderId) {
      return jsonResponse({ error: "missing holder_id" }, 400);
    }

    const now = Date.now();
    const data = await this.loadState();
    pruneStale(data, this.env, now);

    const existing = data.runners[holderId];
    const wasFresh = existing === undefined;

    // Re-registers preserve ``started_at`` from the original entry —
    // ``started_at`` is intended to be wall-clock "first joined the
    // registry", not "most recent register call".  Heartbeat should be
    // used for liveness updates; we still refresh it here so a client
    // that periodically re-registers (defensive, e.g. after a network
    // partition) doesn't get GC'd.
    const startedAt = wasFresh
      ? clampPositive(body.started_at ?? now, now)
      : existing.started_at;

    const info: RunnerInfo = {
      holder_id: holderId,
      workflow_run_id: clipString(body.workflow_run_id ?? ""),
      workflow_name: clipString(body.workflow_name ?? ""),
      started_at: startedAt,
      last_heartbeat: now,
      proxy_pool_hash: clipString(body.proxy_pool_hash ?? ""),
      page_range:
        body.page_range === null || body.page_range === undefined
          ? null
          : clipString(String(body.page_range)),
    };
    data.runners[holderId] = info;
    await this.persistState(data);
    await this.scheduleAlarm();

    const summary = summarizePoolHashes(data.runners);
    const response: RegisterRunnerResponse = {
      registered: wasFresh,
      active_runners: snapshotRunners(data.runners),
      pool_hash_summary: summary,
      server_time: now,
    };
    return jsonResponse(response);
  }

  private async handleHeartbeat(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<HeartbeatRequest>;
    const holderId = clipString(body.holder_id ?? "");
    if (!holderId) {
      return jsonResponse({ error: "missing holder_id" }, 400);
    }

    const now = Date.now();
    const data = await this.loadState();
    pruneStale(data, this.env, now);
    const existing = data.runners[holderId];
    if (existing === undefined) {
      const response: HeartbeatResponse = { alive: false, server_time: now };
      return jsonResponse(response);
    }
    existing.last_heartbeat = now;
    await this.persistState(data);
    // Only re-arm if the alarm was previously dropped (idle registry); the
    // happy path is "alarm already scheduled" so this is a no-op cheap.
    await this.scheduleAlarm();

    const response: HeartbeatResponse = { alive: true, server_time: now };
    return jsonResponse(response);
  }

  private async handleUnregister(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<UnregisterRunnerRequest>;
    const holderId = clipString(body.holder_id ?? "");
    if (!holderId) {
      return jsonResponse({ error: "missing holder_id" }, 400);
    }

    const now = Date.now();
    const data = await this.loadState();
    pruneStale(data, this.env, now);
    const existed = data.runners[holderId] !== undefined;
    if (existed) {
      delete data.runners[holderId];
      await this.persistState(data);
    }
    const response: UnregisterRunnerResponse = {
      unregistered: existed,
      server_time: now,
    };
    return jsonResponse(response);
  }

  private async handleActive(): Promise<Response> {
    const now = Date.now();
    const data = await this.loadState();
    pruneStale(data, this.env, now);
    // Only persist if the prune actually evicted anyone, to avoid
    // touching SQLite on every read.
    const response: ActiveRunnersResponse = {
      active_runners: snapshotRunners(data.runners),
      pool_hash_summary: summarizePoolHashes(data.runners),
      server_time: now,
    };
    return jsonResponse(response);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Storage helpers
  // ─────────────────────────────────────────────────────────────────────────

  private async loadState(): Promise<RegistryData> {
    if (this.cached !== null) return this.cached;
    const stored = (await this.state.storage.get<RegistryData>(STORAGE_KEY)) ?? null;
    this.cached = stored ?? { runners: {} };
    return this.cached;
  }

  private async persistState(data: RegistryData): Promise<void> {
    this.cached = data;
    await this.state.storage.put(STORAGE_KEY, data);
  }

  /** Idempotent helper to arm the GC alarm (mirrors `MovieClaimState`). */
  private async scheduleAlarm(): Promise<void> {
    if (this.alarmScheduled) return;
    const existing = await this.state.storage.getAlarm();
    const now = Date.now();
    if (existing !== null && existing > now) {
      this.alarmScheduled = true;
      return;
    }
    await this.state.storage.setAlarm(now + RUNNER_REGISTRY_ALARM_INTERVAL_MS);
    this.alarmScheduled = true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (module-private)
// ─────────────────────────────────────────────────────────────────────────────

/** Read the configured stale TTL from env, with a defensive floor at 60 s
 *  so a typo in the env var doesn't immediately evict every runner. */
function loadStaleTtlMs(env: Env): number {
  const raw = env.RUNNER_STALE_TTL_MS;
  if (raw === undefined || raw === "") return DEFAULT_RUNNER_STALE_TTL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 60_000) return DEFAULT_RUNNER_STALE_TTL_MS;
  return Math.floor(n);
}

/** Defensive read-time prune.  Keeps the response payload compact even
 *  between alarm fires (worst-case 5 min stale window).  Mutates *data*
 *  in place so callers can persist the cleaned snapshot if needed. */
function pruneStale(data: RegistryData, env: Env, now: number): void {
  const stale = loadStaleTtlMs(env);
  for (const holder of Object.keys(data.runners)) {
    if (data.runners[holder].last_heartbeat <= now - stale) {
      delete data.runners[holder];
    }
  }
}

/** Stable-ordered snapshot suitable for JSON serialisation.  Sort by
 *  ``started_at`` so polling clients see a deterministic order without
 *  having to sort client-side. */
function snapshotRunners(runners: Record<string, RunnerInfo>): RunnerInfo[] {
  return Object.values(runners).sort((a, b) => a.started_at - b.started_at);
}

/** Group registered runners by ``proxy_pool_hash`` and return the
 *  occurrence counts.  Empty hashes are bucketed together so the client
 *  can warn separately about runners that didn't ship a hash at all. */
function summarizePoolHashes(
  runners: Record<string, RunnerInfo>,
): Array<{ hash: string; count: number }> {
  const counts: Map<string, number> = new Map();
  for (const info of Object.values(runners)) {
    const key = info.proxy_pool_hash;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([hash, count]) => ({ hash, count }))
    .sort((a, b) => (b.count - a.count) || a.hash.localeCompare(b.hash));
}

/** Trim free-form caller-provided strings to a safe upper bound.  Excess
 *  bytes are dropped silently; the registry is best-effort metadata, not
 *  a contract. */
function clipString(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (trimmed.length <= RUNNER_FIELD_MAX_LEN) return trimmed;
  return trimmed.slice(0, RUNNER_FIELD_MAX_LEN);
}

/** Coerce caller-supplied ``started_at`` (which may be 0 / future / NaN
 *  / etc.) into a sensible value.  Falls back to *now* when invalid; clamps
 *  far-future values to *now* to avoid storing nonsense ages. */
function clampPositive(raw: unknown, now: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > now + 60_000) return now;
  return Math.floor(n);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
