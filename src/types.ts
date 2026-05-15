export interface Env {
  PROXY_DO: DurableObjectNamespace;
  GLOBAL_LOGIN_STATE_DO: DurableObjectNamespace;
  /** P1-B — per-day-shard movie detail claim DO (see `src/movie_claim_state.ts`).
   *  ``undefined`` is allowed so older deploys (before the v3 migration) keep
   *  booting; clients that hit MovieClaim routes will get a 503. */
  MOVIE_CLAIM_DO?: DurableObjectNamespace;
  /** P2-E — singleton runner registry DO (see `src/runner_registry.ts`).
   *  Same `undefined`-allowed contract as `MOVIE_CLAIM_DO`: callers fall
   *  open to "registry not configured" without breaking the runner. */
  RUNNER_REGISTRY_DO?: DurableObjectNamespace;
  LEASE_ANALYTICS?: AnalyticsEngineDataset;
  PROXY_COORDINATOR_TOKEN: string;
  SHORT_WINDOW_SEC?: string;
  SHORT_MAX?: string;
  LONG_WINDOW_SEC?: string;
  LONG_MAX?: string;
  EXTRA_WINDOW_SEC?: string;
  EXTRA_MAX?: string;
  PENALTY_WINDOW_SEC?: string;
  JITTER_MAX_MS?: string;
  /** Default ban TTL applied when `/report` body omits `ttl_ms` for `kind: "ban"`.
   *  Configurable via `wrangler.toml` `[vars]`; falls back to 3 days. */
  BAN_TTL_MS?: string;
  /** Default per-claim TTL for `MovieClaimState`.  Configurable via
   *  `wrangler.toml [vars]`; falls back to 30 minutes. */
  MOVIE_CLAIM_TTL_MS?: string;
  /** P2-E — runners with `last_heartbeat < now - RUNNER_STALE_TTL_MS` are
   *  considered dead and pruned by the registry's GC alarm.  Defaults to
   *  10 minutes (≥ 5× the 60 s heartbeat interval). */
  RUNNER_STALE_TTL_MS?: string;
  /** Minimum live-runner count at which `RunnerRegistry` recommends
   *  enabling the per-day MovieClaim mutex.  Returned to the client as
   *  `movie_claim_recommended = active_runners.length >= this` on every
   *  `/register` / `/heartbeat` response so Python clients in `auto`
   *  mode can mount / unmount their `MovieClaimClient` automatically.
   *  Defaults to 2; floored at 1 server-side. */
  MOVIE_CLAIM_MIN_RUNNERS?: string;
  /** P2-C — number of recent failed login attempts (within
   *  `LOGIN_COOLDOWN_WINDOW_SEC`) above which `acquire_lease` returns a
   *  non-zero `cooldown_until_ms`.  Defaults to 5; tunable per-deploy via
   *  `wrangler.toml [vars]`. */
  LOGIN_COOLDOWN_THRESHOLD?: string;
  /** P2-C — sliding window in seconds over which recent login attempts
   *  are counted for cooldown.  Defaults to 1 hour (3600). */
  LOGIN_COOLDOWN_WINDOW_SEC?: string;
  /** P2-C — duration (ms) of the cooldown emitted once the threshold is
   *  crossed.  Defaults to 30 min so a flapping login pool gets a clear
   *  back-off without blocking the day's ingestion. */
  LOGIN_COOLDOWN_DURATION_MS?: string;
  /** Number of href-based sub-shards within each per-day MovieClaim shard.
   *  Defaults to 4; set to "1" to disable sub-sharding (e.g. in tests). */
  NUM_CLAIM_SHARDS?: string;
  /** W5.6 — maximum authorised requests per minute per Bearer token.
   *  Defaults to "1000". Set to "0" or any non-positive value to disable
   *  the rate limit (e.g. in tests). Best-effort: state lives in the
   *  Worker isolate and resets on cold start, but burst abuse from a
   *  single token within a single isolate is still blocked. */
  WORKER_RATE_LIMIT_PER_MIN?: string;
}

/** Default ban duration when the client doesn't pass `ttl_ms`. 3 days = 259_200_000 ms. */
export const DEFAULT_BAN_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export interface ThrottleConfig {
  shortWindowSec: number;
  shortMax: number;
  longWindowSec: number;
  longMax: number;
  extraWindowSec: number;
  extraMax: number;
  penaltyWindowSec: number;
  jitterMaxMs: number;
}

export interface LeaseRequest {
  proxy_id: string;
  intended_sleep_ms: number;
}

export interface LeaseResponse {
  wait_ms: number;
  penalty_factor: number;
  server_time: number;
  reason:
    | "ok"
    | "next_available"
    | "throttle_short"
    | "throttle_long"
    | "throttle_extra"
    | "max_wait_capped"
    /** Set when ``bannedUntil > now``; ``wait_ms`` is still computed normally so
     * old clients sleep but new clients can short-circuit on ``banned: true``. */
    | "banned";
  /**
   * Cross-runner proxy ban / CF bypass state piggy-backed on the existing lease
   * round-trip (P1-A).  All four fields are optional so old Python clients that
   * don't know about them simply ignore the keys; new clients fall back to
   * ``False`` / ``None`` when the Worker omits them too — see
   * `LeaseResult` defaults in
   * ``packages/python/javdb_platform/proxy_coordinator_client.py``.
   */
  /** ``true`` iff ``bannedUntil`` is set and not yet expired at lease time. */
  banned?: boolean;
  /** Wall-clock ms epoch when the current ban auto-expires; ``null`` when never. */
  banned_until?: number | null;
  /** Mirrors ``state.mark_proxy_cf_bypass`` semantics: this proxy needs CF bypass
   *  to talk to JavDB.  ``true`` while ``cfBypassUntil`` is in the future or set
   *  to ``0`` (= entire session). */
  requires_cf_bypass?: boolean;
  /** Wall-clock ms epoch when CF bypass requirement auto-expires; ``0`` means
   *  "permanent for this session" (mirrors ``always_bypass_time == 0``);
   *  ``null`` when not currently flagged. */
  cf_bypass_until?: number | null;
  /**
   * P2-D — cross-runner proxy health summary derived from rolling
   * `successEvents` / `failureEvents` counters and an EMA of HTTP
   * latency.  Optional for backward-compat with old Workers; new
   * clients use it to weight ``ProxyPool.next_proxy`` toward
   * historically-healthy proxies.  Returned alongside every lease so
   * the spider doesn't pay for a separate health round-trip on the
   * hot path.  ``null`` is functionally equivalent to "no data yet"
   * (treat as neutral / mid-score).
   */
  health?: ProxyHealthSnapshot | null;
}

/**
 * P2-D — per-proxy health summary surfaced inside {@link LeaseResponse}.
 *
 * - ``success_count`` / ``failure_count`` are simple in-window counts of
 *   ``ReportRequest`` events with ``kind="success"`` / ``"failure"``.
 *   They use the same ``penaltyWindowSec`` configured on the Worker
 *   (so a ``cfEvents`` reset and a health reset stay in sync), which
 *   keeps the DO storage footprint flat — three numeric arrays max.
 * - ``latency_ema_ms`` is an exponential moving average of recent HTTP
 *   latencies tagged with ``ReportRequest.latency_ms``; the smoothing
 *   factor lives in the Worker (default ``0.2``).  ``0`` when no
 *   latency report has ever landed for this proxy.
 * - ``score`` is a derived 0..1 number (1.0 = ideal) that the Python
 *   ``ProxyPool.next_proxy`` consumes directly so the client doesn't
 *   need to know the smoothing maths.  Computed server-side from the
 *   three primitive fields above.  Persisting only the primitives
 *   keeps the DO single source of truth — clients never have to
 *   reconcile a stale ``score`` against the underlying counters.
 */
export interface ProxyHealthSnapshot {
  success_count: number;
  failure_count: number;
  latency_ema_ms: number;
  /** 0..1, computed server-side; higher is better. */
  score: number;
}

export interface ReportRequest {
  proxy_id: string;
  /** Existing kinds (`cf` / `failure`) update the penalty window.  P1-A
   *  adds three out-of-band kinds that mutate ``bannedUntil`` /
   *  ``cfBypassUntil``.  P2-D adds ``"success"`` for the health
   *  scorer; the DO bumps ``successEvents`` and refreshes the
   *  ``latencyEma`` from ``latency_ms`` when present. */
  kind: "cf" | "failure" | "ban" | "unban" | "cf_bypass" | "success";
  /** Optional TTL for ``ban`` / ``cf_bypass`` kinds, in ms.  Ignored otherwise.
   *  ``ban`` defaults to ``BAN_TTL_MS`` (3 days); ``cf_bypass`` accepts ``0`` =
   *  "permanent for this session" to mirror ``always_bypass_time == 0``. */
  ttl_ms?: number;
  /** Free-form annotation kept for ops only; the DO does not parse it. */
  reason?: string;
  /** P2-D — observed HTTP latency for this attempt, in ms.  Folded into
   *  ``latencyEma`` regardless of ``kind`` (a slow-but-successful
   *  request still counts as healthy time, just with worse latency).
   *  Optional; older clients omit it. */
  latency_ms?: number;
}

/**
 * P2-D — exponential moving-average smoothing factor for
 * ``latencyEma`` updates on every ``success``/``failure`` report.
 * Values closer to 1 react faster to the latest sample (more
 * jitter); closer to 0 average over more history (more lag).  ``0.2``
 * is a balanced default — a step change of 100ms takes ~5 samples to
 * influence the average by ~67%.
 */
export const PROXY_LATENCY_EMA_ALPHA = 0.2;

export interface ReportResponse {
  penalty_factor: number;
  recent_event_count: number;
  server_time: number;
}

/**
 * Read tuning values from Worker env (string-typed) with hardcoded defaults
 * that mirror the Python `TripleWindowThrottle` + `PenaltyTracker` constants.
 */
export function loadThrottleConfig(env: Env): ThrottleConfig {
  const num = (v: string | undefined, fallback: number): number => {
    if (v === undefined || v === "") return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    shortWindowSec: num(env.SHORT_WINDOW_SEC, 30),
    shortMax: num(env.SHORT_MAX, 3),
    longWindowSec: num(env.LONG_WINDOW_SEC, 300),
    longMax: num(env.LONG_MAX, 30),
    extraWindowSec: num(env.EXTRA_WINDOW_SEC, 1800),
    extraMax: num(env.EXTRA_MAX, 200),
    penaltyWindowSec: num(env.PENALTY_WINDOW_SEC, 300),
    jitterMaxMs: num(env.JITTER_MAX_MS, 500),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GlobalLoginState DO — cross-runtime JavDB login state (singleton DO, addressed
// by `idFromName("global")`).  Coexists with ProxyCoordinator (per-proxy DO)
// inside the same Worker; reuses the same bearer token for auth.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Server-side bounds applied to ``ttl_ms`` in :data:`AcquireLeaseRequest`.
 * The lower bound stops a buggy caller from acquiring a 1 ms lease that
 * effectively self-releases; the upper bound prevents a crashed runner from
 * blocking re-login for hours.  Mirrors the Python defaults: 60 s typical,
 * 5 min worst case.
 */
export const LOGIN_LEASE_TTL_MIN_MS = 5_000;
export const LOGIN_LEASE_TTL_MAX_MS = 300_000;

export interface LoginStateGetResponse {
  /** Currently logged-in proxy name, or ``null`` if none. */
  proxy_name: string | null;
  /** Decrypted session cookie plaintext, or ``null`` if no valid cookie. */
  cookie: string | null;
  /** Monotonic version, incremented on every ``publish`` / ``invalidate``. */
  version: number;
  /** Wall-clock ms epoch of the last ``publish``; ``0`` if never. */
  last_verified_at: number;
  /** ``true`` iff a non-expired lease exists; holder identity is hidden. */
  has_active_lease: boolean;
  server_time: number;
}

export interface AcquireLeaseRequest {
  /** Caller-side opaque identity; typically a per-process UUID. */
  holder_id: string;
  /** The proxy name the caller intends to log in through. */
  target_proxy_name: string;
  /**
   * Desired lease lifetime in ms.  Server clamps to
   * ``[LOGIN_LEASE_TTL_MIN_MS, LOGIN_LEASE_TTL_MAX_MS]``.
   */
  ttl_ms: number;
}

export interface AcquireLeaseResponse {
  /** ``true`` when this caller now owns the lease (fresh acquire or renewal). */
  acquired: boolean;
  /** Identity of the current owner (self when ``acquired``, else other). */
  holder_id: string;
  /** Target proxy of the current lease (echoes caller's value when acquired). */
  target_proxy_name: string;
  /** Wall-clock ms epoch when the current lease expires. */
  lease_expires_at: number;
  /** P2-C — wall-clock ms epoch until which the global pool of login
   *  attempts is in cooldown after recent failures crossed the
   *  per-Worker `LOGIN_COOLDOWN_THRESHOLD` within
   *  `LOGIN_COOLDOWN_WINDOW_SEC`.  ``0`` (or omitted by old Workers)
   *  when no cooldown is active.  The lease is STILL granted when set;
   *  the caller is responsible for parking its login flow until
   *  ``cooldown_until_ms`` so the lease owner doesn't burn through more
   *  attempts during the back-off.  Default ``0`` keeps old clients
   *  working unchanged. */
  cooldown_until_ms?: number;
  /** P2-C — number of recent attempts counted within the window when
   *  the cooldown was decided.  Surfaced for ops visibility only;
   *  the spider does not branch on it. */
  recent_attempt_count?: number;
  server_time: number;
}

export interface PublishRequest {
  /** Must equal the current lease holder, otherwise the call is rejected. */
  holder_id: string;
  /** Proxy that performed the login; should match the lease's target. */
  proxy_name: string;
  /** Cleartext session cookie; encrypted at rest with AES-GCM. */
  cookie: string;
}

export interface PublishResponse {
  ok: boolean;
  /** New monotonic version after the publish (i.e. ``previous + 1``). */
  version: number;
  server_time: number;
}

export interface InvalidateRequest {
  /** Optimistic lock: must equal the cached version, else the call no-ops. */
  version: number;
}

export interface InvalidateResponse {
  /** ``true`` only when the version matched and the cookie was cleared. */
  invalidated: boolean;
  /** Always populated, so the caller can resync after a stale invalidate. */
  current_version: number;
  server_time: number;
}

export interface ReleaseLeaseRequest {
  /** Only the current holder may release.  Other holders get ``released:false``. */
  holder_id: string;
}

export interface ReleaseLeaseResponse {
  released: boolean;
  server_time: number;
}

// ── P2-C: cross-runner login attempt accounting + cooldown ──────────────
//
// Runs INSIDE the existing `GlobalLoginState` DO (no new binding, no new
// `wrangler` migration tag).  Each `record_attempt` call appends a
// timestamped entry to a rolling `recent_attempts[]` buffer; entries
// older than `LOGIN_COOLDOWN_WINDOW_SEC` are pruned on every read so
// the buffer stays bounded by the threshold + a few seconds of slack.

/** P2-C — default sliding window (seconds) over which login attempts are
 * counted toward the cooldown threshold.  1 hour matches the operational
 * intuition that "5 failures in an hour" is suspicious but "5 failures
 * across 6 hours" is normal flake. */
export const DEFAULT_LOGIN_COOLDOWN_WINDOW_SEC = 3_600;

/** P2-C — default failure-count threshold.  Set to ``5`` so a single
 * misconfigured proxy can't trip the cooldown (the lease serializer
 * already throttles concurrent attempts), but a real outage of the
 * login pool surfaces within the first hour. */
export const DEFAULT_LOGIN_COOLDOWN_THRESHOLD = 5;

/** P2-C — default cooldown duration when the threshold is crossed.
 * 30 min lets a flapping login pool calm down without blocking the
 * day's ingestion entirely.  A subsequent successful login implicitly
 * shortens the effective cooldown because the success record lowers
 * the failure ratio inside the window. */
export const DEFAULT_LOGIN_COOLDOWN_DURATION_MS = 30 * 60 * 1000;

/** P2-C — hard cap on the number of recent_attempts entries kept in
 * DO storage.  Pruning by window already keeps the buffer small under
 * normal operation; this cap defends against a bug or hot-loop that
 * spams `record_attempt` faster than the window prunes. */
export const RECENT_ATTEMPTS_MAX_LEN = 256;

export type RecordAttemptOutcome = "success" | "failure";

export interface RecordAttemptRequest {
  /** Caller-side opaque identity; mirrors `state.runtime_holder_id`.
   *  Required for ops correlation but the DO does not branch on it. */
  holder_id: string;
  /** Proxy that performed (or attempted) the login. */
  proxy_name: string;
  /** Result of this attempt.  Successes are still recorded so a
   *  successful login implicitly drains the failure ratio inside the
   *  sliding window; the cooldown function counts failures only. */
  outcome: RecordAttemptOutcome;
}

export interface RecordAttemptResponse {
  /** Number of recent attempts (all outcomes) within the window AFTER
   *  this attempt was appended.  Surfaced so the caller can ack the
   *  decision the DO will make on the next `acquire_lease` without an
   *  extra round-trip. */
  recent_attempt_count: number;
  /** Number of recent FAILURES within the window after the append. */
  recent_failure_count: number;
  /** Wall-clock ms epoch until which the global login pool is in
   *  cooldown.  ``0`` when failures haven't crossed the threshold. */
  cooldown_until_ms: number;
  server_time: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// MovieClaimState DO (P1-B) — per-day-sharded claim ledger that arbitrates
// detail-page fetches across multiple GH Actions runners.  Addressed by
// `idFromName("YYYY-MM-DD-Asia/Singapore")` so a single day's claims live in
// one DO, with old shards naturally garbage-collected by the Cloudflare DO
// LRU once they go untouched.
//
// Wire schema is intentionally flat / boolean-heavy so old clients can
// short-circuit on a single field; see ``packages/python/javdb_platform/
// movie_claim_client.py`` for the Python mirror.
// ─────────────────────────────────────────────────────────────────────────────

/** Default TTL for a single movie claim (30 min) used when the request omits
 * ``ttl_ms``.  Sized to comfortably cover detail-page fetch + parse + qB add
 * for a slow proxy without holding the slot if a runner crashes — DO Alarm GC
 * sweeps expired claims every 10 minutes regardless. */
export const DEFAULT_MOVIE_CLAIM_TTL_MS = 30 * 60 * 1000;

/** Minimum / maximum bounds applied to ``ttl_ms`` on the server side.  The
 * floor stops a misconfigured caller from acquiring a 1 ms claim that
 * effectively self-releases; the ceiling keeps a stuck holder from blocking
 * a movie for hours.  Both sides chosen to match operational reality, not
 * to be fiddly knobs — most callers should just pass ``DEFAULT_MOVIE_CLAIM_TTL_MS``. */
export const MOVIE_CLAIM_TTL_MIN_MS = 60_000;          // 1 min
export const MOVIE_CLAIM_TTL_MAX_MS = 2 * 60 * 60_000; // 2 h

/** How often the DO Alarm fires to GC expired claims.  Every 10 min keeps
 * the worst-case stale window at ``2 * MOVIE_CLAIM_TTL_MIN_MS`` while
 * costing only ~144 alarm invocations per day per shard. */
export const MOVIE_CLAIM_ALARM_INTERVAL_MS = 10 * 60_000;

export interface ClaimMovieRequest {
  /** Movie detail page href, e.g. `/v/abc123`.  Used as the claim key. */
  href: string;
  /** Caller-side opaque identity; typically `state.runtime_holder_id`. */
  holder_id: string;
  /** Optional per-claim TTL override; clamped to the DO bounds above.
   *  Most callers pass ``DEFAULT_MOVIE_CLAIM_TTL_MS``. */
  ttl_ms?: number;
  /** Phase-1 rollback safety: when set, the DO treats a `staged_complete`
   *  entry written by the SAME `session_id` as ``already_completed=true``
   *  (idempotent skip) but DOES NOT block other sessions on a peer
   *  session's staged entry — so a daily-run rollback can leave the
   *  staged entry in place without blocking adhoc retries.  When omitted
   *  the legacy P1-B contract still applies: only `completed_committed`
   *  triggers ``already_completed=true``. */
  session_id?: string;
}

export interface ClaimMovieResponse {
  /** ``true`` when *this* caller now owns the claim (fresh acquire OR
   *  idempotent renewal by the same holder).  When ``false`` the caller
   *  MUST consult ``already_completed``, ``cooldown_until``, and
   *  ``current_holder_id`` to decide between "another runner is working
   *  on it" (back off + retry), "another runner already finished" (skip
   *  + mark local history), or "URL is in cooldown after repeated
   *  failures" (back off until ``cooldown_until``). */
  acquired: boolean;
  /** Holder of the *current* (winning) claim — equals the caller's
   *  ``holder_id`` when ``acquired`` is true. */
  current_holder_id: string;
  /** Wall-clock ms epoch when the current claim auto-expires. */
  expires_at: number;
  /** ``true`` when this href has already gone through ``/complete_movie``
   *  in the same per-day shard.  When ``true`` a non-acquiring caller
   *  should treat the work as done (skip + record local history) rather
   *  than spinning on retry. */
  already_completed: boolean;
  /** P2-A — wall-clock ms epoch until which this href is in cooldown
   *  due to repeated failures.  ``0`` (or omitted by old Workers) when
   *  not in cooldown.  When ``acquired=false`` AND ``cooldown_until > 0``
   *  AND ``cooldown_until > server_time``, the caller must NOT retry
   *  before ``cooldown_until`` — the URL is on a dead-letter timer. */
  cooldown_until?: number;
  /** P2-A — error kind that triggered the most recent cooldown.  Free-form
   *  string (e.g. ``"http_404"`` / ``"parse_error"``); used by ops only. */
  last_error_kind?: string;
  /** P2-A — number of recent failures recorded against this href.  Reset
   *  on the first ``complete_movie`` so a successful run wipes the
   *  cooldown bookkeeping. */
  fail_count?: number;
  /** Phase-1 — session_id of the staged_complete entry blocking this
   *  href, if any.  ``""`` (or omitted by older Workers) when no staged
   *  entry exists.  When the request supplied a matching ``session_id``
   *  the DO sets ``already_completed=true`` AND echoes this field so the
   *  client can confirm the same-session idempotent path; when the
   *  staged entry belongs to a *different* session it is non-empty but
   *  ``already_completed`` is ``false`` and the claim proceeds normally. */
  staged_session_id?: string;
  server_time: number;
}

export interface ReleaseMovieRequest {
  href: string;
  /** Only the holder of record may release.  Stale releasers get
   *  ``released:false`` (silent no-op, mirrors `release_lease`). */
  holder_id: string;
}

export interface ReleaseMovieResponse {
  released: boolean;
  server_time: number;
}

export interface CompleteMovieRequest {
  href: string;
  /** Only the holder of record may complete.  Stale completes get
   *  ``completed:false`` so the caller can decide whether to retry. */
  holder_id: string;
}

export interface CompleteMovieResponse {
  completed: boolean;
  /** Echoed back so callers can dedupe their local "already_completed" set. */
  href: string;
  server_time: number;
}

// ── Phase-1 rollback safety: stage / commit / rollback / sweep ─────────────
//
// `complete_movie` writes directly to ``completed_committed[]`` and is
// preserved for backward compatibility with pre-Phase-1 clients.  Phase-1
// clients should call ``stage_complete_movie`` after a successful detail
// fetch instead, which writes into ``staged_complete{}`` keyed by href and
// tagged with the session_id.  The session-end CLI then promotes the
// staged entries to ``completed_committed[]`` on commit
// (`commit_completed_movies`) or deletes them on rollback
// (`rollback_staged_movies`).  A safety-net cron sweeps long-orphaned
// staged entries via `sweep_orphan_stages`.
//
// State machine (per shard, per href):
//
//        ┌──────────────┐  stage_complete   ┌──────────────────┐
//        │  (no entry)  │────────────────▶  │  staged_complete │
//        └──────────────┘                    └──────────────────┘
//                                                    │  │
//                                  commit_completed_ │  │ rollback_staged_
//                                            movies  │  │       movies
//                                                    ▼  ▼
//                                          ┌──────────────────────┐
//                                          │ completed_committed  │
//                                          └──────────────────────┘

export interface StageCompleteMovieRequest {
  href: string;
  /** Holder-of-record check, mirrors `complete_movie`. */
  holder_id: string;
  /** Session that performed the detail fetch; used by Phase-1 commit /
   *  rollback to scope per-session promotions / deletions.  Empty string
   *  is rejected (``400``) — the staged entry would otherwise be
   *  un-rollbackable. */
  session_id: string;
}

export interface StageCompleteMovieResponse {
  /** ``true`` once the staged entry exists for this href (fresh stage OR
   *  idempotent re-stage by the same session_id).  ``false`` for
   *  stale-holder calls (the active claim belongs to someone else) and
   *  for re-stages from a different session — those callers should
   *  consult the live claim state via ``/movie_status``. */
  staged: boolean;
  /** Echoed for client-side dedup. */
  href: string;
  /** Session that owns the staged entry now (may differ from request
   *  ``session_id`` when an earlier different-session stage is preserved). */
  session_id: string;
  server_time: number;
}

export interface CommitCompletedMoviesRequest {
  /** Promote every staged entry whose ``session_id`` matches this value
   *  into ``completed_committed[]``.  Idempotent: re-running the call
   *  after a successful commit returns ``promoted=0`` rather than an
   *  error. */
  session_id: string;
}

export interface CommitCompletedMoviesResponse {
  /** Number of staged entries that were just moved to
   *  ``completed_committed[]``.  ``0`` is the steady state once all
   *  entries have been committed (idempotent re-runs land here). */
  promoted: number;
  /** Echoed back so the caller can correlate with its local audit log. */
  session_id: string;
  server_time: number;
}

export interface RollbackStagedMoviesRequest {
  /** Delete every staged entry whose ``session_id`` matches this value. */
  session_id: string;
}

export interface RollbackStagedMoviesResponse {
  /** Number of staged entries removed from ``staged_complete{}``. */
  removed: number;
  session_id: string;
  server_time: number;
}

export interface SweepOrphanStagesResponse {
  /** Number of staged entries pruned because their ``ts`` is older than
   *  the supplied ``older_than_ms`` cutoff. */
  removed: number;
  /** Cutoff in ms epoch used for the sweep — ``server_time - older_than_ms``. */
  cutoff_ms: number;
  server_time: number;
}

/** Default sweep horizon when a caller passes no override (or an invalid
 *  value).  Sized so a 24h ingestion has comfortably committed before the
 *  sweep can prune its staged entries — anything older than 48h is
 *  unambiguously orphaned by a crashed runner. */
export const DEFAULT_SWEEP_ORPHAN_MS = 48 * 60 * 60_000;
/** Lower bound applied to ``older_than_ms`` so a buggy operator with an
 *  ``older_than_ms=0`` query string can't accidentally wipe live stages. */
export const MIN_SWEEP_ORPHAN_MS = 60 * 60_000;

export interface MovieStatusResponse {
  /** ``null`` when the href has neither an active claim nor a completion. */
  current_holder_id: string | null;
  /** ``0`` when no active claim. */
  expires_at: number;
  already_completed: boolean;
  /** P2-A — see {@link ClaimMovieResponse.cooldown_until}.  ``0`` when
   *  the href is not in cooldown. */
  cooldown_until?: number;
  /** P2-A — see {@link ClaimMovieResponse.last_error_kind}. */
  last_error_kind?: string;
  /** P2-A — see {@link ClaimMovieResponse.fail_count}. */
  fail_count?: number;
  /** Phase-1 — session_id that owns the current ``staged_complete`` entry
   *  for this href, if any.  ``""`` when no staged entry exists.  Lets ops
   *  inspect the staged-but-not-committed state via ``/movie_status``
   *  without reaching for raw DO storage. */
  staged_session_id?: string;
  /** Phase-1 — wall-clock ms epoch when the current ``staged_complete``
   *  entry was created.  ``0`` when no staged entry exists.  Surfaced so
   *  ops can correlate orphan stages with the wall-clock timeline. */
  staged_at?: number;
  server_time: number;
}

// ── P2-A: per-href failure / cooldown / dead-letter tracking ──────────────
//
// Designed to live INSIDE the existing `MovieClaimState` DO so we don't
// pay for a second binding.  Each per-day shard keeps a `failures` map
// keyed by href; entries auto-expire after `MOVIE_CLAIM_FAILURE_TTL_MS`
// regardless of count, so a flaky runner that successfully completes the
// next day starts fresh.  See `src/movie_claim_state.ts` for the storage
// layout and the cooldown schedule.

/** P2-A — exponential-ish cooldown ladder applied per-href as
 * ``fail_count`` climbs.  Keys are ``fail_count`` thresholds; the runner
 * may retry the URL after the matching delay has elapsed since the last
 * failure.  After {@link MOVIE_CLAIM_DEAD_LETTER_THRESHOLD} failures the
 * cooldown stays at the maximum forever (i.e. dead-lettered for the
 * shard's lifetime — clears at end-of-day shard rotation). */
export const MOVIE_CLAIM_COOLDOWN_LADDER_MS: Array<[number, number]> = [
  [1, 60_000],         // 1 min after the 1st failure
  [2, 5 * 60_000],     // 5 min after the 2nd
  [3, 30 * 60_000],    // 30 min after the 3rd
  [5, 2 * 60 * 60_000], // 2 h after the 5th
];

/** P2-A — beyond this fail_count the href is considered dead-lettered
 * for the rest of the shard's day.  Set to a generous bound (8) so
 * legitimate long-tail failures (slow proxy, transient parse error) get
 * many chances before being permanently cooled. */
export const MOVIE_CLAIM_DEAD_LETTER_THRESHOLD = 8;

/** P2-A — failure-record TTL (per-href, independent of cooldown).  Old
 * failure stats prune from the shard once their last failure is older
 * than this; bounds the storage footprint per shard.  Sized to comfortably
 * cover the dead-letter window so the dead-letter signal is visible
 * for the full shard lifetime. */
export const MOVIE_CLAIM_FAILURE_TTL_MS = 24 * 60 * 60_000;

export interface ReportFailureRequest {
  /** Movie detail page href, e.g. `/v/abc123`.  Same key space as
   *  {@link ClaimMovieRequest.href}. */
  href: string;
  /** Caller-side opaque identity; the holder that just experienced the
   *  failure.  Used only for ops correlation; the failure record is
   *  global across runners. */
  holder_id?: string;
  /** Free-form error tag, e.g. ``"http_404"`` / ``"parse_error"`` /
   *  ``"timeout"``.  Stored verbatim for ops; the DO only inspects the
   *  presence (not the contents) when computing the cooldown. */
  error_kind?: string;
  /** Optional override of the cooldown ladder for this specific
   *  failure (in ms).  Most callers should leave this unset and let the
   *  DO compute the cooldown from {@link MOVIE_CLAIM_COOLDOWN_LADDER_MS}. */
  cooldown_ms?: number;
}

export interface ReportFailureResponse {
  /** Updated failure count after the report. */
  fail_count: number;
  /** Wall-clock ms epoch until which the href is now in cooldown. */
  cooldown_until: number;
  /** ``true`` when ``fail_count`` has crossed
   *  {@link MOVIE_CLAIM_DEAD_LETTER_THRESHOLD} — caller may treat the
   *  href as dead-lettered for the rest of the shard's lifetime. */
  dead_lettered: boolean;
  server_time: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// RunnerRegistry DO (P2-E) — singleton DO that tracks live spider runners
// across GH Actions workflow runs.  Addressed by `idFromName("runners")`;
// every runner converges on the same instance regardless of workflow.
//
// Two purposes (originally two separate plan items, merged here per the
// "RunnerRegistry covers P3-B" decision in the DO state expansion plan):
//
//   1. Operational visibility — answer "how many runners are live, what
//      workflow are they part of, when did they last heartbeat?" without
//      having to crawl GH Actions logs.
//   2. Configuration drift detection — every `register` payload carries
//      `proxy_pool_hash = sha1(PROXY_POOL_JSON)[:16]`, and the response
//      surfaces the active set so a newly-joining runner can `WARN` when
//      a peer's hash differs from its own.  This subsumes the original
//      P3-B "drift monitor" item without a second DO.
//
// Garbage collection: a DO Alarm fires every 5 min and prunes any runner
// whose `last_heartbeat` is older than `RUNNER_STALE_TTL_MS` (default
// 10 min — ≥ 5× the 60 s heartbeat cadence so a single missed heartbeat
// does not evict a healthy runner).
// ─────────────────────────────────────────────────────────────────────────────

/** Default staleness threshold (10 min): runners that haven't sent a
 * heartbeat within this window are considered dead and pruned by the GC
 * alarm.  Sized to be ≥ 5× the canonical 60 s heartbeat cadence so a
 * transient network blip can't evict a healthy runner. */
export const DEFAULT_RUNNER_STALE_TTL_MS = 10 * 60_000;

/** GC alarm cadence — every 5 min.  Keeps the worst-case stale window at
 * `DEFAULT_RUNNER_STALE_TTL_MS + RUNNER_REGISTRY_ALARM_INTERVAL_MS` while
 * costing only ~288 alarm invocations per day.  Independent of the heartbeat
 * cadence on purpose (clients drive heartbeats; the DO drives GC). */
export const RUNNER_REGISTRY_ALARM_INTERVAL_MS = 5 * 60_000;

/** Default minimum live-runner count for recommending MovieClaim activation.
 *  Mirrors {@link Env.MOVIE_CLAIM_MIN_RUNNERS} and is the ground truth when
 *  the env var is unset or invalid.  Set to 2 because a lone runner gains
 *  nothing from claim coordination (no peers to race) yet pays +2 DO calls
 *  per detail page.  Floored at 1 server-side: setting "0" or a negative
 *  value would make `recommended` always-true regardless of cohort size,
 *  which defeats the auto-toggle. */
export const DEFAULT_MOVIE_CLAIM_MIN_RUNNERS = 2;

/** Maximum length cap on caller-provided string fields.  Prevents a buggy
 * caller from filling the singleton DO with arbitrarily large GH workflow
 * metadata; values that exceed this are truncated server-side and a
 * truncation flag is logged.  Sized to comfortably fit any realistic
 * GH Actions workflow / run identifier. */
export const RUNNER_FIELD_MAX_LEN = 512;

export interface RunnerInfo {
  /** Caller-side opaque identity; mirrors `state.runtime_holder_id`. */
  holder_id: string;
  /** GH Actions ``GITHUB_RUN_ID`` env var.  Empty string when running
   *  locally / outside GH Actions. */
  workflow_run_id: string;
  /** GH Actions ``GITHUB_WORKFLOW`` env var. */
  workflow_name: string;
  /** Wall-clock ms epoch when this runner first registered. */
  started_at: number;
  /** Wall-clock ms epoch of the most recent heartbeat or register call;
   *  the GC alarm uses this to evict stale runners. */
  last_heartbeat: number;
  /** ``sha1(PROXY_POOL_JSON)[:16]`` so a peer joining the registry can
   *  detect configuration drift across runners.  Intentionally not the
   *  full SHA-1 — 16 hex chars (64 bits) is plenty for collision avoidance
   *  with O(N) live runners. */
  proxy_pool_hash: string;
  /** Optional hint about which page range this runner is processing
   *  (e.g. ``"1-50"``).  Used by ops to detect overlapping runs; not
   *  enforced by the DO. */
  page_range: string | null;
}

export interface RegisterRunnerRequest {
  holder_id: string;
  workflow_run_id?: string;
  workflow_name?: string;
  started_at?: number;
  proxy_pool_hash?: string;
  page_range?: string | null;
}

export interface RegisterRunnerResponse {
  /** ``true`` for a fresh registration; ``false`` when the same
   *  ``holder_id`` was already registered (the call is treated as an
   *  implicit heartbeat + metadata refresh). */
  registered: boolean;
  /** Live runner snapshot returned to every registrant.  Already pruned
   *  of stale entries based on the current ``RUNNER_STALE_TTL_MS``. */
  active_runners: RunnerInfo[];
  /** Distinct ``proxy_pool_hash`` values currently in the registry, with
   *  their occurrence counts.  Empty when only the caller's hash is
   *  present.  Lets the client emit a single ``WARN`` if its own hash
   *  doesn't match the majority — replaces the original P3-B drift DO. */
  pool_hash_summary: Array<{ hash: string; count: number }>;
  /** Derived recommendation for whether the per-day MovieClaim mutex
   *  should be active right now.  Equals
   *  ``active_runners.length >= movie_claim_min_runners`` and is computed
   *  AFTER the current register has been written to storage, so the
   *  second of two concurrent registers reliably observes ``true`` (DO
   *  calls are serialized — see `runner_registry.ts`).
   *
   *  Python clients in ``MOVIE_CLAIM_ENABLED=auto`` mode use this flag
   *  to mount / unmount their global `MovieClaimClient` without operator
   *  intervention; ``force_on`` / ``off`` modes ignore it.  Optional
   *  field for forward-compat with old clients (they ignore unknown
   *  keys; new clients default to ``false`` when missing — equivalent
   *  to "single-runner" semantics, the safe default). */
  movie_claim_recommended?: boolean;
  /** Server-side threshold used to compute {@link movie_claim_recommended}.
   *  Surfaced for ops visibility (so a runner can log the active
   *  threshold instead of trusting a hard-coded constant on the
   *  Python side).  Sourced from {@link Env.MOVIE_CLAIM_MIN_RUNNERS},
   *  defaulting to {@link DEFAULT_MOVIE_CLAIM_MIN_RUNNERS}. */
  movie_claim_min_runners?: number;
  server_time: number;
}

export interface HeartbeatRequest {
  holder_id: string;
}

export interface HeartbeatResponse {
  /** ``true`` when the runner was found + heartbeat refreshed.  ``false``
   *  for an unknown ``holder_id`` (e.g. the GC alarm pruned it because
   *  the runner stopped heartbeating; the client should re-``register``). */
  alive: boolean;
  /** Mirror of {@link RegisterRunnerResponse.movie_claim_recommended} on
   *  every successful heartbeat — lets clients in ``auto`` mode pick up
   *  cohort changes (e.g. a peer's atexit `unregister` arriving) without
   *  forcing them to call ``/register`` again.  Always reflects the
   *  registry state AFTER this heartbeat refresh. */
  movie_claim_recommended?: boolean;
  /** Mirror of {@link RegisterRunnerResponse.movie_claim_min_runners}. */
  movie_claim_min_runners?: number;
  /** Number of active runners after this heartbeat (post-prune snapshot).
   *  Clients use this to scale local throttle windows in degraded mode. */
  active_runners_count?: number;
  server_time: number;
}

export interface UnregisterRunnerRequest {
  holder_id: string;
}

export interface UnregisterRunnerResponse {
  /** ``true`` when the runner existed and was removed; ``false`` for an
   *  unknown holder (silent no-op, mirrors `release_lease`). */
  unregistered: boolean;
  server_time: number;
}

export interface ActiveRunnersResponse {
  /** Live runners after pruning stale entries.  Read-only; the call does
   *  NOT touch ``last_heartbeat`` (so it can be polled at high cadence
   *  by ops dashboards without keeping idle runners alive). */
  active_runners: RunnerInfo[];
  pool_hash_summary: Array<{ hash: string; count: number }>;
  server_time: number;
}
