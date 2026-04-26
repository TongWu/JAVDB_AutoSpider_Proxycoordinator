export interface Env {
  PROXY_DO: DurableObjectNamespace;
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
}

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
  reason: "ok" | "next_available" | "throttle_short" | "throttle_long" | "throttle_extra" | "max_wait_capped";
}

export interface ReportRequest {
  proxy_id: string;
  kind: "cf" | "failure";
}

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
