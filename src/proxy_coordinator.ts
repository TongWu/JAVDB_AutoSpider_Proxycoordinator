import {
  ALERT_SUMMARY_MAX_LEN,
  AlertEvent,
  BAN_SPIKE_WINDOW_MS,
  DEFAULT_CF_AUTO_BAN_ENABLED,
  DEFAULT_CF_AUTO_BAN_THRESHOLD,
  DEFAULT_CF_BAN_TTL_MS,
  DEFAULT_BAN_SPIKE_THRESHOLD,
  DEFAULT_BAN_TTL_MS,
  DEFAULT_HARD_BAN_TTL_MS,
  Env,
  LeaseRequest,
  LeaseResponse,
  PROXY_LATENCY_EMA_ALPHA,
  ProxyHealthSnapshot,
  ReportRequest,
  ReportResponse,
  ThrottleConfig,
  loadThrottleConfig,
} from "./types";
import { recordAndDispatch } from "./alert_dispatcher";

/**
 * Per-proxy coordination state persisted in DO storage.
 *
 * - `nextAvailableAt`: ms epoch.  No client may issue a request before this
 *   timestamp.  Each granted lease pushes it forward to `now + wait_ms`.
 * - `requestTimestamps`: monotonically ordered ms epochs of *granted* requests
 *   within the longest tracking window (`extraWindowSec`).  Three windows
 *   (short / long / extra) are derived from this single deque to mirror
 *   `TripleWindowThrottle.wait_if_needed`.
 * - `cfEvents`: ms epochs of CF / failure events within `penaltyWindowSec`,
 *   used to derive the penalty factor.  Mirrors Python `PenaltyTracker`.
 *
 * Storage layout: a single key `state` containing the full snapshot.  The
 * payload is small (a few hundred numbers at most) so reading/writing it as
 * one blob is cheaper than indexing each timestamp individually, and keeps
 * the DO well below the per-day rows-read/written quotas on the Free plan.
 */
interface CoordinatorState {
  nextAvailableAt: number;
  requestTimestamps: number[];
  cfEvents: number[];
  /**
   * ADR-043 D2 — CF-only reports used for auto-ban escalation. `failure`
   * reports still feed `cfEvents` for historical penalty behavior, but must not
   * count toward the CF auto-ban threshold.
   */
  cfAutoBanEvents: number[];
  /**
   * P1-A — cross-runner proxy ban state.  ``null`` means "not banned".  When
   * ``bannedUntil > now`` the lease handler still computes ``wait_ms`` (so old
   * Python clients that ignore the boolean still throttle correctly) but flags
   * ``banned: true`` + ``reason: "banned"`` so new clients can short-circuit.
   * Defaults to ``null`` for backward compatibility with snapshots persisted
   * before this field existed (see ``loadState``).
   */
  bannedUntil: number | null;
  /**
   * ADR-043 D5 — short machine-readable reason for the active ban, surfaced
   * through `/state` for ops visibility. `null` means no attributed ban reason.
   */
  bannedReason: string | null;
  /**
   * P1-A — cross-runner CF-bypass requirement.  Mirrors the per-process
   * ``state.proxies_requiring_cf_bypass`` dict semantics:
   *   ``null``  → no requirement
   *   ``> now`` → requirement active until that wall-clock ms epoch
   *   ``0``     → permanent for this session (mirrors
   *               ``state.always_bypass_time == 0`` on the Python side).
   */
  cfBypassUntil: number | null;
  /**
   * P2-D — wall-clock ms epochs of recent successful requests, pruned
   * against ``penaltyWindowSec`` on every ``loadState`` so the count
   * is naturally bounded by the throughput of the proxy * window
   * size.  Defaults to ``[]`` for snapshots written before P2-D.
   */
  successEvents: number[];
  /**
   * P2-D — wall-clock ms epochs of recent HTTP failures.  Distinct
   * from ``cfEvents`` because the latter feeds into the penalty
   * factor (Python side scaled by tier); we want a separate counter
   * so a runner that only reports ``"failure"`` (no CF) still
   * influences the health score.  Same pruning policy as
   * ``successEvents``.
   */
  failureEvents: number[];
  /**
   * P2-D — exponentially-weighted moving average of recent HTTP
   * latency reports (ms).  ``0`` when no latency report has ever
   * landed for this proxy.  Updated on every ``ReportRequest`` that
   * carries a ``latency_ms`` regardless of ``kind`` so success and
   * failure latencies both influence the EMA.
   */
  latencyEma: number;
  /**
   * Phase-1 ADR-008 — wall-clock ms epochs of every `ban` event accepted
   * by `handleReport`. Pruned against {@link BAN_SPIKE_WINDOW_MS} on
   * every `loadState` so the buffer stays bounded by 1h of activity.
   * Drives the `ban_spike` alert: when the count crosses
   * `ban_spike_threshold` (config DO override, default
   * {@link DEFAULT_BAN_SPIKE_THRESHOLD}) the DO emits one alert per
   * hour-bucket via {@link recordAndDispatch}.
   */
  banEvents: number[];
  /**
   * Phase-1 ADR-008 — last hour-bucket (`floor(now / BAN_SPIKE_WINDOW_MS)`)
   * for which we already emitted a `ban_spike` alert. Prevents alert
   * flapping while the rolling count stays above threshold; the next
   * bucket gets a fresh alert if the spike persists.
   */
  banSpikeAlertedBucket: number;
}

/** Read `BAN_TTL_MS` from env vars; falls back to 3 days. */
function loadBanTtlMs(env: Env): number {
  const v = env.BAN_TTL_MS;
  if (v === undefined || v === "") return DEFAULT_BAN_TTL_MS;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BAN_TTL_MS;
}

/** ADR-043 — read the CF auto-ban kill-switch. Defaults ON. */
export function loadCfAutoBanEnabled(env: Env): boolean {
  const v = env.CF_AUTO_BAN_ENABLED;
  if (v === undefined || v === "") return DEFAULT_CF_AUTO_BAN_ENABLED;
  return v !== "false" && v !== "0";
}

/** ADR-043 — read the CF auto-ban event threshold. Defaults to 6. */
export function loadCfAutoBanThreshold(env: Env): number {
  const v = env.CF_AUTO_BAN_THRESHOLD;
  if (v === undefined || v === "") return DEFAULT_CF_AUTO_BAN_THRESHOLD;
  const n = Number(v);
  const threshold = Math.floor(n);
  return Number.isFinite(n) && threshold > 0 ? threshold : DEFAULT_CF_AUTO_BAN_THRESHOLD;
}

/** ADR-043 — read the short CF auto-ban TTL. Defaults to 6 hours. */
export function loadCfBanTtlMs(env: Env): number {
  const v = env.CF_BAN_TTL_MS;
  if (v === undefined || v === "") return DEFAULT_CF_BAN_TTL_MS;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CF_BAN_TTL_MS;
}

/** ADR-043 D9 — read the hard-ban TTL. Defaults to 8 days. */
function loadHardBanTtlMs(env: Env): number {
  const v = env.HARD_BAN_TTL_MS;
  if (v === undefined || v === "") return DEFAULT_HARD_BAN_TTL_MS;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_HARD_BAN_TTL_MS;
}

/** ADR-043 D9 — resolve the ban TTL by reason when the caller omits ttl_ms. */
function ttlForBanReason(reason: string | undefined, env: Env): number {
  const r = (reason ?? "").toLowerCase();
  if (r.includes("ban page")) return loadHardBanTtlMs(env);
  if (r.includes("cf bypass failed")) return loadCfBanTtlMs(env);
  return loadBanTtlMs(env);
}

/** Phase-1 ADR-008 — read the ban-spike threshold. Currently sourced from
 *  the wrangler `BAN_SPIKE_THRESHOLD` env var; the ConfigState override
 *  (key `ban_spike_threshold`) is applied at the dispatcher level by
 *  reading ConfigState — but for the hot per-proxy ban path we use the
 *  env-var default to avoid an extra DO round-trip on every ban report. */
function loadBanSpikeThreshold(env: Env): number {
  const raw = (env as { BAN_SPIKE_THRESHOLD?: string }).BAN_SPIKE_THRESHOLD;
  if (raw === undefined || raw === "") return DEFAULT_BAN_SPIKE_THRESHOLD;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_BAN_SPIKE_THRESHOLD;
}

const PENALTY_TIERS: Array<[number, number]> = [
  [1, 1.3],
  [2, 1.65],
  [4, 2.0],
];

/** Cap on how long a single `lease` call may extend `wait_ms`.  Prevents a
 * pathological caller from being told to sleep for hours when the windows
 * are saturated.  Mirrors Python `THROTTLE_MAX_WAIT = 60.0` plus the
 * caller's own `intended_sleep_ms`, but is enforced server-side as a
 * defensive ceiling. */
const MAX_LEASE_WAIT_MS = 5 * 60 * 1000;

export class ProxyCoordinator implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private cfg: ThrottleConfig;
  /**
   * In-memory cached state.  DO instances are single-threaded per id, so
   * we can safely read once on first request and only persist on writes.
   */
  private cached: CoordinatorState | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.cfg = loadThrottleConfig(env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/do/lease":
          return await this.handleLease(request);
        case "/do/report":
          return await this.handleReport(request);
        case "/do/state":
          return await this.handleStateDump();
        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (err) {
      // Log the raw exception to Workers logs only — never echo it to
      // the caller. DO internals can throw with SQL / storage paths
      // that an external observer should not see.
      const message = err instanceof Error ? err.message : String(err);
      console.error("ProxyCoordinator DO handler error", {
        path: url.pathname,
        error: message,
      });
      return new Response(JSON.stringify({ error: "internal_error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  private async handleLease(request: Request): Promise<Response> {
    const body = (await request.json()) as LeaseRequest;
    // B.14 (2026-05-12): explicit finite + range validation. The previous
    // ``Math.max(0, Number(undefined ?? 0))`` form silently coerced NaN
    // (e.g. from a JSON string) to 0 and accepted unbounded large numbers
    // that ``MAX_LEASE_WAIT_MS`` then clamped — but the resulting
    // ``waitMs`` arithmetic still passed through ``Number.MAX_VALUE``
    // territory and could overflow the in-storage ``requestTimestamps``
    // accumulator on a malicious caller. Reject upfront with 400.
    const rawIntended = body.intended_sleep_ms;
    let intendedSleepMs: number;
    if (rawIntended === undefined || rawIntended === null) {
      intendedSleepMs = 0;
    } else {
      const n = Number(rawIntended);
      if (!Number.isFinite(n) || n < 0 || n > MAX_LEASE_WAIT_MS) {
        return jsonResponse(
          {
            error: "invalid_intended_sleep_ms",
            max_intended_sleep_ms: MAX_LEASE_WAIT_MS,
          },
          400,
        );
      }
      intendedSleepMs = Math.floor(n);
    }
    const proxyId = String(body.proxy_id ?? "");

    const now = Date.now();
    const state = await this.loadState();

    this.purgeExpired(state, now);

    let waitMs = Math.max(intendedSleepMs, state.nextAvailableAt - now);
    let reason: LeaseResponse["reason"] =
      state.nextAvailableAt - now > intendedSleepMs ? "next_available" : "ok";

    /**
     * Apply the three-window throttle: each window must have spare capacity.
     * `candidateAt = now + waitMs` is the earliest moment we can grant the
     * slot.  If any window would still be saturated at that moment, slide
     * `waitMs` forward to the first time a slot frees up.  Bound by
     * `MAX_LEASE_WAIT_MS`.
     */
    for (let iter = 0; iter < 32; iter++) {
      const candidateAt = now + waitMs;
      const slide = this.computeWindowSlide(state, candidateAt);
      if (slide.deltaMs <= 0) {
        if (slide.reason !== "ok") reason = slide.reason;
        break;
      }
      if (waitMs + slide.deltaMs > MAX_LEASE_WAIT_MS) {
        waitMs = MAX_LEASE_WAIT_MS;
        reason = "max_wait_capped";
        break;
      }
      waitMs += slide.deltaMs;
      reason = slide.reason;
    }

    const jitterMs = this.cfg.jitterMaxMs > 0 ? Math.floor(Math.random() * this.cfg.jitterMaxMs) : 0;
    waitMs += jitterMs;
    if (waitMs > MAX_LEASE_WAIT_MS) waitMs = MAX_LEASE_WAIT_MS;
    if (waitMs < 0) waitMs = 0;

    const grantedAt = now + waitMs;
    state.nextAvailableAt = grantedAt;
    state.requestTimestamps.push(grantedAt);

    await this.persistState(state);

    const penaltyFactor = this.computePenaltyFactor(state, now);

    // P1-A — once the proxy is banned, surface ``reason: "banned"`` so new
    // clients short-circuit the request loop. Old clients that ignore the
    // boolean still see a normal ``wait_ms`` (computed above) so behaviour
    // remains backwards-compatible.
    const banned = state.bannedUntil !== null && state.bannedUntil > now;
    if (banned) {
      reason = "banned";
    }
    const requiresCfBypass =
      state.cfBypassUntil !== null &&
      (state.cfBypassUntil === 0 || state.cfBypassUntil > now);

    const response: LeaseResponse = {
      wait_ms: waitMs,
      penalty_factor: penaltyFactor,
      server_time: now,
      reason,
      banned,
      banned_until: state.bannedUntil,
      requires_cf_bypass: requiresCfBypass,
      cf_bypass_until: state.cfBypassUntil,
      health: this.computeHealthSnapshot(state),
    };

    this.writeAnalytics(proxyId, "lease", waitMs, penaltyFactor);

    return jsonResponse(response);
  }

  private async handleReport(request: Request): Promise<Response> {
    const body = (await request.json()) as ReportRequest;
    const proxyId = String(body.proxy_id ?? "");
    const now = Date.now();
    const rawKind = body.kind;

    // Q3 / sibling-plan P0-1 (2026-05-12): reject unknown ``kind`` values
    // upfront. The default ``else`` branch below treats anything we don't
    // recognise as ``"cf"`` for backward compat, which silently inflated
    // ``cfEvents`` (and thus ``penalty_factor``) whenever a Python client
    // shipped a typo'd ``rawKind`` like ``"succss"`` or ``"failuer"``. A
    // 400 surfaces the bug at the caller instead of letting it tax
    // every subsequent lease for the duration of ``penaltyWindowSec``.
    const ALLOWED_KINDS: ReadonlySet<string> = new Set([
      "success", "failure", "cf", "ban", "unban", "cf_bypass",
    ]);
    if (rawKind !== undefined && rawKind !== null && !ALLOWED_KINDS.has(rawKind as string)) {
      return jsonResponse(
        {
          error: "invalid_kind",
          allowed_kinds: Array.from(ALLOWED_KINDS).sort(),
        },
        400,
      );
    }

    const state = await this.loadState();
    this.purgeExpired(state, now);

    // P2-D — fold latency into the EMA regardless of kind so a slow
    // success and a slow failure both pull the EMA up.  Done before
    // the kind-specific dispatch so even an unknown kind contributes
    // to the health latency picture.
    const rawLatency = body.latency_ms;
    if (
      rawLatency !== undefined &&
      rawLatency !== null &&
      Number.isFinite(rawLatency as number) &&
      (rawLatency as number) >= 0
    ) {
      const sample = Number(rawLatency);
      const prior = state.latencyEma;
      state.latencyEma =
        prior === 0
          ? sample
          : prior * (1 - PROXY_LATENCY_EMA_ALPHA) + sample * PROXY_LATENCY_EMA_ALPHA;
    }

    // P1-A — ban / unban / cf_bypass are *out-of-band* kinds: they mutate the
    // ban / cf_bypass state but do NOT push into ``cfEvents`` (which would
    // double-count an already-throttled proxy through the penalty factor).
    let kind: "cf" | "failure" | "ban" | "unban" | "cf_bypass" | "success" = "cf";
    if (rawKind === "ban") {
      kind = "ban";
      const ttl = Number.isFinite(body.ttl_ms as number) && (body.ttl_ms as number) > 0
        ? Number(body.ttl_ms)
        : ttlForBanReason(body.reason, this.env);
      // Take the max of any existing ban so concurrent runners can't shorten
      // a longer ban; matches the plan's "TTL 取最大值" guidance.
      const newBannedUntil = now + ttl;
      const shouldUpdateBan =
        state.bannedUntil === null || state.bannedUntil <= newBannedUntil;
      if (shouldUpdateBan) {
        state.bannedUntil = newBannedUntil;
        const r = (body.reason ?? "").toString().toLowerCase();
        state.bannedReason = r.includes("ban page")
          ? "javdb_hardban"
          : r.includes("cf bypass failed")
            ? "cf_auto"
            : "manual";
      }
      // Phase-1 ADR-008 — record the ban event for spike detection.
      state.banEvents.push(now);
      await this.maybeEmitBanSpikeAlert(proxyId, state, now, body.reason);
    } else if (rawKind === "unban") {
      kind = "unban";
      state.bannedUntil = null;
      state.bannedReason = null;
    } else if (rawKind === "cf_bypass") {
      kind = "cf_bypass";
      // ``ttl_ms`` honours the same tri-state as `state.always_bypass_time`:
      //   - ``0``  → permanent for this session (sentinel; persisted as `0`)
      //   - ``>0`` → expires at ``now + ttl``
      //   - omitted → treat as permanent for safety
      const rawTtl = body.ttl_ms;
      if (rawTtl === undefined || rawTtl === null) {
        // Once permanent, stay permanent. Otherwise upgrade to permanent.
        state.cfBypassUntil = 0;
      } else if (state.cfBypassUntil === 0) {
        // Sticky permanent: a finite-TTL refresh after a permanent flag must
        // NOT downgrade the proxy's bypass requirement.
        state.cfBypassUntil = 0;
      } else {
        const ttl = Number(rawTtl);
        if (!Number.isFinite(ttl) || ttl <= 0) {
          state.cfBypassUntil = 0;
        } else {
          const newCfBypassUntil = now + ttl;
          // Monotonic-max policy: prefer the longer of the two finite windows.
          state.cfBypassUntil =
            state.cfBypassUntil !== null &&
              state.cfBypassUntil > newCfBypassUntil
              ? state.cfBypassUntil
              : newCfBypassUntil;
        }
      }
    } else if (rawKind === "failure") {
      kind = "failure";
      state.cfEvents.push(now);
      // P2-D — track failure separately from cfEvents so a runner that
      // only reports plain ``failure`` (no CF challenge) still moves
      // the health needle.  cfEvents already mirrors this when CF
      // attribution is present, but health needs the broader signal.
      state.failureEvents.push(now);
    } else if (rawKind === "success") {
      // P2-D — happy-path counter for the health scorer.  Does NOT
      // touch cfEvents (so a successful request never deflates the
      // penalty factor) and does NOT touch bannedUntil / cfBypass.
      kind = "success";
      state.successEvents.push(now);
    } else {
      // Any unknown kind (including the historical default ``"cf"``) is treated
      // as a CF event for backward compatibility.
      kind = "cf";
      state.cfEvents.push(now);
      state.cfAutoBanEvents.push(now);
      this.maybeCfAutoBan(state, now);
    }

    await this.persistState(state);

    const penaltyFactor = this.computePenaltyFactor(state, now);
    const response: ReportResponse = {
      penalty_factor: penaltyFactor,
      recent_event_count: state.cfEvents.length,
      server_time: now,
    };

    this.writeAnalytics(proxyId, `report_${kind}`, 0, penaltyFactor);

    return jsonResponse(response);
  }

  /** Internal-only debug endpoint.  Returns the full DO state for tests
   * and operators inspecting why a particular proxy is throttled. */
  private async handleStateDump(): Promise<Response> {
    const state = await this.loadState();
    const now = Date.now();
    this.purgeExpired(state, now);
    // Surface the *current* effective ban / cf_bypass status so operators don't
    // have to recompute it from raw timestamps. Mirrors the booleans returned
    // by ``handleLease`` so the two views agree.
    const banned = state.bannedUntil !== null && state.bannedUntil > now;
    const requiresCfBypass =
      state.cfBypassUntil !== null &&
      (state.cfBypassUntil === 0 || state.cfBypassUntil > now);
    return jsonResponse({
      ...state,
      penalty_factor: this.computePenaltyFactor(state, now),
      banned,
      requires_cf_bypass: requiresCfBypass,
      health: this.computeHealthSnapshot(state),
      now,
      config: this.cfg,
    });
  }

  /**
   * Phase-1 ADR-008 — emit a `ban_spike` alert when the rolling 1h ban
   * count for this proxy crosses the configured threshold. Idempotent
   * per hour-bucket: a sustained spike emits one alert per hour, not
   * once per ban.
   */
  private async maybeEmitBanSpikeAlert(
    proxyId: string,
    state: CoordinatorState,
    now: number,
    reason: string | undefined,
  ): Promise<void> {
    const threshold = loadBanSpikeThreshold(this.env);
    if (state.banEvents.length < threshold) return;
    const bucket = Math.floor(now / BAN_SPIKE_WINDOW_MS);
    if (state.banSpikeAlertedBucket === bucket) return;
    state.banSpikeAlertedBucket = bucket;
    const alert: AlertEvent = {
      id: `banspike-${proxyId}-${bucket}`,
      kind: "ban_spike",
      ts: now,
      severity: "warning",
      summary: (
        `Proxy ${proxyId} ban spike: ${state.banEvents.length} bans in last 1h ` +
        `(threshold ${threshold})`
      ).slice(0, ALERT_SUMMARY_MAX_LEN),
      details: {
        proxy_id: proxyId,
        ban_count_1h: state.banEvents.length,
        threshold,
        latest_reason: reason ?? "",
      },
    };
    try {
      await recordAndDispatch(this.env, alert);
    } catch (err) {
      console.warn("ban_spike alert dispatch error", {
        proxy_id: proxyId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---- state helpers -----------------------------------------------------

  private async loadState(): Promise<CoordinatorState> {
    if (this.cached !== null) return this.cached;
    const stored = (await this.state.storage.get<Partial<CoordinatorState>>("state")) ?? null;
    // Always normalise the loaded payload so snapshots written *before* the
    // P1-A fields existed still satisfy the current `CoordinatorState` shape.
    // This is the explicit cached-invalidation point called out in the plan
    // (see `proxy_coordinator.ts:188-201`).
    this.cached = {
      nextAvailableAt: stored?.nextAvailableAt ?? 0,
      requestTimestamps: stored?.requestTimestamps ?? [],
      cfEvents: stored?.cfEvents ?? [],
      cfAutoBanEvents: stored?.cfAutoBanEvents ?? [],
      bannedUntil: stored?.bannedUntil ?? null,
      bannedReason: stored?.bannedReason ?? null,
      cfBypassUntil: stored?.cfBypassUntil ?? null,
      successEvents: stored?.successEvents ?? [],
      failureEvents: stored?.failureEvents ?? [],
      latencyEma: stored?.latencyEma ?? 0,
      banEvents: stored?.banEvents ?? [],
      banSpikeAlertedBucket: stored?.banSpikeAlertedBucket ?? 0,
    };
    return this.cached;
  }

  private async persistState(state: CoordinatorState): Promise<void> {
    // Write to storage BEFORE updating the in-memory cache: if the put
    // throws (DO storage transient failure, quota, eviction race), the
    // cache must keep showing the previous-committed snapshot rather than
    // a phantom view of writes that never durably landed. Subsequent
    // requests would otherwise short-circuit on the dirty cache and
    // believe state was persisted when storage holds the older value.
    await this.state.storage.put("state", state);
    this.cached = state;
  }

  /**
   * Drop timestamps older than the longest window we still care about,
   * so the in-memory deques never grow unbounded.  P2-D `successEvents`
   * and `failureEvents` share the same `penaltyWindowSec` cutoff as
   * `cfEvents` so health is computed against the same horizon as the
   * penalty factor — keeps the health/penalty semantics aligned.
   */
  private purgeExpired(state: CoordinatorState, now: number): void {
    const reqCutoff = now - this.cfg.extraWindowSec * 1000;
    while (state.requestTimestamps.length > 0 && state.requestTimestamps[0] < reqCutoff) {
      state.requestTimestamps.shift();
    }
    const cfCutoff = now - this.cfg.penaltyWindowSec * 1000;
    while (state.cfEvents.length > 0 && state.cfEvents[0] < cfCutoff) {
      state.cfEvents.shift();
    }
    while (state.cfAutoBanEvents.length > 0 && state.cfAutoBanEvents[0] < cfCutoff) {
      state.cfAutoBanEvents.shift();
    }
    while (state.successEvents.length > 0 && state.successEvents[0] < cfCutoff) {
      state.successEvents.shift();
    }
    while (state.failureEvents.length > 0 && state.failureEvents[0] < cfCutoff) {
      state.failureEvents.shift();
    }
    // Phase-1 ADR-008 — prune ban events outside the spike detection window.
    const banCutoff = now - BAN_SPIKE_WINDOW_MS;
    while (state.banEvents.length > 0 && state.banEvents[0] < banCutoff) {
      state.banEvents.shift();
    }
    // P1-A / ADR-043 — auto-expire ban / cf_bypass state before it is
    // surfaced. `cfBypassUntil === 0` is the "permanent for this session"
    // sentinel and must NOT be pruned. Ban attribution belongs to the active
    // ban only; clear it once the ban window expires.
    if (state.bannedUntil !== null && state.bannedUntil <= now) {
      state.bannedUntil = null;
      state.bannedReason = null;
    }
    if (
      state.cfBypassUntil !== null &&
      state.cfBypassUntil !== 0 &&
      state.cfBypassUntil <= now
    ) {
      state.cfBypassUntil = null;
    }
  }

  /**
   * P2-D — derive the public health snapshot from the persisted
   * primitives.  Score is a normalized success ratio in 0..1 with a
   * linearised latency penalty (each 1000ms over the 500ms baseline
   * shaves 0.1 off the score, capped at 0).  No data → neutral 0.5
   * so a brand-new proxy is neither favored nor punished.
   */
  private computeHealthSnapshot(state: CoordinatorState): ProxyHealthSnapshot {
    const successCount = state.successEvents.length;
    const failureCount = state.failureEvents.length;
    const total = successCount + failureCount;
    let score: number;
    if (total === 0) {
      score = 0.5;
    } else {
      // Success ratio in [0, 1].
      const ratio = successCount / total;
      // Latency penalty: each 1000ms above 500ms removes 0.1.  EMA of 0
      // (no data yet) is treated as the 500ms baseline so a healthy
      // proxy with low success-count isn't double-penalised.
      const ema = state.latencyEma > 0 ? state.latencyEma : 500;
      const latencyPenalty = Math.max(0, (ema - 500) / 1000) * 0.1;
      score = Math.max(0, Math.min(1, ratio - latencyPenalty));
    }
    return {
      success_count: successCount,
      failure_count: failureCount,
      latency_ema_ms: state.latencyEma,
      score,
    };
  }

  /**
   * Given a candidate grant time, return the smallest forward slide (ms)
   * that satisfies all three windows.  Returns `deltaMs = 0` when the
   * candidate already fits.  Picks the latest "free at" timestamp across
   * all saturated windows and slides to that.
   */
  private computeWindowSlide(
    state: CoordinatorState,
    candidateAt: number,
  ): { deltaMs: number; reason: LeaseResponse["reason"] } {
    const ts = state.requestTimestamps;
    let deltaMs = 0;
    let reason: LeaseResponse["reason"] = "ok";

    const checks: Array<{ window: number; max: number; tag: LeaseResponse["reason"] }> = [
      { window: this.cfg.shortWindowSec * 1000, max: this.cfg.shortMax, tag: "throttle_short" },
      { window: this.cfg.longWindowSec * 1000, max: this.cfg.longMax, tag: "throttle_long" },
      { window: this.cfg.extraWindowSec * 1000, max: this.cfg.extraMax, tag: "throttle_extra" },
    ];

    for (const { window, max, tag } of checks) {
      const cutoff = candidateAt - window;
      let count = 0;
      let oldestInWindow = Infinity;
      for (let i = ts.length - 1; i >= 0; i--) {
        const t = ts[i];
        if (t < cutoff) break;
        count++;
        oldestInWindow = t;
      }
      if (count >= max) {
        // Earliest moment a slot opens: when the oldest in-window timestamp
        // ages out of the window (i.e. its age becomes >= window).
        const slotOpensAt = oldestInWindow + window + 1;
        const need = slotOpensAt - candidateAt;
        if (need > deltaMs) {
          deltaMs = need;
          reason = tag;
        }
      }
    }

    return { deltaMs, reason };
  }

  private computePenaltyFactor(state: CoordinatorState, now: number): number {
    const cutoff = now - this.cfg.penaltyWindowSec * 1000;
    const count = state.cfEvents.filter((t) => t >= cutoff).length;
    let factor = 1.0;
    for (const [threshold, f] of PENALTY_TIERS) {
      if (count >= threshold) factor = f;
    }
    return factor;
  }

  private maybeCfAutoBan(state: CoordinatorState, now: number): void {
    if (!loadCfAutoBanEnabled(this.env)) return;
    if (state.cfAutoBanEvents.length < loadCfAutoBanThreshold(this.env)) return;
    if (state.successEvents.length !== 0) return;

    const newBannedUntil = now + loadCfBanTtlMs(this.env);
    if (state.bannedUntil === null || state.bannedUntil <= newBannedUntil) {
      state.bannedUntil = newBannedUntil;
      state.bannedReason = "cf_auto";
    }
  }

  private writeAnalytics(
    proxyId: string,
    op: string,
    waitMs: number,
    penaltyFactor: number,
  ): void {
    if (!this.env.LEASE_ANALYTICS) return;
    try {
      this.env.LEASE_ANALYTICS.writeDataPoint({
        blobs: [proxyId, op],
        doubles: [waitMs, penaltyFactor],
        indexes: [proxyId],
      });
    } catch {
      // Analytics Engine is best-effort; never fail a lease over telemetry.
    }
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
