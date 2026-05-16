import {
  AcquireLeaseRequest,
  AcquireLeaseResponse,
  DEFAULT_LOGIN_COOLDOWN_DURATION_MS,
  DEFAULT_LOGIN_COOLDOWN_THRESHOLD,
  DEFAULT_LOGIN_COOLDOWN_WINDOW_SEC,
  Env,
  InvalidateRequest,
  InvalidateResponse,
  LoginStateGetResponse,
  LOGIN_LEASE_TTL_MAX_MS,
  LOGIN_LEASE_TTL_MIN_MS,
  PublishRequest,
  PublishResponse,
  RECENT_ATTEMPTS_MAX_LEN,
  RecordAttemptOutcome,
  RecordAttemptRequest,
  RecordAttemptResponse,
  ReleaseLeaseRequest,
  ReleaseLeaseResponse,
} from "./types";

/**
 * GlobalLoginState — singleton DO that arbitrates a single shared JavDB
 * login session across multiple GitHub Actions runners.
 *
 * Addressed by ``idFromName("global")`` from {@link forwardToGlobalLoginStateDo}
 * in {@link ./index.ts}.  Coexists with {@link ProxyCoordinator} (per-proxy
 * throttling DO); the two never share storage and are wired through separate
 * `[[durable_objects.bindings]]` entries in `wrangler.toml`.
 *
 * State machine (single-key snapshot in DO storage; mirrors `ProxyCoordinator`):
 *
 * - `proxy_name` / `cookie_ciphertext`: the active session.  Encrypted at rest
 *   with AES-GCM; key derived from {@link Env.PROXY_COORDINATOR_TOKEN} via
 *   HKDF-SHA256 so rotating the token invalidates the cookie automatically
 *   (treated as "no cookie" on next get; next runner re-logs in).
 * - `version`: monotonic; bumped by every `publish` *and* every successful
 *   `invalidate`.  Clients pass it back in {@link InvalidateRequest} as an
 *   optimistic lock so a stale invalidation cannot wipe a freshly-published
 *   cookie.
 * - `last_verified_at`: ms epoch of the last `publish`.  Surfaced in
 *   `/login_state/get` for ops dashboards.
 * - `lease`: at-most-one mutex serialising re-login attempts across runners.
 *   `acquire_lease` enforces TTL clamping; expired leases are auto-reclaimed
 *   on the next `acquire`.
 */

interface LoginLease {
  holder_id: string;
  target_proxy_name: string;
  expires_at: number;
}

/**
 * P2-C — single login attempt record kept in
 * {@link GlobalLoginStateData.recent_attempts}.  Stored verbatim so ops
 * can dump the buffer for diagnostics; the cooldown function only
 * inspects ``at`` + ``outcome``.
 */
interface LoginAttemptRecord {
  /** Wall-clock ms epoch when the attempt was recorded. */
  at: number;
  /** Proxy that performed (or attempted) the login.  Free-form string
   *  capped to ``RUNNER_FIELD_MAX_LEN``-equivalent length on input. */
  proxy_name: string;
  outcome: RecordAttemptOutcome;
  /** Caller-side opaque identity; ops only. */
  holder_id: string;
}

interface GlobalLoginStateData {
  proxy_name: string | null;
  /**
   * AES-GCM ciphertext as ``base64url(iv ‖ ct)``.  Stored as a single string
   * to avoid two extra storage rows per snapshot read/write.  ``null`` means
   * "no published cookie"; an undecryptable value (e.g. after token rotation)
   * is also surfaced as ``cookie:null`` to callers — see :meth:`handleGet`.
   */
  cookie_ciphertext: string | null;
  version: number;
  last_verified_at: number;
  lease: LoginLease | null;
  /**
   * P2-C — sliding window of the most recent login attempts.  Pruned on
   * every read against ``LOGIN_COOLDOWN_WINDOW_SEC``; capped at
   * ``RECENT_ATTEMPTS_MAX_LEN`` entries to defend against a hot-loop
   * caller.  Optional in storage so old snapshots written before P2-C
   * round-trip cleanly through ``loadState``.
   */
  recent_attempts?: LoginAttemptRecord[];
}

const STORAGE_KEY = "state";
const IV_BYTES = 12;
const HKDF_SALT = new TextEncoder().encode("global-login-state-v1");
const HKDF_INFO = new TextEncoder().encode("aes-gcm-key");

/**
 * Cap on the cookie payload accepted by ``publish``.  16 KiB comfortably fits
 * a JavDB ``_jdb_session`` cookie (~120 bytes) plus any future expansion,
 * while protecting the DO from a misconfigured caller storing megabytes.
 */
const MAX_COOKIE_BYTES = 16 * 1024;

export class GlobalLoginState implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  /**
   * Lazily-derived AES-GCM key.  ``crypto.subtle.deriveKey`` is ~1-2 ms on
   * the Workers runtime; caching avoids paying it per request once the DO
   * instance is warm.  The key is bound to {@link Env.PROXY_COORDINATOR_TOKEN}:
   * rotating the token zeros out this cache *only* for new DO instances, so
   * old DO instances may still decrypt with the old key until they evict.
   * That's fine — readers either get a valid cookie (decrypted with the old
   * key) or `null` (decrypt failure on a re-keyed instance), and the worst
   * case is one forced re-login.
   *
   * NOTE: We deliberately do NOT cache the snapshot itself (the equivalent
   * of ``ProxyCoordinator.cached``).  GlobalLoginState is a singleton DO
   * (`idFromName("global")`) and must round-trip storage on every request;
   * caching here would also break vitest-pool-workers' isolated-storage
   * stack-frame cleanup of the SQLite WAL ``-shm`` file across tests.
   * Per-request storage reads are cheap (single key, single row) and the
   * mutex-via-lease design means writes are coarse-grained anyway.
   */
  private cachedKey: CryptoKey | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Phase 2 / ADR-002 — login_event_log: lifecycle events for the
    // shared JavDB session cookie. Retention 30 days.
    // Note: holder_id_key is a non-nullable alias for holder_id used in the
    // PK (empty string when holder_id is NULL) so Cloudflare Workers SQLite
    // (which forbids expressions like COALESCE in PK definitions) can still
    // enforce uniqueness per (ts, event_kind, holder).
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS login_event_log (
        ts INTEGER NOT NULL,
        event_kind TEXT NOT NULL,
        holder_id TEXT,
        holder_id_key TEXT NOT NULL DEFAULT '',
        outcome TEXT,
        cookie_version INTEGER,
        detail TEXT,
        PRIMARY KEY (ts, event_kind, holder_id_key)
      );
    `);
    this.state.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_login_event_log_holder
      ON login_event_log(holder_id, ts);
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/do/login_state/get":
          return await this.handleGet();
        case "/do/login_state/acquire_lease":
          return await this.handleAcquireLease(request);
        case "/do/login_state/publish":
          return await this.handlePublish(request);
        case "/do/login_state/invalidate":
          return await this.handleInvalidate(request);
        case "/do/login_state/release_lease":
          return await this.handleReleaseLease(request);
        case "/do/login_state/record_attempt":
          return await this.handleRecordAttempt(request);
        case "/do/login/history":
          return await this.handleLoginHistory(request);
        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (err) {
      // Log to Workers logs; don't echo raw err.message (may contain
      // ciphertext fragments / SQL).
      const message = err instanceof Error ? err.message : String(err);
      console.error("GlobalLoginState DO handler error", {
        path: url.pathname,
        error: message,
      });
      return jsonResponse({ error: "internal_error" }, 500);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Endpoint handlers
  // ─────────────────────────────────────────────────────────────────────────

  private async handleGet(): Promise<Response> {
    const now = Date.now();
    const data = await this.loadState();
    let cookie: string | null = null;
    if (data.cookie_ciphertext) {
      try {
        cookie = await this.decrypt(data.cookie_ciphertext);
      } catch {
        // Treat undecryptable values (e.g. after PROXY_COORDINATOR_TOKEN
        // rotation) as "no cookie" so the next runner triggers a clean
        // re-login instead of failing every request.
        cookie = null;
      }
    }
    const response: LoginStateGetResponse = {
      proxy_name: data.proxy_name,
      cookie,
      version: data.version,
      last_verified_at: data.last_verified_at,
      has_active_lease: data.lease !== null && now < data.lease.expires_at,
      server_time: now,
    };
    return jsonResponse(response);
  }

  private async handleAcquireLease(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<AcquireLeaseRequest>;
    const holderId = String(body.holder_id ?? "").trim();
    const targetProxy = String(body.target_proxy_name ?? "").trim();
    if (!holderId) {
      return jsonResponse(
        { error: "missing holder_id or target_proxy_name" },
        400,
      );
    }
    const ttlMs = clampTtlMs(Number(body.ttl_ms ?? 0));

    const now = Date.now();
    const data = await this.loadState();

    // P2-C: prune stale attempt records on every acquire (cheap, single
    // pass over a bounded buffer) so the cooldown decision below sees
    // only entries inside the configured window.  Persisted only when
    // the lease itself changes — pruning alone doesn't justify a write
    // because next acquire will prune again from scratch.
    const cfg = loadCooldownConfig(this.env);
    const recentAttempts = pruneRecentAttempts(
      data.recent_attempts ?? [],
      now,
      cfg.windowSec,
    );

    const leaseExpired =
      data.lease === null || now >= data.lease.expires_at;
    const sameHolder =
      data.lease !== null &&
      data.lease.holder_id === holderId &&
      data.lease.target_proxy_name === targetProxy;

    let acquired = false;
    if (leaseExpired || sameHolder) {
      // Fresh acquire (no lease / expired) or idempotent renewal by the
      // current holder.  Both write the new expiry and target.
      data.lease = {
        holder_id: holderId,
        target_proxy_name: targetProxy,
        expires_at: now + ttlMs,
      };
      // Persist the pruned buffer alongside the lease change so we never
      // grow recent_attempts unboundedly across acquires.
      data.recent_attempts = recentAttempts;
      await this.persistState(data);
      acquired = true;

      // Phase 2 / ADR-002 — login_event_log: lease_acquire
      this.state.storage.sql.exec(
        `INSERT OR REPLACE INTO login_event_log (ts, event_kind, holder_id, holder_id_key, detail)
         VALUES (?, 'lease_acquire', ?, ?, ?)`,
        now,
        holderId || null,
        holderId || "",
        "lease granted",
      );
    }

    // P2-C cooldown calculation: count failures inside the window; emit
    // ``cooldown_until_ms`` only when the failure count crosses the
    // configured threshold.  We always grant the lease (per the plan's
    // explicit "still granted" contract) — the caller is expected to
    // park its login flow until ``cooldown_until_ms``.
    const failureCount = recentAttempts.reduce(
      (n, a) => (a.outcome === "failure" ? n + 1 : n),
      0,
    );
    const cooldownUntilMs =
      failureCount >= cfg.threshold
        ? computeCooldownUntilMs(recentAttempts, now, cfg.durationMs)
        : 0;

    const response: AcquireLeaseResponse = {
      acquired,
      holder_id: data.lease!.holder_id,
      target_proxy_name: data.lease!.target_proxy_name,
      lease_expires_at: data.lease!.expires_at,
      cooldown_until_ms: cooldownUntilMs,
      recent_attempt_count: recentAttempts.length,
      server_time: now,
    };
    return jsonResponse(response);
  }

  private async handleRecordAttempt(request: Request): Promise<Response> {
    // Accept two shapes:
    //   - New event-log shape: { proxy_id?, success: boolean, holder_id?, detail? }
    //   - Legacy P2-C shape:   { holder_id, proxy_name, outcome }
    // The new shape uses `success` (boolean) and `proxy_id` as aliases so
    // tests and newer callers don't need to know the internal field names.
    const body = (await request.json()) as Partial<RecordAttemptRequest> & {
      proxy_id?: string;
      success?: boolean;
      detail?: string;
    };
    const holderId = String(body.holder_id ?? "").trim();
    // proxy_id is accepted as an alias for proxy_name.
    const proxyName = String(body.proxy_name ?? body.proxy_id ?? "").trim();
    // `success` boolean is accepted as an alias for `outcome`.
    let outcome: RecordAttemptOutcome;
    if (typeof body.success === "boolean") {
      outcome = body.success ? "success" : "failure";
    } else {
      outcome = String(body.outcome ?? "") as RecordAttemptOutcome;
    }
    if (!holderId || !proxyName) {
      return jsonResponse(
        { error: "missing holder_id or proxy_name" },
        400,
      );
    }
    if (outcome !== "success" && outcome !== "failure") {
      return jsonResponse(
        { error: 'outcome must be "success" or "failure"' },
        400,
      );
    }

    const now = Date.now();
    const data = await this.loadState();
    const cfg = loadCooldownConfig(this.env);

    // Append + prune + cap.  The pruning happens before the append so a
    // single flood of records cannot push older legitimate entries out
    // before they would naturally expire from the window.
    const pruned = pruneRecentAttempts(
      data.recent_attempts ?? [],
      now,
      cfg.windowSec,
    );
    pruned.push({
      at: now,
      proxy_name: clipShortString(proxyName),
      outcome,
      holder_id: clipShortString(holderId),
    });
    // Hard cap: drop oldest entries if the buffer somehow exceeds the
    // safety bound (shouldn't happen in practice given window pruning).
    while (pruned.length > RECENT_ATTEMPTS_MAX_LEN) {
      pruned.shift();
    }
    data.recent_attempts = pruned;
    await this.persistState(data);

    // Phase 2 / ADR-002 — login_event_log: attempt
    const detail = typeof body.detail === "string" ? body.detail.slice(0, 500) : null;
    this.state.storage.sql.exec(
      `INSERT OR REPLACE INTO login_event_log (ts, event_kind, holder_id, holder_id_key, outcome, detail)
       VALUES (?, 'attempt', ?, ?, ?, ?)`,
      now,
      holderId || null,
      holderId || "",
      outcome,
      detail,
    );

    const failureCount = pruned.reduce(
      (n, a) => (a.outcome === "failure" ? n + 1 : n),
      0,
    );
    const cooldownUntilMs =
      failureCount >= cfg.threshold
        ? computeCooldownUntilMs(pruned, now, cfg.durationMs)
        : 0;

    const response: RecordAttemptResponse = {
      recent_attempt_count: pruned.length,
      recent_failure_count: failureCount,
      cooldown_until_ms: cooldownUntilMs,
      server_time: now,
    };
    return jsonResponse(response);
  }

  private async handlePublish(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<PublishRequest>;
    const holderId = String(body.holder_id ?? "").trim();
    const proxyName = String(body.proxy_name ?? "").trim();
    const cookie = String(body.cookie ?? "");
    if (!holderId || !proxyName || !cookie) {
      return jsonResponse(
        { error: "missing holder_id, proxy_name, or cookie" },
        400,
      );
    }
    if (cookie.length > MAX_COOKIE_BYTES) {
      return jsonResponse({ error: "cookie too large" }, 413);
    }

    const now = Date.now();
    const data = await this.loadState();

    if (
      data.lease === null ||
      data.lease.holder_id !== holderId ||
      now >= data.lease.expires_at
    ) {
      // Reject the publish so a runner whose lease just expired can't
      // overwrite a freshly-published cookie from the new lease holder.
      return jsonResponse({ error: "lease_required" }, 409);
    }
    if (data.lease.target_proxy_name !== proxyName) {
      // The lease was acquired for ``target_proxy_name`` (the proxy a
      // runner promised to re-login through); a publish that mutates the
      // shared ``proxy_name`` to a *different* proxy would silently
      // corrupt the singleton view because every other runner now thinks
      // the active session belongs to a proxy whose cookie was never
      // verified through this lease. Reject without writing state.
      return jsonResponse(
        {
          error: "proxy_name_mismatch_with_lease",
          lease_target_proxy_name: data.lease.target_proxy_name,
        },
        409,
      );
    }

    const ciphertext = await this.encrypt(cookie);
    data.proxy_name = proxyName;
    data.cookie_ciphertext = ciphertext;
    data.version += 1;
    data.last_verified_at = now;
    // Keep the lease intact: callers should release explicitly so they can
    // run any post-publish verification before relinquishing the mutex.
    await this.persistState(data);

    // Phase 2 / ADR-002 — login_event_log: publish
    this.state.storage.sql.exec(
      `INSERT OR REPLACE INTO login_event_log (ts, event_kind, holder_id, holder_id_key, cookie_version, detail)
       VALUES (?, 'publish', ?, ?, ?, ?)`,
      now,
      holderId || null,
      holderId || "",
      data.version,
      "cookie published",
    );

    const response: PublishResponse = {
      ok: true,
      version: data.version,
      server_time: now,
    };
    return jsonResponse(response);
  }

  private async handleInvalidate(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<InvalidateRequest>;
    const expected = Number(body.version ?? -1);

    const now = Date.now();
    const data = await this.loadState();

    if (!Number.isFinite(expected) || expected !== data.version) {
      // Optimistic lock failed — caller is acting on a stale view.  Hand
      // back the current version so they can resync without retrying.
      const response: InvalidateResponse = {
        invalidated: false,
        current_version: data.version,
        server_time: now,
      };
      return jsonResponse(response);
    }

    data.proxy_name = null;
    data.cookie_ciphertext = null;
    data.version += 1;
    // Intentionally do NOT touch ``last_verified_at`` — keeping it lets ops
    // see how stale the now-invalidated session was.
    // Lease is left alone: invalidate is a "this cookie is bad" signal,
    // independent of who currently holds the right to log in next.
    await this.persistState(data);

    // Phase 2 / ADR-002 — login_event_log: invalidate
    // holder_id is not part of InvalidateRequest (version-locked, not holder-locked)
    this.state.storage.sql.exec(
      `INSERT OR REPLACE INTO login_event_log (ts, event_kind, holder_id, holder_id_key, cookie_version, detail)
       VALUES (?, 'invalidate', ?, '', ?, ?)`,
      now,
      null,
      data.version,
      "cookie invalidated",
    );

    const response: InvalidateResponse = {
      invalidated: true,
      current_version: data.version,
      server_time: now,
    };
    return jsonResponse(response);
  }

  private async handleReleaseLease(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<ReleaseLeaseRequest>;
    const holderId = String(body.holder_id ?? "").trim();
    if (!holderId) {
      return jsonResponse({ error: "missing holder_id" }, 400);
    }

    const now = Date.now();
    const data = await this.loadState();

    let released = false;
    if (data.lease !== null && data.lease.holder_id === holderId) {
      data.lease = null;
      await this.persistState(data);
      released = true;

      // Phase 2 / ADR-002 — login_event_log: lease_release
      this.state.storage.sql.exec(
        `INSERT OR REPLACE INTO login_event_log (ts, event_kind, holder_id, holder_id_key, detail)
         VALUES (?, 'lease_release', ?, ?, ?)`,
        now,
        holderId || null,
        holderId || "",
        "lease released",
      );
    }
    // Non-owner releases are silently ignored (released:false).  Returning
    // 200 keeps clients on the simple fail-open path; the boolean lets them
    // log "lease was already taken over" if interested.

    const response: ReleaseLeaseResponse = {
      released,
      server_time: now,
    };
    return jsonResponse(response);
  }

  private async handleLoginHistory(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return jsonResponse({ error: "method not allowed" }, 405);
    }
    const url = new URL(request.url);
    const from = parseInt(url.searchParams.get("from") ?? "0", 10);
    const to = parseInt(url.searchParams.get("to") ?? `${Date.now()}`, 10);
    const holder = url.searchParams.get("holder_id");
    const baseSql = `SELECT ts, event_kind, holder_id, outcome, cookie_version, detail FROM login_event_log WHERE ts >= ? AND ts <= ?`;
    const rows = holder
      ? Array.from(
          this.state.storage.sql.exec(
            baseSql + " AND holder_id = ? ORDER BY ts DESC",
            from, to, holder,
          ),
        )
      : Array.from(
          this.state.storage.sql.exec(baseSql + " ORDER BY ts DESC", from, to),
        );
    return jsonResponse({ rows });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Storage helpers
  // ─────────────────────────────────────────────────────────────────────────

  private async loadState(): Promise<GlobalLoginStateData> {
    const stored =
      (await this.state.storage.get<GlobalLoginStateData>(STORAGE_KEY)) ?? null;
    if (stored === null) {
      return {
        proxy_name: null,
        cookie_ciphertext: null,
        version: 0,
        last_verified_at: 0,
        lease: null,
        recent_attempts: [],
      };
    }
    // Defensive backfill: pre-P2-C snapshots may not have
    // ``recent_attempts``; default to an empty array so downstream
    // code (acquire / record_attempt) doesn't have to null-check.
    if (!Array.isArray(stored.recent_attempts)) {
      stored.recent_attempts = [];
    }
    return stored;
  }

  private async persistState(data: GlobalLoginStateData): Promise<void> {
    await this.state.storage.put(STORAGE_KEY, data);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // AES-GCM cookie encryption
  // ─────────────────────────────────────────────────────────────────────────

  private async getKey(): Promise<CryptoKey> {
    if (this.cachedKey !== null) return this.cachedKey;
    const token = this.env.PROXY_COORDINATOR_TOKEN;
    if (!token) {
      throw new Error(
        "PROXY_COORDINATOR_TOKEN unset — cannot derive cookie encryption key",
      );
    }
    const ikm = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(token),
      "HKDF",
      false,
      ["deriveKey"],
    );
    this.cachedKey = await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: HKDF_SALT,
        info: HKDF_INFO,
      },
      ikm,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    return this.cachedKey;
  }

  private async encrypt(plaintext: string): Promise<string> {
    const key = await this.getKey();
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(plaintext),
      ),
    );
    const combined = new Uint8Array(iv.byteLength + ct.byteLength);
    combined.set(iv, 0);
    combined.set(ct, iv.byteLength);
    return base64UrlEncode(combined);
  }

  private async decrypt(ciphertext: string): Promise<string> {
    const key = await this.getKey();
    const combined = base64UrlDecode(ciphertext);
    if (combined.byteLength <= IV_BYTES) {
      throw new Error("ciphertext shorter than IV");
    }
    const iv = combined.slice(0, IV_BYTES);
    const ct = combined.slice(IV_BYTES);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ct,
    );
    return new TextDecoder().decode(plain);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (module-private)
// ─────────────────────────────────────────────────────────────────────────────

function clampTtlMs(raw: number): number {
  if (!Number.isFinite(raw) || raw < LOGIN_LEASE_TTL_MIN_MS) {
    return LOGIN_LEASE_TTL_MIN_MS;
  }
  if (raw > LOGIN_LEASE_TTL_MAX_MS) return LOGIN_LEASE_TTL_MAX_MS;
  return Math.floor(raw);
}

/**
 * P2-C — read the cooldown tuning values from Worker env, falling back
 * to the defaults defined in `types.ts`.  Each call re-reads the env so
 * a `wrangler` redeploy with new values takes effect on the next
 * `acquire_lease` without a DO restart.  Costs ~one numeric parse per
 * call; cheaper than caching + invalidating across token-rotation.
 */
function loadCooldownConfig(env: Env): {
  threshold: number;
  windowSec: number;
  durationMs: number;
} {
  const num = (v: string | undefined, fallback: number): number => {
    if (v === undefined || v === "") return fallback;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    threshold: num(env.LOGIN_COOLDOWN_THRESHOLD, DEFAULT_LOGIN_COOLDOWN_THRESHOLD),
    windowSec: num(env.LOGIN_COOLDOWN_WINDOW_SEC, DEFAULT_LOGIN_COOLDOWN_WINDOW_SEC),
    durationMs: num(
      env.LOGIN_COOLDOWN_DURATION_MS,
      DEFAULT_LOGIN_COOLDOWN_DURATION_MS,
    ),
  };
}

/**
 * Drop entries older than ``windowSec`` and return a fresh array.
 * Linear scan over a buffer that is bounded by `RECENT_ATTEMPTS_MAX_LEN`
 * so the cost is negligible (a few hundred Date arithmetic ops worst case).
 */
function pruneRecentAttempts(
  attempts: LoginAttemptRecord[],
  now: number,
  windowSec: number,
): LoginAttemptRecord[] {
  const cutoff = now - windowSec * 1000;
  const out: LoginAttemptRecord[] = [];
  for (const a of attempts) {
    if (typeof a.at === "number" && a.at >= cutoff) {
      out.push(a);
    }
  }
  return out;
}

/**
 * Compute ``cooldown_until_ms`` based on the latest failure inside the
 * pruned window.  Anchoring on the most recent failure (rather than
 * "now") means a successful login does NOT extend the cooldown — only
 * fresh failures push it forward.  Returns ``0`` when there are no
 * failures (caller should already short-circuit on threshold, but this
 * keeps the function safe to call in any state).
 */
function computeCooldownUntilMs(
  attempts: LoginAttemptRecord[],
  now: number,
  durationMs: number,
): number {
  let lastFailureAt = 0;
  for (const a of attempts) {
    if (a.outcome === "failure" && a.at > lastFailureAt) {
      lastFailureAt = a.at;
    }
  }
  if (lastFailureAt <= 0) return 0;
  const until = lastFailureAt + durationMs;
  return until > now ? until : 0;
}

/**
 * Truncate caller-provided strings to a sensible bound before persisting
 * them in DO storage.  Mirrors ``clipShortString`` in
 * `movie_claim_state.ts`; kept module-private so the cap can be tuned
 * independently per-DO.
 */
function clipShortString(value: string): string {
  const MAX = 256;
  if (value.length <= MAX) return value;
  return value.slice(0, MAX);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * URL-safe base64 without padding.  Workers ship a global ``btoa`` that only
 * accepts binary strings, so we hand-roll the byte → string conversion to
 * avoid a needless dependency on a node compat shim.
 */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + "=".repeat(padLen));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
