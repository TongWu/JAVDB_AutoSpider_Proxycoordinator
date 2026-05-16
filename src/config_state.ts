import {
  CONFIG_ALLOWED_KEYS,
  ConfigKey,
  ConfigPatchRequest,
  ConfigResponse,
  ConfigSnapshot,
  Env,
} from "./types";

/**
 * ConfigState — singleton DO holding operator-tunable runtime parameters
 * for the spider runners (W5.3).
 *
 * Addressed by ``idFromName("global-config")`` from {@link forwardToConfigStateDo}
 * in {@link ./index.ts}. One instance per deployment.
 *
 * Endpoints (exposed via the Worker as ``GET /config`` and
 * ``PATCH /config``):
 *
 * - ``GET  /do/config``   — return the current {@link ConfigSnapshot}.
 * - ``POST /do/patch``    — partial update; bumps ``version`` and
 *                           ``updated_at`` on success.
 *
 * Storage layout (single-key snapshot):
 *
 *   - ``snapshot`` → {@link ConfigSnapshot}
 *
 * Default semantics:
 *
 *   - Unknown keys in a PATCH body are rejected with HTTP 400. Only keys
 *     in {@link CONFIG_ALLOWED_KEYS} are accepted.
 *   - Empty-string values clear the override for that key (clients then
 *     fall back to env-var defaults).
 *   - All values are stored as strings to mirror the ``wrangler.toml [vars]``
 *     convention. Consumers parse via parseInt / parseFloat.
 *
 * Forward-compat: the DO never returns config keys outside
 * {@link CONFIG_ALLOWED_KEYS}, so a client that ships a typed
 * ``ConfigSnapshot`` can't be tripped by a stale Worker.
 *
 * Auth: enforced in {@link ./index.ts} via the usual Bearer-token check.
 * Once a request reaches the DO it has already been authorised.
 */

const STORAGE_KEY = "snapshot";

const ALLOWED_SET: Set<string> = new Set(CONFIG_ALLOWED_KEYS);

export class ConfigState implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  /** In-memory snapshot mirror. Lazily loaded; every write refreshes it. */
  private cached: ConfigSnapshot | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Phase 2 / ADR-002 — config_audit_log: every PATCH leaves an audit trail.
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS config_audit_log (
        ts INTEGER NOT NULL,
        key TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        actor TEXT,
        actor_kind TEXT NOT NULL,
        reason TEXT,
        PRIMARY KEY (ts, key)
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/do/config":
          return await this.handleGet();
        case "/do/patch":
          return await this.handlePatch(request);
        case "/do/config/history":
          return await this.handleConfigHistory(request);
        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("ConfigState DO handler error", {
        path: url.pathname,
        error: message,
      });
      return jsonResponse({ error: "internal_error" }, 500);
    }
  }

  private async handleGet(): Promise<Response> {
    const snap = await this.loadSnapshot();
    return jsonResponse(toResponse(snap));
  }

  /**
   * Handle PATCH requests.  Accepts two body formats:
   *
   * 1. Legacy multi-key format (existing callers):
   *    ``{ values: { key: "value", ... } }``
   *
   * 2. Single-key audit format (Phase 2 / ADR-002):
   *    ``{ key: "KEY_NAME", value: "val", reason?: "..." }``
   *
   * In both cases, after the snapshot is updated, an audit row is written
   * to ``config_audit_log`` for each changed key.  The ``x-actor`` and
   * ``x-actor-kind`` request headers carry the caller identity.
   */
  private async handlePatch(request: Request): Promise<Response> {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }

    // Phase 2 / ADR-002 — read actor headers before we touch the body.
    const actor = ((request.headers.get("x-actor") ?? "anonymous")).slice(0, 100);
    const actorKindRaw = request.headers.get("x-actor-kind") ?? "system";
    const actorKind = actorKindRaw === "operator" ? "operator" : "system";

    // Detect format: single-key ``{ key, value, reason? }`` vs legacy ``{ values: {...} }``
    const body = rawBody as Record<string, unknown>;
    let sanitised: Partial<Record<ConfigKey, string>>;
    let reasonByKey: Map<string, string>;

    if (body !== null && typeof body === "object" && !Array.isArray(body) && "key" in body) {
      // Single-key audit format: { key, value, reason? }
      const rawKey = typeof body.key === "string" ? body.key.toLowerCase() : "";
      if (!ALLOWED_SET.has(rawKey)) {
        return jsonResponse({ error: `unknown config key: ${body.key}` }, 400);
      }
      const rawValue = body.value;
      if (typeof rawValue !== "string") {
        return jsonResponse({ error: `value for ${rawKey} must be a string` }, 400);
      }
      const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : "";
      sanitised = { [rawKey as ConfigKey]: rawValue };
      reasonByKey = new Map([[rawKey, reason]]);
    } else {
      // Legacy multi-key format: { values: { key: "value", ... } }
      const legacyBody = rawBody as { values?: unknown };
      if (
        legacyBody === null ||
        typeof legacyBody !== "object" ||
        legacyBody.values === undefined ||
        typeof legacyBody.values !== "object" ||
        Array.isArray(legacyBody.values)
      ) {
        return jsonResponse({ error: "missing values object" }, 400);
      }
      sanitised = {};
      reasonByKey = new Map();
      for (const [k, v] of Object.entries(legacyBody.values as Record<string, unknown>)) {
        if (!ALLOWED_SET.has(k)) {
          return jsonResponse({ error: `unknown config key: ${k}` }, 400);
        }
        if (typeof v !== "string") {
          return jsonResponse({ error: `value for ${k} must be a string` }, 400);
        }
        sanitised[k as ConfigKey] = v;
        reasonByKey.set(k, "");
      }
    }

    const current = await this.loadSnapshot();
    const merged: ConfigSnapshot = {
      version: current.version + 1,
      updated_at: Date.now(),
      values: { ...current.values },
    };
    for (const [k, v] of Object.entries(sanitised)) {
      if (v === "") {
        delete merged.values[k as ConfigKey];
      } else {
        merged.values[k as ConfigKey] = v;
      }
    }
    await this.persistSnapshot(merged);

    // Phase 2 / ADR-002 — write one audit row per changed key.
    const now = Date.now();
    for (const [k, newVal] of Object.entries(sanitised)) {
      const oldVal = current.values[k as ConfigKey];
      const reason = reasonByKey.get(k) ?? "";
      this.state.storage.sql.exec(
        `INSERT OR REPLACE INTO config_audit_log
         (ts, key, old_value, new_value, actor, actor_kind, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        now,
        k,
        oldVal === undefined ? null : String(oldVal),
        typeof newVal === "string" ? newVal : JSON.stringify(newVal),
        actor,
        actorKind,
        reason,
      );
    }

    return jsonResponse(toResponse(merged));
  }

  /**
   * GET /do/config/history?from=<ms>&to=<ms>&key=<key>
   *
   * Returns audit rows from ``config_audit_log`` in descending timestamp order.
   * ``key`` is optional — when absent, all keys are returned.
   */
  private handleConfigHistory(request: Request): Response {
    if (request.method !== "GET") {
      return jsonResponse({ error: "method not allowed" }, 405);
    }
    const url = new URL(request.url);
    const from = parseInt(url.searchParams.get("from") ?? "0", 10);
    const to = parseInt(url.searchParams.get("to") ?? `${Date.now()}`, 10);
    const key = url.searchParams.get("key");
    const baseSql =
      `SELECT ts, key, old_value, new_value, actor, actor_kind, reason ` +
      `FROM config_audit_log WHERE ts >= ? AND ts <= ?`;
    const rows = key
      ? Array.from(
          this.state.storage.sql.exec(
            baseSql + " AND key = ? ORDER BY ts DESC",
            from, to, key.toLowerCase(),
          ),
        )
      : Array.from(
          this.state.storage.sql.exec(baseSql + " ORDER BY ts DESC", from, to),
        );
    return jsonResponse({ rows });
  }

  /**
   * Read the snapshot from storage, lazily initialising it to a v0
   * empty snapshot on first access so callers always see a well-formed
   * response even before any PATCH has run.
   */
  private async loadSnapshot(): Promise<ConfigSnapshot> {
    if (this.cached !== null) return this.cached;
    const stored = await this.state.storage.get<ConfigSnapshot>(STORAGE_KEY);
    if (stored !== undefined && stored !== null) {
      this.cached = stored;
      return stored;
    }
    const init: ConfigSnapshot = {
      version: 0,
      updated_at: Date.now(),
      values: {},
    };
    this.cached = init;
    return init;
  }

  private async persistSnapshot(snap: ConfigSnapshot): Promise<void> {
    await this.state.storage.put(STORAGE_KEY, snap);
    this.cached = snap;
  }
}

function toResponse(snap: ConfigSnapshot): ConfigResponse {
  return { ...snap, server_time: Date.now() };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
