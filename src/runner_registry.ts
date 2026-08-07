import {
  ActiveRunnersResponse,
  AlertEvent,
  AlertRow,
  ALERT_HISTORY_RETENTION_MS,
  ALERT_SUMMARY_MAX_LEN,
  DEFAULT_MOVIE_CLAIM_MIN_RUNNERS,
  DEFAULT_RUNNER_STALE_TTL_MS,
  DEFAULT_SITE_CHALLENGE_MIN_FRACTION,
  DEFAULT_SITE_CHALLENGE_MIN_PROXIES_FLOOR,
  DEFAULT_SITE_CHALLENGE_TTL_MS,
  DEFAULT_SITE_CHALLENGE_WINDOW_SEC,
  Env,
  HeartbeatRequest,
  HeartbeatResponse,
  PostSignalRequest,
  RUNNER_FIELD_MAX_LEN,
  RUNNER_REGISTRY_ALARM_INTERVAL_MS,
  RegisterRunnerRequest,
  RegisterRunnerResponse,
  RunnerInfo,
  SESSION_FAILURE_REASON_MAX_LEN,
  SESSION_RETENTION_MS,
  SessionInfo,
  SessionRecord,
  SessionStatus,
  SessionWriteMode,
  SessionsResponse,
  Signal,
  SignalsResponse,
  SiteChallengeStatus,
  UnregisterRunnerRequest,
  UnregisterRunnerResponse,
} from "./types";
import { pruneLogTable } from "./event_log_helpers";
import { dispatchAlert, recordAlert } from "./alert_dispatcher";

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
  /**
   * W5.4 — operator-pushed signals (throttle_global, ban_proxy, pause_all,
   * resume). Idempotent on ``id``. The same GC alarm that prunes stale
   * runners also expires signals whose ``expires_at_ms`` is in the past;
   * the read path defensively filters expired entries too.
   *
   * Optional in storage so a registry upgraded from a pre-W5.4 deploy
   * doesn't crash on first load — treat missing as an empty list.
   */
  signals?: Signal[];
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
  /** SQL cursor for the proxies_seen table (Phase 2 / ADR-004). */
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    // Phase 2 / ADR-004 — proxies_seen: Worker-side proxy name register
    // populated from runner register payloads. Dashboard reads this to
    // enumerate all configured proxies (active + idle).
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS proxies_seen (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        first_seen_ms INTEGER NOT NULL,
        last_seen_ms INTEGER NOT NULL
      );
    `);

    // Phase 2 / ADR-002 — signals_event_log: lifecycle events for operator signals
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS signals_event_log (
        ts INTEGER NOT NULL,
        event_kind TEXT NOT NULL,
        signal_id TEXT NOT NULL,
        signal_kind TEXT NOT NULL,
        payload_json TEXT,
        PRIMARY KEY (ts, signal_id)
      );
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_signals_event_log_kind
       ON signals_event_log(signal_kind, ts);`,
    );

    // Phase 2 / ADR-002 — runners_event_log: lifecycle events for runner registration
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS runners_event_log (
        ts INTEGER NOT NULL,
        event_kind TEXT NOT NULL,
        holder_id TEXT NOT NULL,
        workflow_run_id TEXT,
        workflow_name TEXT,
        proxy_pool_hash TEXT,
        final_status TEXT,
        PRIMARY KEY (ts, holder_id, event_kind)
      );
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_runners_event_log_holder
       ON runners_event_log(holder_id, ts);`,
    );

    // Phase-1 ADR-008 — sessions: runner-reported session lifecycle. Keyed
    // by session_id (TEXT, application-generated) and pruned by the same
    // alarm that GCs runners. Single row per session — heartbeats update
    // status / write_mode / failure_reason in place rather than appending.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        holder_id TEXT NOT NULL,
        workflow_run_id TEXT NOT NULL DEFAULT '',
        workflow_name TEXT NOT NULL DEFAULT '',
        report_type TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        write_mode TEXT NOT NULL DEFAULT 'unknown',
        failure_reason TEXT NOT NULL DEFAULT '',
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_sessions_status_started
       ON sessions(status, started_at);`,
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_sessions_holder
       ON sessions(holder_id);`,
    );

    // Phase-1 ADR-008 — alert_history: every alert AlertDispatcher emits
    // is recorded here (independent of webhook delivery success). Cron
    // sweep prunes rows older than ALERT_HISTORY_RETENTION_MS.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS alert_history (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        severity TEXT NOT NULL,
        summary TEXT NOT NULL,
        details_json TEXT,
        ack INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_alert_history_ts
       ON alert_history(ts);`,
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_alert_history_kind_ts
       ON alert_history(kind, ts);`,
    );

    // ADR-043 D7 — site_challenge_events: one row per proxy holding its most
    // recent `site_challenge` observation. Keying on proxy_id (rather than
    // appending a log) makes "distinct proxies within the window" a single
    // COUNT and bounds the table by pool size instead of report volume.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS site_challenge_events (
        proxy_id TEXT PRIMARY KEY,
        last_ts INTEGER NOT NULL
      );
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_site_challenge_events_ts
       ON site_challenge_events(last_ts);`,
    );
    // ADR-043 D7 — singleton latch row (id = 1). `tripped_at` is both the
    // "are we tripped" flag (0 = clear) and the stable suffix of the alert id,
    // which is what makes the alert fire once per *trip* rather than once per
    // report.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS site_challenge_state (
        id INTEGER PRIMARY KEY,
        tripped_at INTEGER NOT NULL DEFAULT 0
      );
    `);

    // Phase 2 follow-up — unconditionally arm the alarm in the constructor
    // so retention sweeps run even when no register/signal traffic ever
    // arrives. Matches the pattern in ConfigState/GlobalLoginState/MetricsState.
    // Fire-and-forget: scheduleAlarm is idempotent and self-defending.
    this.scheduleAlarm().catch(() => {});
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
        // W5.4 — operator signal management
        case "/do/signal":
          return await this.handlePostSignal(request);
        case "/do/signals":
          return await this.handleListSignals();
        // Phase 2 / ADR-004 — proxies_seen
        case "/do/proxies_seen":
          if (request.method === "GET") {
            return this.handleListProxiesSeen();
          }
          if (request.method === "DELETE") {
            return this.handleDeleteProxySeen(url);
          }
          return new Response("Method Not Allowed", { status: 405 });
        // Phase 2 / ADR-002 — event log read endpoints
        case "/do/signals/history":
          if (request.method === "GET") {
            return this.handleSignalsHistory(url);
          }
          return new Response("Method Not Allowed", { status: 405 });
        case "/do/runners/history":
          if (request.method === "GET") {
            return this.handleRunnersHistory(url);
          }
          return new Response("Method Not Allowed", { status: 405 });
        // Phase-1 ADR-008 — sessions + alerts.
        case "/do/sessions":
          if (request.method === "GET") {
            return this.handleListSessions(url);
          }
          return new Response("Method Not Allowed", { status: 405 });
        case "/do/alerts":
          if (request.method === "GET") {
            return this.handleListAlerts(url);
          }
          if (request.method === "POST") {
            return await this.handleRecordAlert(request);
          }
          return new Response("Method Not Allowed", { status: 405 });
        case "/do/alerts/ack":
          if (request.method === "POST") {
            return await this.handleAckAlert(request);
          }
          return new Response("Method Not Allowed", { status: 405 });
        // ADR-043 D7 — global site-challenge breaker. POST records one
        // observation for `proxy_id` and re-evaluates; GET evaluates without
        // observing (used by the CF report path and by /ops/snapshot).
        case "/do/site_challenge":
          if (request.method === "POST") {
            return await this.handleSiteChallengeReport(request);
          }
          if (request.method === "GET") {
            return jsonResponse(await this.evaluateSiteChallenge(Date.now()));
          }
          return new Response("Method Not Allowed", { status: 405 });
        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("RunnerRegistry DO handler error", {
        path: url.pathname,
        error: message,
      });
      return jsonResponse({ error: "internal_error" }, 500);
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
        const info = data.runners[holder];
        // Phase 2 / ADR-002 — runners_event_log crashed event
        this.sql.exec(
          `INSERT OR IGNORE INTO runners_event_log
           (ts, event_kind, holder_id, workflow_run_id, workflow_name, final_status)
           VALUES (?, 'crashed', ?, ?, ?, 'crashed')`,
          now,
          info.holder_id,
          info.workflow_run_id,
          info.workflow_name,
        );
        delete data.runners[holder];
        purged += 1;
      }
    }
    // W5.4 — also prune expired operator signals on every alarm tick so
    // long-lived deployments don't accumulate stale signals.
    const sigBefore = (data.signals ?? []).length;
    // Phase 2 / ADR-002 — log auto_expire events before pruning
    this.pruneExpiredSignalsWithLog(data, now);
    const sigPurged = sigBefore - (data.signals ?? []).length;
    if (purged > 0 || sigPurged > 0) {
      await this.persistState(data);
    }
    // Phase 2 / ADR-002 — retention sweep on history tables.
    const now2 = Date.now();
    const signalsRetentionMs = parseInt(this.env.SIGNALS_EVENT_LOG_RETENTION_DAYS ?? "90", 10) * 86_400_000;
    const runnersRetentionMs = parseInt(this.env.RUNNERS_EVENT_LOG_RETENTION_DAYS ?? "90", 10) * 86_400_000;
    pruneLogTable(this.sql, "signals_event_log", signalsRetentionMs, 100_000, now2);
    pruneLogTable(this.sql, "runners_event_log", runnersRetentionMs, 100_000, now2);

    // Phase-1 ADR-008 — prune ended sessions past retention horizon
    // (in-progress sessions are kept indefinitely; runner crash/eviction
    // converts them via the runners_event_log "crashed" path).
    const sessionCutoff = now2 - SESSION_RETENTION_MS;
    this.sql.exec(
      `DELETE FROM sessions WHERE ended_at > 0 AND ended_at <= ?`,
      sessionCutoff,
    );
    // Phase-1 ADR-008 — prune alert_history past retention horizon.
    const alertCutoff = now2 - ALERT_HISTORY_RETENTION_MS;
    this.sql.exec(`DELETE FROM alert_history WHERE ts <= ?`, alertCutoff);
    // ADR-043 D7 — drop observations too old to affect either the rolling
    // window or the post-observation TTL, then re-evaluate so a breaker whose
    // wall lifted clears (and emits its recovery alert) even if no report
    // ever arrives again.
    const scHorizon =
      loadSiteChallengeWindowSec(this.env) * 1000 +
      loadSiteChallengeTtlMs(this.env);
    this.sql.exec(
      `DELETE FROM site_challenge_events WHERE last_ts <= ?`,
      now2 - scHorizon,
    );
    const siteChallenge = await this.evaluateSiteChallenge(now2);
    // Re-arm when runners, signals OR a tripped breaker remain — all three
    // are time-bounded state worth GC'ing.
    if (
      Object.keys(data.runners).length > 0 ||
      (data.signals ?? []).length > 0 ||
      siteChallenge.tripped
    ) {
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
    // Order matters: write *this* runner first, then read the full set,
    // then derive `movie_claim_recommended`.  DO calls are serialized
    // per-instance, so the second of two concurrent registers always
    // observes its peer's record and produces `recommended=true` — the
    // exact property the Python client's `auto` mode relies on to avoid
    // a race where both runners think they are alone.
    data.runners[holderId] = info;

    // Phase 2 / ADR-004 — populate proxies_seen from upload
    const pool = (body as any).proxy_pool;
    if (Array.isArray(pool)) {
      for (const entry of pool) {
        if (
          entry &&
          typeof entry.id === "string" &&
          typeof entry.name === "string" &&
          entry.id.length > 0 &&
          entry.name.length > 0
        ) {
          this.sql.exec(
            `INSERT INTO proxies_seen (id, name, first_seen_ms, last_seen_ms)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               last_seen_ms = excluded.last_seen_ms`,
            entry.id.slice(0, 256),
            entry.name.slice(0, 256),
            now,
            now,
          );
        }
      }
    }

    // Phase 2 / ADR-002 — runners_event_log register event
    this.sql.exec(
      `INSERT OR IGNORE INTO runners_event_log
       (ts, event_kind, holder_id, workflow_run_id, workflow_name, proxy_pool_hash)
       VALUES (?, 'register', ?, ?, ?, ?)`,
      now,
      holderId,
      info.workflow_run_id,
      info.workflow_name,
      info.proxy_pool_hash,
    );

    await this.persistState(data);
    await this.scheduleAlarm();

    // Phase-1 ADR-008 — apply session payload after the runner write so
    // the upsert can reference the canonical holder metadata.
    const sessionApply =
      body.session !== undefined ? parseSessionInfo(body.session) : null;
    if (sessionApply !== null) {
      const applied = applySessionUpsert(this.sql, info, sessionApply, now);
      await this.maybeEmitSessionFailedAlert(applied);
    }

    const activeRunners = snapshotRunners(data.runners);
    const summary = summarizePoolHashes(data.runners);
    const minRunners = loadMovieClaimMinRunners(this.env);
    pruneExpiredSignals(data, now);
    const response: RegisterRunnerResponse = {
      registered: wasFresh,
      active_runners: activeRunners,
      pool_hash_summary: summary,
      movie_claim_recommended: activeRunners.length >= minRunners,
      movie_claim_min_runners: minRunners,
      active_signals: data.signals ?? [],
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
    const minRunners = loadMovieClaimMinRunners(this.env);
    const existing = data.runners[holderId];
    // Phase-1 ADR-008 — heartbeat session updates are accepted even for an
    // evicted holder so a slow runner can still flag a `failed` status on
    // the way out. The DB row carries holder metadata regardless of live
    // registry presence.
    const sessionFromBody =
      body.session !== undefined ? parseSessionInfo(body.session) : null;
    if (sessionFromBody !== null) {
      const applied = applySessionUpsert(
        this.sql,
        existing ?? holderInfoFromRequest(holderId, {}),
        sessionFromBody,
        now,
      );
      await this.maybeEmitSessionFailedAlert(applied);
    }
    if (existing === undefined) {
      // Evicted holder: surface the live cohort size sans the unknown
      // caller so the client still gets a defensible recommendation
      // (the heartbeat loop re-registers right after this response and
      // will reconcile on the register response).
      const recommended =
        Object.keys(data.runners).length >= minRunners;
      pruneExpiredSignals(data, now);
      const response: HeartbeatResponse = {
        alive: false,
        movie_claim_recommended: recommended,
        movie_claim_min_runners: minRunners,
        active_runners_count: Object.keys(data.runners).length,
        active_signals: data.signals ?? [],
        server_time: now,
      };
      return jsonResponse(response);
    }
    existing.last_heartbeat = now;
    await this.persistState(data);
    // Only re-arm if the alarm was previously dropped (idle registry); the
    // happy path is "alarm already scheduled" so this is a no-op cheap.
    await this.scheduleAlarm();

    // Same write-then-derive ordering as `handleRegister`: the heartbeat
    // refresh is already persisted, so reading `data.runners` here yields
    // the up-to-date cohort.  This is the signal the Python heartbeat
    // loop feeds into `_apply_movie_claim_recommendation` on every tick.
    const activeRunners = snapshotRunners(data.runners);
    const recommended = activeRunners.length >= minRunners;
    pruneExpiredSignals(data, now);
    const response: HeartbeatResponse = {
      alive: true,
      movie_claim_recommended: recommended,
      movie_claim_min_runners: minRunners,
      active_runners_count: activeRunners.length,
      active_signals: data.signals ?? [],
      server_time: now,
    };
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
    const holderRecord = data.runners[holderId];
    if (existed) {
      // Phase 2 / ADR-002 — runners_event_log unregister event
      this.sql.exec(
        `INSERT OR IGNORE INTO runners_event_log
         (ts, event_kind, holder_id, workflow_run_id, workflow_name, final_status)
         VALUES (?, 'unregister', ?, ?, ?, 'completed')`,
        now,
        holderId,
        holderRecord.workflow_run_id ?? "",
        holderRecord.workflow_name ?? "",
      );
      delete data.runners[holderId];
      await this.persistState(data);
    }
    // Phase-1 ADR-008 — record terminal session state even when the
    // runner was already evicted (slow shutdowns sometimes lose the live
    // record before atexit fires).
    const session =
      body.session !== undefined ? parseSessionInfo(body.session) : null;
    if (session !== null) {
      const applied = applySessionUpsert(
        this.sql,
        holderRecord ?? holderInfoFromRequest(holderId, {}),
        session,
        now,
      );
      await this.maybeEmitSessionFailedAlert(applied);
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
    const countBefore = Object.keys(data.runners).length;
    pruneStale(data, this.env, now);
    if (Object.keys(data.runners).length < countBefore) {
      await this.persistState(data);
    }
    const response: ActiveRunnersResponse = {
      active_runners: snapshotRunners(data.runners),
      pool_hash_summary: summarizePoolHashes(data.runners),
      server_time: now,
    };
    return jsonResponse(response);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // W5.4 — operator signal management
  // ─────────────────────────────────────────────────────────────────────────

  private async handlePostSignal(request: Request): Promise<Response> {
    let body: PostSignalRequest;
    try {
      body = (await request.json()) as PostSignalRequest;
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }

    const validation = validatePostSignal(body);
    if (validation.error !== undefined || validation.signal === undefined) {
      return jsonResponse(
        { error: validation.error ?? "invalid_signal" },
        400,
      );
    }
    const validated: Signal = validation.signal;

    const now = Date.now();
    const data = await this.loadState();
    pruneExpiredSignals(data, now);

    if (validated.kind === "resume") {
      // ``resume`` is operator-override: drop every other active signal
      // in one go. The signal itself is not stored — its effect is the
      // clear-all. Heartbeat readers see an empty list right after.
      if (data.signals !== undefined && data.signals.length > 0) {
        // Phase 2 / ADR-002 — log explicit_revoke for each cleared signal
        for (const cleared of data.signals) {
          this.sql.exec(
            `INSERT OR IGNORE INTO signals_event_log
             (ts, event_kind, signal_id, signal_kind, payload_json)
             VALUES (?, 'explicit_revoke', ?, ?, ?)`,
            now,
            cleared.id,
            cleared.kind,
            null,
          );
        }
        data.signals = [];
        await this.persistState(data);
      }
      const response: SignalsResponse = {
        active_signals: [],
        server_time: now,
      };
      return jsonResponse(response);
    }

    // Idempotent replace on id (operator retry after a transient failure
    // must not multiply effects).
    const existing = data.signals ?? [];
    const without = existing.filter((s) => s.id !== validated.id);
    without.push(validated);
    data.signals = without;

    // Phase 2 / ADR-002 — signals_event_log create event
    this.sql.exec(
      `INSERT OR REPLACE INTO signals_event_log
       (ts, event_kind, signal_id, signal_kind, payload_json)
       VALUES (?, 'create', ?, ?, ?)`,
      now,
      validated.id,
      validated.kind,
      JSON.stringify({
        factor: validated.factor,
        proxy_id: validated.proxy_id,
        reason: validated.reason,
        expires_at_ms: validated.expires_at_ms,
      }),
    );

    await this.persistState(data);
    await this.scheduleAlarm();

    const response: SignalsResponse = {
      active_signals: data.signals,
      server_time: now,
    };
    return jsonResponse(response);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 2 / ADR-004 — proxies_seen handlers
  // ─────────────────────────────────────────────────────────────────────────

  private handleListProxiesSeen(): Response {
    const rows = Array.from(
      this.sql.exec<{
        id: string;
        name: string;
        first_seen_ms: number;
        last_seen_ms: number;
      }>(
        "SELECT id, name, first_seen_ms, last_seen_ms FROM proxies_seen ORDER BY name",
      ),
    );
    return new Response(JSON.stringify({ proxies: rows }), {
      headers: { "content-type": "application/json" },
    });
  }

  private handleDeleteProxySeen(url: URL): Response {
    const id = url.searchParams.get("id") ?? "";
    if (!id) {
      return new Response(JSON.stringify({ error: "missing id" }), { status: 400 });
    }
    this.sql.exec("DELETE FROM proxies_seen WHERE id = ?", id);
    return new Response(JSON.stringify({ deleted: true }), {
      headers: { "content-type": "application/json" },
    });
  }

  private async handleListSignals(): Promise<Response> {
    const now = Date.now();
    const data = await this.loadState();
    const before = (data.signals ?? []).length;
    // Phase 2 / ADR-002 — use logging variant so GET /signals also
    // opportunistically logs auto_expire events for signals that expired
    // between alarm fires (worst-case 5 min stale window).
    this.pruneExpiredSignalsWithLog(data, now);
    if ((data.signals ?? []).length < before) {
      await this.persistState(data);
    }
    const response: SignalsResponse = {
      active_signals: data.signals ?? [],
      server_time: now,
    };
    return jsonResponse(response);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 2 / ADR-002 — event log read handlers
  // ─────────────────────────────────────────────────────────────────────────

  private handleSignalsHistory(url: URL): Response {
    const from = parseInt(url.searchParams.get("from") ?? "0", 10);
    const to = parseInt(url.searchParams.get("to") ?? `${Date.now()}`, 10);
    const rows = Array.from(this.sql.exec<{
      ts: number;
      event_kind: string;
      signal_id: string;
      signal_kind: string;
      payload_json: string | null;
    }>(
      `SELECT ts, event_kind, signal_id, signal_kind, payload_json
       FROM signals_event_log
       WHERE ts >= ? AND ts <= ?
       ORDER BY ts DESC`,
      from,
      to,
    ));
    return new Response(JSON.stringify({ rows }), {
      headers: { "content-type": "application/json" },
    });
  }

  private handleRunnersHistory(url: URL): Response {
    const from = parseInt(url.searchParams.get("from") ?? "0", 10);
    const to = parseInt(url.searchParams.get("to") ?? `${Date.now()}`, 10);
    const holder = url.searchParams.get("holder_id");
    const baseSql =
      `SELECT ts, event_kind, holder_id, workflow_run_id, workflow_name, proxy_pool_hash, final_status
       FROM runners_event_log WHERE ts >= ? AND ts <= ?`;
    const rows = holder
      ? Array.from(
          this.sql.exec(
            baseSql + " AND holder_id = ? ORDER BY ts DESC",
            from, to, holder,
          ),
        )
      : Array.from(
          this.sql.exec(baseSql + " ORDER BY ts DESC", from, to),
        );
    return new Response(JSON.stringify({ rows }), {
      headers: { "content-type": "application/json" },
    });
  }

  /**
   * Phase 2 / ADR-002 — prune expired signals while also writing
   * ``auto_expire`` events to ``signals_event_log`` for each removed entry.
   * Called from alarm() and handleListSignals() so both the GC tick and
   * opportunistic read-path prunes produce audit trail entries.
   */
  private pruneExpiredSignalsWithLog(data: RegistryData, now: number): void {
    if (data.signals === undefined || data.signals.length === 0) return;
    const expired = data.signals.filter(
      (s) => s.expires_at_ms !== 0 && s.expires_at_ms <= now,
    );
    for (const s of expired) {
      this.sql.exec(
        `INSERT OR IGNORE INTO signals_event_log
         (ts, event_kind, signal_id, signal_kind, payload_json)
         VALUES (?, 'auto_expire', ?, ?, ?)`,
        now,
        s.id,
        s.kind,
        null,
      );
    }
    data.signals = data.signals.filter(
      (s) => s.expires_at_ms === 0 || s.expires_at_ms > now,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase-1 ADR-008 — sessions + alerts
  // ─────────────────────────────────────────────────────────────────────────

  /** Handle `GET /do/sessions?since_ms=...&limit=...`. Returns three
   *  buckets: `active`, `recent_failed`, `recent_committed`. */
  private handleListSessions(url: URL): Response {
    const now = Date.now();
    const sinceRaw = parseInt(url.searchParams.get("since_ms") ?? "", 10);
    const since = Number.isFinite(sinceRaw) && sinceRaw > 0
      ? sinceRaw
      : now - SESSION_RETENTION_MS;
    const limitRaw = parseInt(url.searchParams.get("limit") ?? "", 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, 200)
      : 50;
    const active = this.querySessions(
      `status IN ('in_progress', 'finalizing') AND updated_at >= ?`,
      [since],
      "started_at ASC",
      limit,
    );
    const recentFailed = this.querySessions(
      `status IN ('failed', 'cancelled') AND updated_at >= ?`,
      [since],
      "updated_at DESC",
      limit,
    );
    const recentCommitted = this.querySessions(
      `status = 'committed' AND updated_at >= ?`,
      [since],
      "updated_at DESC",
      limit,
    );
    const response: SessionsResponse = {
      active: active.map(serializeSessionRow),
      recent_failed: recentFailed.map(serializeSessionRow),
      recent_committed: recentCommitted.map(serializeSessionRow),
      server_time: now,
    };
    return jsonResponse(response);
  }

  private querySessions(
    where: string,
    args: Array<string | number>,
    orderBy: string,
    limit: number,
  ): SessionRecord[] {
    const sql =
      `SELECT session_id, holder_id, workflow_run_id, workflow_name,
              report_type, status, write_mode, failure_reason,
              started_at, updated_at, ended_at
         FROM sessions
        WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT ?`;
    return Array.from(
      this.sql.exec<{
        session_id: string;
        holder_id: string;
        workflow_run_id: string;
        workflow_name: string;
        report_type: string;
        status: string;
        write_mode: string;
        failure_reason: string;
        started_at: number;
        updated_at: number;
        ended_at: number;
      }>(sql, ...args, limit),
    ).map((r) => ({
      session_id: r.session_id,
      holder_id: r.holder_id,
      workflow_run_id: r.workflow_run_id,
      workflow_name: r.workflow_name,
      report_type: r.report_type,
      status: r.status as SessionStatus,
      write_mode: r.write_mode as SessionWriteMode,
      failure_reason: r.failure_reason,
      started_at: r.started_at,
      updated_at: r.updated_at,
      ended_at: r.ended_at,
    }));
  }

  /** Emit a `session_failed` alert iff the apply transitioned to `failed`
   *  and we hadn't already alerted for this session. Idempotent — the
   *  alert id is derived from the session_id so re-applying a failure
   *  payload doesn't multiply alerts. */
  private async maybeEmitSessionFailedAlert(
    applied: SessionApplyResult,
  ): Promise<void> {
    if (applied.newStatus !== "failed") return;
    if (applied.prevStatus === "failed") return;
    const rec = applied.record;
    const alertId = `sessfail-${rec.session_id}`;
    const summary =
      `Session ${rec.session_id} failed (workflow=${rec.workflow_name || "?"}, ` +
      `write_mode=${rec.write_mode}, holder=${rec.holder_id})`;
    const alert: AlertEvent = {
      id: alertId,
      kind: "session_failed",
      ts: Date.now(),
      severity: "warning",
      summary: summary.slice(0, ALERT_SUMMARY_MAX_LEN),
      details: {
        session_id: rec.session_id,
        workflow_run_id: rec.workflow_run_id,
        workflow_name: rec.workflow_name,
        report_type: rec.report_type,
        write_mode: rec.write_mode,
        failure_reason: rec.failure_reason,
        holder_id: rec.holder_id,
      },
    };
    recordAlert(this.sql, alert);
    // Webhook dispatch is awaited so the DO request fully owns the
    // async work — prevents storage-frame leaks in vitest-pool-workers
    // and bounds the latency by AlertDispatcher's own per-webhook
    // timeouts (10s + 2 retries with back-off, parallel across
    // webhooks). At register/heartbeat cadence (60s) this is acceptable.
    try {
      await dispatchAlert(this.env, alert);
    } catch (err) {
      console.warn("session_failed alert dispatch error", {
        session_id: rec.session_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Handle `POST /do/alerts` — internal endpoint used by other DOs
   *  (e.g. ProxyCoordinator, GlobalLoginState) to record an alert in the
   *  history table without going through HTTP. Currently unused on the
   *  client side; ProxyCoordinator + GlobalLoginState write directly via
   *  the `recordAlert(sql, alert)` helper exported from alert_dispatcher. */
  private async handleRecordAlert(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<AlertEvent>;
    if (
      typeof body?.id !== "string" ||
      typeof body?.kind !== "string" ||
      typeof body?.ts !== "number" ||
      typeof body?.summary !== "string"
    ) {
      return jsonResponse({ error: "invalid_alert_payload" }, 400);
    }
    const alert: AlertEvent = {
      id: body.id,
      kind: body.kind as AlertEvent["kind"],
      ts: body.ts,
      severity: "warning",
      summary: body.summary.slice(0, ALERT_SUMMARY_MAX_LEN),
      details:
        typeof body.details === "object" && body.details !== null
          ? (body.details as Record<string, unknown>)
          : {},
    };
    recordAlert(this.sql, alert);
    try {
      await dispatchAlert(this.env, alert);
    } catch {
      /* recorded in alert_history regardless */
    }
    return jsonResponse({ recorded: true, alert_id: alert.id });
  }

  /** Handle `GET /do/alerts?since_ms=...`. Returns recent rows DESC. */
  private handleListAlerts(url: URL): Response {
    const now = Date.now();
    const sinceRaw = parseInt(url.searchParams.get("since_ms") ?? "", 10);
    const since = Number.isFinite(sinceRaw) && sinceRaw > 0
      ? sinceRaw
      : now - ALERT_HISTORY_RETENTION_MS;
    const limitRaw = parseInt(url.searchParams.get("limit") ?? "", 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, 200)
      : 50;
    const rows = Array.from(
      this.sql.exec<{
        id: string;
        ts: number;
        kind: string;
        severity: string;
        summary: string;
        details_json: string | null;
        ack: number;
      }>(
        `SELECT id, ts, kind, severity, summary, details_json, ack
           FROM alert_history
          WHERE ts >= ?
          ORDER BY ts DESC
          LIMIT ?`,
        since,
        limit,
      ),
    );
    const alerts: AlertRow[] = rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind as AlertEvent["kind"],
      severity: "warning",
      summary: r.summary,
      details: parseJsonObject(r.details_json),
      ack: r.ack,
    }));
    return jsonResponse({ alerts, server_time: now });
  }

  /** Handle `POST /do/alerts/ack` — body `{ id }` toggles ack flag. */
  private async handleAckAlert(request: Request): Promise<Response> {
    const body = (await request.json()) as { id?: unknown };
    const id = typeof body?.id === "string" ? body.id : "";
    if (!id) return jsonResponse({ error: "missing_id" }, 400);
    this.sql.exec(
      `UPDATE alert_history SET ack = 1 WHERE id = ?`,
      id,
    );
    return jsonResponse({ acked: true });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ADR-043 D7 — global site-challenge breaker
  // ─────────────────────────────────────────────────────────────────────────

  /** Handle `POST /do/site_challenge` — body `{ proxy_id }`. Records one
   *  observation for that proxy (upsert, so a proxy reporting 50 times still
   *  counts once) and returns the post-observation breaker state. */
  private async handleSiteChallengeReport(request: Request): Promise<Response> {
    const body = (await request.json()) as { proxy_id?: unknown };
    const proxyId = clipString(
      typeof body?.proxy_id === "string" ? body.proxy_id : "",
    );
    if (!proxyId) {
      return jsonResponse({ error: "missing proxy_id" }, 400);
    }
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO site_challenge_events (proxy_id, last_ts)
       VALUES (?, ?)
       ON CONFLICT(proxy_id) DO UPDATE SET last_ts = excluded.last_ts`,
      proxyId,
      now,
    );
    const status = await this.evaluateSiteChallenge(now);
    // A tripped breaker keeps the GC alarm armed so the recovery transition
    // is detected even after every runner has exited.
    if (status.tripped) await this.scheduleAlarm();
    return jsonResponse(status);
  }

  /**
   * Derive the current breaker state, applying (and persisting) any trip /
   * recovery transition and emitting exactly one alert per transition.
   *
   * Called from the report path, from `GET /do/site_challenge`
   * (`/ops/snapshot` and the per-report CF check) and from the GC alarm, so
   * recovery is observed on whichever of those ticks comes first.
   */
  private async evaluateSiteChallenge(now: number): Promise<SiteChallengeStatus> {
    const windowSec = loadSiteChallengeWindowSec(this.env);
    const ttlMs = loadSiteChallengeTtlMs(this.env);
    const rosterSize = this.countProxiesSeen();
    const threshold = resolveSiteChallengeMinProxies(this.env, rosterSize);
    const distinct = this.countDistinctSiteChallengeProxies(now - windowSec * 1000);
    const lastObservation = this.lastSiteChallengeObservation();
    const prevTrippedAt = this.readSiteChallengeTrippedAt();

    const decision = resolveSiteChallengeTrip({
      now,
      prevTrippedAt,
      lastObservationMs: lastObservation,
      distinctProxies: distinct,
      threshold,
      ttlMs,
    });

    const status: SiteChallengeStatus = {
      tripped: decision.trippedAt > 0,
      tripped_at: decision.trippedAt,
      distinct_proxies: distinct,
      threshold,
      roster_size: rosterSize,
      window_sec: windowSec,
      ttl_ms: ttlMs,
      last_observation_ms: lastObservation,
      server_time: now,
    };

    if (decision.transition !== null) {
      this.writeSiteChallengeTrippedAt(decision.trippedAt);
      await this.emitSiteChallengeAlert(
        decision.transition,
        // Both alerts key off the *trip* timestamp so the recovery pairs with
        // the trip it closes; on recovery `decision.trippedAt` is already 0.
        decision.transition === "tripped" ? decision.trippedAt : prevTrippedAt,
        status,
      );
    }
    return status;
  }

  /** Emit the one alert for a breaker transition. Deterministic ids
   *  (`sitechal-<trippedAt>` / `sitechal-clear-<trippedAt>`) make
   *  `recordAlert`'s `INSERT OR IGNORE` the de-duplicator, so a long outage
   *  produces one alert rather than one per report. */
  private async emitSiteChallengeAlert(
    transition: "tripped" | "cleared",
    trippedAt: number,
    status: SiteChallengeStatus,
  ): Promise<void> {
    const summary =
      transition === "tripped"
        ? `Site-wide challenge breaker TRIPPED: ${status.distinct_proxies} distinct ` +
          `proxies (roster ${status.roster_size}, threshold ${status.threshold}) reported a ` +
          `site challenge within ${status.window_sec}s. Per-proxy CF auto-ban is suppressed ` +
          `until ${Math.round(status.ttl_ms / 60_000)} min after the last report.`
        : `Site-wide challenge breaker CLEARED after ` +
          `${Math.max(0, Math.round((status.server_time - trippedAt) / 60_000))} min. No site ` +
          `challenge reported for ${Math.round(status.ttl_ms / 60_000)} min; per-proxy CF ` +
          `auto-ban is re-armed.`;
    const alert: AlertEvent = {
      id:
        transition === "tripped"
          ? `sitechal-${trippedAt}`
          : `sitechal-clear-${trippedAt}`,
      kind: "site_challenge",
      ts: status.server_time,
      severity: "warning",
      summary: summary.slice(0, ALERT_SUMMARY_MAX_LEN),
      details: {
        state: transition,
        tripped_at: trippedAt,
        distinct_proxies: status.distinct_proxies,
        roster_size: status.roster_size,
        threshold: status.threshold,
        window_sec: status.window_sec,
        ttl_ms: status.ttl_ms,
        last_observation_ms: status.last_observation_ms,
      },
    };
    // In-registry alert: write straight to our own `alert_history` and
    // dispatch, exactly like `maybeEmitSessionFailedAlert`. Going through
    // `recordAndDispatch` would make this DO stub-fetch *itself*.
    recordAlert(this.sql, alert);
    try {
      await dispatchAlert(this.env, alert);
    } catch (err) {
      console.warn("site_challenge alert dispatch error", {
        state: transition,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Size of the known proxy roster, used to derive the trip threshold as a
   *  fraction of the pool. `0` when no runner has uploaded a `proxy_pool`. */
  private countProxiesSeen(): number {
    const rows = Array.from(
      this.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM proxies_seen`,
      ),
    );
    return rows[0]?.count ?? 0;
  }

  private countDistinctSiteChallengeProxies(cutoff: number): number {
    const rows = Array.from(
      this.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM site_challenge_events WHERE last_ts >= ?`,
        cutoff,
      ),
    );
    return rows[0]?.count ?? 0;
  }

  private lastSiteChallengeObservation(): number {
    const rows = Array.from(
      this.sql.exec<{ last_ts: number | null }>(
        `SELECT MAX(last_ts) AS last_ts FROM site_challenge_events`,
      ),
    );
    return rows[0]?.last_ts ?? 0;
  }

  private readSiteChallengeTrippedAt(): number {
    const rows = Array.from(
      this.sql.exec<{ tripped_at: number }>(
        `SELECT tripped_at FROM site_challenge_state WHERE id = 1`,
      ),
    );
    return rows[0]?.tripped_at ?? 0;
  }

  private writeSiteChallengeTrippedAt(trippedAt: number): void {
    this.sql.exec(
      `INSERT INTO site_challenge_state (id, tripped_at) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET tripped_at = excluded.tripped_at`,
      trippedAt,
    );
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
    // Write storage first; only flip the in-memory cache after a successful
    // put. The reverse order leaks unpersisted runner records into ``cached``
    // when ``put`` throws — registry queries would then report runners that
    // a fresh DO instance after eviction could never see, throwing off the
    // movie_claim_recommended decision in the singleton ``RunnerRegistry``.
    await this.state.storage.put(STORAGE_KEY, data);
    this.cached = data;
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

/** Read the configured MovieClaim activation threshold from env, falling
 *  back to {@link DEFAULT_MOVIE_CLAIM_MIN_RUNNERS} on missing/invalid
 *  values.  Floored at 1 so a misconfigured "0" can't make the
 *  recommendation always-true (which would defeat the auto-toggle's
 *  whole purpose — single-runner deployments would still pay claim
 *  overhead for nothing). */
function loadMovieClaimMinRunners(env: Env): number {
  const raw = env.MOVIE_CLAIM_MIN_RUNNERS;
  if (raw === undefined || raw === "") return DEFAULT_MOVIE_CLAIM_MIN_RUNNERS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MOVIE_CLAIM_MIN_RUNNERS;
  return Math.floor(n);
}

// ─────────────────────────────────────────────────────────────────────────────
// ADR-043 D7 — site-challenge breaker loaders + trip decision
//
// Same loader shape as `loadCfAutoBanThreshold` in proxy_coordinator.ts:
// unset / empty / garbage all fall back to the code default rather than
// letting a typo silently disable the breaker.
// ─────────────────────────────────────────────────────────────────────────────

/** Rolling window (seconds) for counting distinct reporting proxies. */
export function loadSiteChallengeWindowSec(env: Env): number {
  const raw = env.SITE_CHALLENGE_WINDOW_SEC;
  if (raw === undefined || raw === "") return DEFAULT_SITE_CHALLENGE_WINDOW_SEC;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SITE_CHALLENGE_WINDOW_SEC;
}

/** How long the tripped state survives after the last observation (ms). */
export function loadSiteChallengeTtlMs(env: Env): number {
  const raw = env.SITE_CHALLENGE_TTL_MS;
  if (raw === undefined || raw === "") return DEFAULT_SITE_CHALLENGE_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_SITE_CHALLENGE_TTL_MS;
}

/** Fraction of the roster required to trip, clamped to (0, 1]. */
export function loadSiteChallengeMinFraction(env: Env): number {
  const raw = env.SITE_CHALLENGE_MIN_FRACTION;
  if (raw === undefined || raw === "") return DEFAULT_SITE_CHALLENGE_MIN_FRACTION;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    return DEFAULT_SITE_CHALLENGE_MIN_FRACTION;
  }
  return n;
}

/** Absolute floor for the derived threshold. */
export function loadSiteChallengeMinProxiesFloor(env: Env): number {
  const raw = env.SITE_CHALLENGE_MIN_PROXIES_FLOOR;
  if (raw === undefined || raw === "") {
    return DEFAULT_SITE_CHALLENGE_MIN_PROXIES_FLOOR;
  }
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SITE_CHALLENGE_MIN_PROXIES_FLOOR;
}

/**
 * Resolve the distinct-proxy count that trips the breaker.
 *
 * `SITE_CHALLENGE_MIN_PROXIES` is an absolute override for operators who
 * know their pool. Otherwise the threshold scales with the known roster
 * (`proxies_seen`) so the same deploy behaves sensibly on a 4-proxy and a
 * 28-proxy pool, floored so a tiny pool can't trip on one or two reports.
 * An unknown roster (0) collapses to the floor.
 */
export function resolveSiteChallengeMinProxies(
  env: Env,
  rosterSize: number,
): number {
  const override = env.SITE_CHALLENGE_MIN_PROXIES;
  if (override !== undefined && override !== "") {
    const n = Math.floor(Number(override));
    if (Number.isFinite(n) && n > 0) return n;
  }
  const floor = loadSiteChallengeMinProxiesFloor(env);
  const scaled = Math.ceil(
    Math.max(0, rosterSize) * loadSiteChallengeMinFraction(env),
  );
  return Math.max(floor, scaled);
}

export interface SiteChallengeTripInput {
  now: number;
  /** Persisted latch: ms epoch of the current trip, `0` when clear. */
  prevTrippedAt: number;
  /** ms epoch of the newest observation across all proxies, `0` when none. */
  lastObservationMs: number;
  /** Distinct proxies that reported inside the rolling window. */
  distinctProxies: number;
  threshold: number;
  ttlMs: number;
}

export interface SiteChallengeTripDecision {
  /** New latch value: `0` = clear, otherwise the ms epoch of the trip. */
  trippedAt: number;
  /** Set only on a state change, which is what gates alert emission. */
  transition: "tripped" | "cleared" | null;
}

/**
 * Pure trip / recovery decision, extracted so the latch semantics can be
 * unit-tested at arbitrary timestamps without waiting on wall-clock TTLs.
 *
 * Recovery is checked before the trip check so a deployment configured with
 * `ttlMs < window` (an expiring latch while reports are still inside the
 * window) settles on "tripped" in one pass instead of oscillating.
 */
export function resolveSiteChallengeTrip(
  input: SiteChallengeTripInput,
): SiteChallengeTripDecision {
  const { now, prevTrippedAt, lastObservationMs, distinctProxies, threshold, ttlMs } =
    input;
  let trippedAt = prevTrippedAt;
  let transition: "tripped" | "cleared" | null = null;

  // Auto-clear: the wall lifting is observable as reports simply stopping,
  // so the latch expires `ttlMs` after the most recent observation.
  if (
    trippedAt > 0 &&
    (lastObservationMs <= 0 || now - lastObservationMs > ttlMs)
  ) {
    trippedAt = 0;
    transition = "cleared";
  }
  if (trippedAt === 0 && threshold > 0 && distinctProxies >= threshold) {
    trippedAt = now;
    transition = "tripped";
  }
  return { trippedAt, transition };
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

// ─────────────────────────────────────────────────────────────────────────────
// W5.4 — signal helpers
// ─────────────────────────────────────────────────────────────────────────────

const SIGNAL_REASON_MAX_LEN = 200;
const SIGNAL_PROXY_ID_MAX_LEN = 256;
const SIGNAL_MIN_FACTOR = 1.0;
const SIGNAL_MAX_FACTOR = 100.0;
const SIGNAL_MIN_TTL_MS = 1_000;
const SIGNAL_MAX_TTL_MS = 24 * 60 * 60 * 1000; // 24 h ceiling

interface SignalValidation {
  signal?: Signal;
  error?: string;
}

/** Validate a ``POST /signal`` body and return a fully-formed
 *  {@link Signal} ready to persist, or an error string. Pure function so
 *  unit tests can exercise the rules without DO state. */
function validatePostSignal(body: PostSignalRequest): SignalValidation {
  if (body === null || typeof body !== "object") {
    return { error: "missing body" };
  }
  const kind = body.kind;
  if (
    kind !== "throttle_global" &&
    kind !== "ban_proxy" &&
    kind !== "pause_all" &&
    kind !== "resume"
  ) {
    return { error: "unknown signal kind" };
  }

  // ``resume`` short-circuits — it's a clear-all command, no payload to
  // validate beyond the kind itself.
  const now = Date.now();
  if (kind === "resume") {
    return {
      signal: {
        id: typeof body.id === "string" && body.id ? body.id : generateSignalId(),
        kind: "resume",
        // ``expires_at_ms = 0`` flags "no time bound" for resume; the
        // signal is consumed immediately by handlePostSignal.
        expires_at_ms: 0,
        created_at_ms: now,
        reason: clipReason(body.reason),
      },
    };
  }

  // Non-resume kinds require a positive TTL.
  const ttlMs = Number(body.ttl_ms);
  if (!Number.isFinite(ttlMs) || ttlMs < SIGNAL_MIN_TTL_MS) {
    return { error: `ttl_ms must be >= ${SIGNAL_MIN_TTL_MS}` };
  }
  const clampedTtl = Math.min(ttlMs, SIGNAL_MAX_TTL_MS);

  const signal: Signal = {
    id: typeof body.id === "string" && body.id ? body.id : generateSignalId(),
    kind,
    expires_at_ms: now + clampedTtl,
    created_at_ms: now,
    reason: clipReason(body.reason),
  };

  if (kind === "throttle_global") {
    const factor = Number(body.factor);
    if (
      !Number.isFinite(factor) ||
      factor < SIGNAL_MIN_FACTOR ||
      factor > SIGNAL_MAX_FACTOR
    ) {
      return {
        error: `factor must be in [${SIGNAL_MIN_FACTOR}, ${SIGNAL_MAX_FACTOR}]`,
      };
    }
    signal.factor = factor;
  } else if (kind === "ban_proxy") {
    const proxyId = typeof body.proxy_id === "string" ? body.proxy_id.trim() : "";
    if (!proxyId) {
      return { error: "proxy_id required for ban_proxy" };
    }
    if (proxyId.length > SIGNAL_PROXY_ID_MAX_LEN) {
      return { error: "proxy_id too long" };
    }
    signal.proxy_id = proxyId;
  }
  // ``pause_all`` needs no kind-specific payload.

  return { signal };
}

/** Drop signals whose ``expires_at_ms`` is in the past (treating 0 as
 *  "never expires" since only the operator-resume path uses it, and
 *  resume signals never enter storage). */
function pruneExpiredSignals(data: RegistryData, now: number): void {
  if (data.signals === undefined || data.signals.length === 0) return;
  data.signals = data.signals.filter(
    (s) => s.expires_at_ms === 0 || s.expires_at_ms > now,
  );
}

function clipReason(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  if (s === "") return undefined;
  return s.length > SIGNAL_REASON_MAX_LEN
    ? s.slice(0, SIGNAL_REASON_MAX_LEN)
    : s;
}

/** Generate an 8-hex-char signal id. Operators can also supply their own
 *  via ``POST /signal { id }`` for ops correlation. */
function generateSignalId(): string {
  // Workers runtime ships ``crypto.randomUUID()``; use the first 8
  // hex chars after stripping dashes for compactness.
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase-1 ADR-008 — session payload helpers
// ─────────────────────────────────────────────────────────────────────────────

const VALID_SESSION_STATUSES = new Set<SessionStatus>([
  "in_progress",
  "finalizing",
  "committed",
  "failed",
  "cancelled",
]);
const VALID_SESSION_WRITE_MODES = new Set<SessionWriteMode>([
  "audit",
  "pending",
  "unknown",
]);

/** Parse + validate a session payload from a runner request body. Returns
 *  `null` for any malformed entry — callers fall open (no DB write) so a
 *  buggy client can't break the rest of the register / heartbeat flow. */
export function parseSessionInfo(raw: unknown): SessionInfo | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const sessionId = typeof obj.session_id === "string" ? obj.session_id.trim() : "";
  if (!sessionId || sessionId.length > 128) return null;
  const status =
    typeof obj.status === "string" ? (obj.status.trim() as SessionStatus) : undefined;
  if (!status || !VALID_SESSION_STATUSES.has(status)) return null;
  const writeMode =
    typeof obj.write_mode === "string"
      ? (obj.write_mode.trim() as SessionWriteMode)
      : undefined;
  const reportType =
    typeof obj.report_type === "string" ? obj.report_type.trim() : undefined;
  const failureReasonRaw =
    typeof obj.failure_reason === "string" ? obj.failure_reason : undefined;
  return {
    session_id: sessionId,
    status,
    write_mode:
      writeMode !== undefined && VALID_SESSION_WRITE_MODES.has(writeMode)
        ? writeMode
        : "unknown",
    report_type: reportType ? reportType.slice(0, 64) : undefined,
    failure_reason:
      failureReasonRaw !== undefined
        ? failureReasonRaw.slice(0, SESSION_FAILURE_REASON_MAX_LEN)
        : undefined,
  };
}

/** Read existing session row, if any. */
function readSessionRow(
  sql: SqlStorage,
  sessionId: string,
): SessionRecord | null {
  const rows = Array.from(
    sql.exec<{
      session_id: string;
      holder_id: string;
      workflow_run_id: string;
      workflow_name: string;
      report_type: string;
      status: string;
      write_mode: string;
      failure_reason: string;
      started_at: number;
      updated_at: number;
      ended_at: number;
    }>(
      `SELECT session_id, holder_id, workflow_run_id, workflow_name,
              report_type, status, write_mode, failure_reason,
              started_at, updated_at, ended_at
         FROM sessions WHERE session_id = ?`,
      sessionId,
    ),
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    session_id: r.session_id,
    holder_id: r.holder_id,
    workflow_run_id: r.workflow_run_id,
    workflow_name: r.workflow_name,
    report_type: r.report_type,
    status: r.status as SessionStatus,
    write_mode: r.write_mode as SessionWriteMode,
    failure_reason: r.failure_reason,
    started_at: r.started_at,
    updated_at: r.updated_at,
    ended_at: r.ended_at,
  };
}

interface SessionApplyResult {
  prevStatus: SessionStatus | null;
  newStatus: SessionStatus;
  isTerminal: boolean;
  record: SessionRecord;
}

const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "committed",
  "failed",
  "cancelled",
]);

/** Upsert a session row from a register/heartbeat/unregister payload.
 *  Returns the prev / new status + the final record so callers can decide
 *  whether to dispatch a `session_failed` alert. */
function applySessionUpsert(
  sql: SqlStorage,
  holderInfo: RunnerInfo,
  session: SessionInfo,
  now: number,
): SessionApplyResult {
  const existing = readSessionRow(sql, session.session_id);
  const newStatus = session.status;
  const isTerminal = TERMINAL_STATUSES.has(newStatus);
  const startedAt = existing ? existing.started_at : now;
  const reportType = session.report_type ?? existing?.report_type ?? "";
  const writeMode = session.write_mode ?? existing?.write_mode ?? "unknown";
  const failureReason =
    session.failure_reason ?? existing?.failure_reason ?? "";
  const endedAt = isTerminal
    ? existing?.ended_at && existing.ended_at > 0
      ? existing.ended_at
      : now
    : 0;
  sql.exec(
    `INSERT INTO sessions
      (session_id, holder_id, workflow_run_id, workflow_name,
       report_type, status, write_mode, failure_reason,
       started_at, updated_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       holder_id = excluded.holder_id,
       workflow_run_id = excluded.workflow_run_id,
       workflow_name = excluded.workflow_name,
       report_type = CASE WHEN excluded.report_type = ''
                          THEN sessions.report_type
                          ELSE excluded.report_type END,
       status = excluded.status,
       write_mode = CASE WHEN excluded.write_mode = 'unknown'
                          THEN sessions.write_mode
                          ELSE excluded.write_mode END,
       failure_reason = CASE WHEN excluded.failure_reason = ''
                              THEN sessions.failure_reason
                              ELSE excluded.failure_reason END,
       updated_at = excluded.updated_at,
       ended_at = CASE WHEN excluded.ended_at > 0
                        THEN excluded.ended_at
                        ELSE sessions.ended_at END`,
    session.session_id,
    holderInfo.holder_id,
    holderInfo.workflow_run_id,
    holderInfo.workflow_name,
    reportType,
    newStatus,
    writeMode,
    failureReason,
    startedAt,
    now,
    endedAt,
  );
  const refreshed = readSessionRow(sql, session.session_id);
  return {
    prevStatus: existing?.status ?? null,
    newStatus,
    isTerminal,
    record: refreshed!,
  };
}

/** Build the canonical RunnerInfo subset used as the holder context for
 *  session upserts. Inline helper so register/heartbeat/unregister can
 *  share one call-site even though their RunnerInfo source differs. */
function holderInfoFromRequest(
  holderId: string,
  body: { workflow_run_id?: string; workflow_name?: string },
): RunnerInfo {
  return {
    holder_id: holderId,
    workflow_run_id: clipString(body.workflow_run_id ?? ""),
    workflow_name: clipString(body.workflow_name ?? ""),
    started_at: 0,
    last_heartbeat: 0,
    proxy_pool_hash: "",
    page_range: null,
  };
}

/** Convert a SessionRecord into a transport-shaped row for `/do/sessions`. */
function serializeSessionRow(rec: SessionRecord): SessionRecord {
  return rec;
}

/** Defensive JSON.parse — returns `{}` on any structural / parse error
 *  so a corrupt `details_json` cell never crashes a list endpoint. */
function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return {};
}
