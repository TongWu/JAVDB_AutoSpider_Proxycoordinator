export interface Env {
  PROXY_DO: DurableObjectNamespace;
  GLOBAL_LOGIN_STATE_DO: DurableObjectNamespace;
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
