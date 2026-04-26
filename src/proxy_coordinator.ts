import {
  Env,
  LeaseRequest,
  LeaseResponse,
  ReportRequest,
  ReportResponse,
  ThrottleConfig,
  loadThrottleConfig,
} from "./types";

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
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  private async handleLease(request: Request): Promise<Response> {
    const body = (await request.json()) as LeaseRequest;
    const intendedSleepMs = Math.max(0, Number(body.intended_sleep_ms ?? 0));
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

    const response: LeaseResponse = {
      wait_ms: waitMs,
      penalty_factor: penaltyFactor,
      server_time: now,
      reason,
    };

    this.writeAnalytics(proxyId, "lease", waitMs, penaltyFactor);

    return jsonResponse(response);
  }

  private async handleReport(request: Request): Promise<Response> {
    const body = (await request.json()) as ReportRequest;
    const kind = body.kind === "failure" ? "failure" : "cf";
    const proxyId = String(body.proxy_id ?? "");
    const now = Date.now();

    const state = await this.loadState();
    this.purgeExpired(state, now);

    state.cfEvents.push(now);
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
    return jsonResponse({
      ...state,
      penalty_factor: this.computePenaltyFactor(state, now),
      now,
      config: this.cfg,
    });
  }

  // ---- state helpers -----------------------------------------------------

  private async loadState(): Promise<CoordinatorState> {
    if (this.cached !== null) return this.cached;
    const stored = (await this.state.storage.get<CoordinatorState>("state")) ?? null;
    this.cached = stored ?? {
      nextAvailableAt: 0,
      requestTimestamps: [],
      cfEvents: [],
    };
    return this.cached;
  }

  private async persistState(state: CoordinatorState): Promise<void> {
    this.cached = state;
    await this.state.storage.put("state", state);
  }

  /**
   * Drop timestamps older than the longest window we still care about,
   * so the in-memory deques never grow unbounded.
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
