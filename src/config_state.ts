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
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/do/config":
          return await this.handleGet();
        case "/do/patch":
          return await this.handlePatch(request);
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

  private async handlePatch(request: Request): Promise<Response> {
    let body: ConfigPatchRequest;
    try {
      body = (await request.json()) as ConfigPatchRequest;
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }
    if (
      body === null ||
      typeof body !== "object" ||
      body.values === undefined ||
      typeof body.values !== "object" ||
      Array.isArray(body.values)
    ) {
      return jsonResponse({ error: "missing values object" }, 400);
    }

    // Validate every key + coerce every value to string in one pass so we
    // can reject the whole request rather than leaving a half-applied
    // state. Empty strings are allowed and represent "clear this override".
    const sanitised: Partial<Record<ConfigKey, string>> = {};
    for (const [k, v] of Object.entries(body.values)) {
      if (!ALLOWED_SET.has(k)) {
        return jsonResponse(
          { error: `unknown config key: ${k}` },
          400,
        );
      }
      if (typeof v !== "string") {
        return jsonResponse(
          { error: `value for ${k} must be a string` },
          400,
        );
      }
      sanitised[k as ConfigKey] = v;
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
    return jsonResponse(toResponse(merged));
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
