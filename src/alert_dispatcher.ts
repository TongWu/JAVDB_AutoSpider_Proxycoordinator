import {
  AlertEvent,
  AlertKind,
  AlertWebhook,
  ALERT_SUMMARY_MAX_LEN,
  Env,
} from "./types";

/**
 * Phase-1 ADR-008 — alert dispatcher.
 *
 * Two roles, intentionally split into two pure functions so they can be
 * called from different contexts:
 *
 * 1. {@link recordAlert} — synchronous SQL insert into the
 *    `alert_history` table inside the RunnerRegistry DO. Called from the
 *    DO that detected the alert condition (RunnerRegistry for
 *    `session_failed`, ProxyCoordinator for `ban_spike` via cross-DO
 *    fetch, GlobalLoginState for `login_cooldown`).
 *
 * 2. {@link dispatchAlert} — async out-of-band POST to every webhook in
 *    `ConfigState.alert_webhooks_json` whose `kinds` array matches the
 *    incoming alert kind. Failures are logged but never raised — the
 *    alert is already in `alert_history` regardless of webhook
 *    delivery success.
 *
 * Idempotency: alert ids are deterministic for repeatable events
 * (`sessfail-{session_id}`, `banspike-{proxy_id}-{hourBucket}`,
 * `logincd-{cooldown_until_ms}`). `INSERT OR IGNORE` on the
 * `alert_history` table means re-applying the same event during a
 * register/heartbeat retry won't multiply rows or webhook calls — the
 * second insert is a no-op and dispatch follows the row insert, so a
 * row that already existed implies a previous dispatch already happened.
 */

const WEBHOOK_TIMEOUT_MS = 10_000;
const WEBHOOK_RETRY_DELAYS_MS = [1_000, 3_000];

/** Insert one alert row. Returns `true` if the row was newly inserted,
 *  `false` when a duplicate id collided (already-recorded event). */
export function recordAlert(sql: SqlStorage, alert: AlertEvent): boolean {
  const before = countAlertRows(sql, alert.id);
  sql.exec(
    `INSERT OR IGNORE INTO alert_history
       (id, ts, kind, severity, summary, details_json, ack)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    alert.id,
    alert.ts,
    alert.kind,
    alert.severity,
    alert.summary.slice(0, ALERT_SUMMARY_MAX_LEN),
    JSON.stringify(alert.details ?? {}),
  );
  const after = countAlertRows(sql, alert.id);
  return after > before;
}

function countAlertRows(sql: SqlStorage, id: string): number {
  const rows = Array.from(
    sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM alert_history WHERE id = ?`,
      id,
    ),
  );
  return rows[0]?.count ?? 0;
}

/** Read the webhook list from ConfigState. Fail-open: any error returns
 *  an empty list (no webhook delivery) so a misconfigured config DO
 *  does not silently break alert dispatch — the alert is still in
 *  `alert_history` and visible on the dashboard. */
export async function loadAlertWebhooks(env: Env): Promise<AlertWebhook[]> {
  if (!env.CONFIG_STATE_DO) return [];
  try {
    const id = env.CONFIG_STATE_DO.idFromName("global-config");
    const stub = env.CONFIG_STATE_DO.get(id);
    const r = await stub.fetch("https://do/do/config", { method: "GET" });
    if (r.status !== 200) return [];
    const snap = (await r.json()) as {
      values?: Record<string, unknown>;
    };
    const raw = snap?.values?.alert_webhooks_json;
    if (typeof raw !== "string" || !raw.trim()) return [];
    return parseWebhooksJson(raw);
  } catch {
    return [];
  }
}

/** Pure parser exported for testing. Accepts the JSON-stringified
 *  webhook list; rejects entries that aren't HTTPS or whose `kinds`
 *  field contains unknown kinds. */
export function parseWebhooksJson(raw: string): AlertWebhook[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: AlertWebhook[] = [];
  const validKinds = new Set<AlertKind>([
    "session_failed",
    "ban_spike",
    "login_cooldown",
    "manual_test",
  ]);
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const url = typeof e.url === "string" ? e.url.trim() : "";
    if (!url || !url.startsWith("https://")) continue;
    const kindsRaw = Array.isArray(e.kinds) ? e.kinds : undefined;
    const kinds =
      kindsRaw === undefined
        ? undefined
        : kindsRaw
            .filter((k): k is string => typeof k === "string")
            .filter((k): k is AlertKind => validKinds.has(k as AlertKind));
    out.push({ url, kinds });
  }
  return out;
}

/** POST the alert envelope to every matching webhook. Retries each
 *  destination twice with exponential back-off; logs (but does not
 *  raise) every error so the calling DO can `.catch(() => {})` safely. */
export async function dispatchAlert(
  env: Env,
  alert: AlertEvent,
): Promise<void> {
  const webhooks = await loadAlertWebhooks(env);
  if (webhooks.length === 0) return;
  const targets = webhooks.filter(
    (w) => w.kinds === undefined || w.kinds.length === 0 || w.kinds.includes(alert.kind),
  );
  if (targets.length === 0) return;
  await Promise.all(
    targets.map(async (w) => {
      try {
        await postWithRetry(w.url, alert);
      } catch (err) {
        console.warn("alert webhook delivery failed", {
          url: w.url,
          alert_id: alert.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
}

async function postWithRetry(url: string, alert: AlertEvent): Promise<void> {
  let lastErr: unknown = null;
  const body = JSON.stringify({
    id: alert.id,
    kind: alert.kind,
    ts: alert.ts,
    severity: alert.severity,
    summary: alert.summary,
    details: alert.details,
  });
  for (let attempt = 0; attempt <= WEBHOOK_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), WEBHOOK_TIMEOUT_MS);
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: ctrl.signal,
        });
        if (resp.status >= 200 && resp.status < 300) return;
        lastErr = new Error(`webhook responded ${resp.status}`);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      lastErr = err;
    }
    if (attempt < WEBHOOK_RETRY_DELAYS_MS.length) {
      await sleep(WEBHOOK_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Helper for cross-DO alert recording. Other DOs (ProxyCoordinator,
 *  GlobalLoginState) call this to push an alert into the RunnerRegistry
 *  history table via a stub-fetch — keeps `alert_history` in one place. */
export async function recordAndDispatch(
  env: Env,
  alert: AlertEvent,
): Promise<void> {
  if (!env.RUNNER_REGISTRY_DO) {
    // No registry binding configured — fall open: still dispatch the
    // webhook so the operator at least gets notified, even if no history
    // row is recorded.
    await dispatchAlert(env, alert).catch(() => {});
    return;
  }
  try {
    const id = env.RUNNER_REGISTRY_DO.idFromName("runners");
    const stub = env.RUNNER_REGISTRY_DO.get(id);
    const r = await stub.fetch("https://do/do/alerts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(alert),
    });
    // Drain the body fully — mirrors forwardTo*Do helpers in index.ts.
    // Without this the JSRPC storage frame stays open past the await
    // point, which vitest-pool-workers detects as a leak (see
    // forwardToGlobalLoginStateDo for the canonical explanation).
    await r.text();
  } catch (err) {
    console.warn("recordAndDispatch: failed to forward alert to RunnerRegistry", {
      alert_id: alert.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
