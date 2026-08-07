/**
 * ADR-043 D7 — global site-challenge circuit breaker.
 *
 * Covers:
 *   - `site_challenge` reports never touch the per-proxy CF / health counters
 *   - the breaker trips at the distinct-proxy threshold and not below
 *   - a tripped breaker suppresses CF auto-ban, while a normal CF storm on a
 *     single proxy still bans
 *   - the tripped state expires after the post-observation TTL
 *   - exactly one alert per trip (and one on recovery), not one per report
 *   - threshold derivation from the proxies_seen roster + env loaders
 *
 * The trip/expiry *decision* is exercised deterministically through the pure
 * `resolveSiteChallengeTrip` helper; the integration tests below then prove
 * the DO + Worker wiring actually feeds it the right inputs.
 */

import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env, SiteChallengeStatus } from "../src/types";
import {
  loadSiteChallengeMinFraction,
  loadSiteChallengeMinProxiesFloor,
  loadSiteChallengeTtlMs,
  loadSiteChallengeWindowSec,
  resolveSiteChallengeMinProxies,
  resolveSiteChallengeTrip,
} from "../src/runner_registry";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const TOKEN = "test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

/** Distinct proxies needed to trip when the roster is empty: the absolute
 *  floor (3). Every integration test below starts from empty isolated
 *  storage, so this is the effective threshold unless a runner registers a
 *  pool first. */
const FLOOR_THRESHOLD = 3;

/** Match the shrunken breaker knobs in vitest.config.ts. */
const TEST_TTL_MS = 3_000;
const TEST_WINDOW_SEC = 2;

function asEnv(overrides: Partial<Env>): Env {
  return overrides as Env;
}

async function rawFetch(path: string, init: RequestInit): Promise<Response> {
  const req = new Request(`https://test.invalid${path}`, init);
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function report(
  proxyId: string,
  kind: string,
  extras: Record<string, unknown> = {},
): Promise<Response> {
  return await rawFetch("/report", {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ proxy_id: proxyId, kind, ...extras }),
  });
}

async function reportOk(proxyId: string, kind: string): Promise<void> {
  const res = await report(proxyId, kind);
  expect(res.status).toBe(200);
  await res.text();
}

interface ProxyStateDump {
  cfEvents: number[];
  cfAutoBanEvents: number[];
  successEvents: number[];
  failureEvents: number[];
  banned: boolean;
  bannedUntil: number | null;
  bannedReason: string | null;
  now: number;
}

async function dumpState(proxyId: string): Promise<ProxyStateDump> {
  const res = await rawFetch(
    `/state?proxy_id=${encodeURIComponent(proxyId)}`,
    { method: "GET", headers: { ...AUTH } },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as ProxyStateDump;
}

async function snapshot(): Promise<{ site_challenge: SiteChallengeStatus }> {
  const res = await rawFetch("/ops/snapshot", {
    method: "GET",
    headers: { ...AUTH },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { site_challenge: SiteChallengeStatus };
}

/** Read breaker state without recording an observation. */
async function breakerState(): Promise<SiteChallengeStatus> {
  return (await snapshot()).site_challenge;
}

interface AlertRow {
  id: string;
  kind: string;
  summary: string;
  details: Record<string, unknown>;
}

async function alerts(): Promise<AlertRow[]> {
  const res = await rawFetch("/alerts", { method: "GET", headers: { ...AUTH } });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { alerts: AlertRow[] };
  return data.alerts.filter((a) => a.kind === "site_challenge");
}

/** Report a site challenge from *count* distinct proxies. */
async function tripWith(count: number, tag: string): Promise<void> {
  for (let i = 0; i < count; i++) {
    await reportOk(`${tag}-${i}`, "site_challenge");
  }
}

/** Seed `proxies_seen` with a pool of *size* so the breaker derives its
 *  threshold from a known roster instead of falling back to the floor. */
async function registerRoster(size: number): Promise<void> {
  const pool = Array.from({ length: size }, (_, i) => ({
    id: `sc-roster-${i}`,
    name: `sc-roster-${i}`,
  }));
  const res = await rawFetch("/register", {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ holder_id: "sc-roster-holder", proxy_pool: pool }),
  });
  expect(res.status).toBe(200);
  await res.text();
}

// ─────────────────────────────────────────────────────────────────────────────
// Env loaders + threshold derivation
// ─────────────────────────────────────────────────────────────────────────────

describe("site-challenge env loaders", () => {
  it("use ADR-043 D7 defaults when vars are absent, empty or garbage", () => {
    for (const bad of [undefined, "", "NaN", "Infinity", "0", "-1", "nope"]) {
      const e = asEnv(
        bad === undefined ? {} : { SITE_CHALLENGE_WINDOW_SEC: bad },
      );
      expect(loadSiteChallengeWindowSec(e)).toBe(300);
    }
    for (const bad of [undefined, "", "NaN", "Infinity", "0", "-1", "nope"]) {
      const e = asEnv(bad === undefined ? {} : { SITE_CHALLENGE_TTL_MS: bad });
      expect(loadSiteChallengeTtlMs(e)).toBe(900_000);
    }
    // Fraction must land in (0, 1]; anything else falls back to 0.5.
    for (const bad of [undefined, "", "0", "-0.2", "1.5", "NaN", "nope"]) {
      const e = asEnv(
        bad === undefined ? {} : { SITE_CHALLENGE_MIN_FRACTION: bad },
      );
      expect(loadSiteChallengeMinFraction(e)).toBe(0.5);
    }
    expect(loadSiteChallengeMinProxiesFloor(asEnv({}))).toBe(3);
    expect(
      loadSiteChallengeMinProxiesFloor(asEnv({ SITE_CHALLENGE_MIN_PROXIES_FLOOR: "0" })),
    ).toBe(3);
  });

  it("accepts valid overrides", () => {
    expect(
      loadSiteChallengeWindowSec(asEnv({ SITE_CHALLENGE_WINDOW_SEC: "120" })),
    ).toBe(120);
    expect(loadSiteChallengeTtlMs(asEnv({ SITE_CHALLENGE_TTL_MS: "5000" }))).toBe(5_000);
    expect(
      loadSiteChallengeMinFraction(asEnv({ SITE_CHALLENGE_MIN_FRACTION: "0.25" })),
    ).toBe(0.25);
    expect(
      loadSiteChallengeMinProxiesFloor(asEnv({ SITE_CHALLENGE_MIN_PROXIES_FLOOR: "5" })),
    ).toBe(5);
  });

  it("derives the threshold as a fraction of the roster, floored", () => {
    const e = asEnv({});
    // 28-proxy pool at the default 0.5 → 14 distinct proxies.
    expect(resolveSiteChallengeMinProxies(e, 28)).toBe(14);
    expect(resolveSiteChallengeMinProxies(e, 7)).toBe(4); // ceil(3.5)
    // Small pools clamp to the floor so 1-2 reports can never trip it, and an
    // unknown roster (nothing registered yet) behaves the same.
    expect(resolveSiteChallengeMinProxies(e, 4)).toBe(3);
    expect(resolveSiteChallengeMinProxies(e, 2)).toBe(3);
    expect(resolveSiteChallengeMinProxies(e, 0)).toBe(3);
  });

  it("honours SITE_CHALLENGE_MIN_PROXIES as an absolute override", () => {
    const e = asEnv({ SITE_CHALLENGE_MIN_PROXIES: "6" });
    expect(resolveSiteChallengeMinProxies(e, 28)).toBe(6);
    expect(resolveSiteChallengeMinProxies(e, 0)).toBe(6);
    // Garbage override falls back to the derived value.
    expect(
      resolveSiteChallengeMinProxies(asEnv({ SITE_CHALLENGE_MIN_PROXIES: "nope" }), 28),
    ).toBe(14);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pure trip / recovery decision (deterministic — no wall-clock waiting)
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveSiteChallengeTrip", () => {
  const base = {
    now: 1_000_000,
    prevTrippedAt: 0,
    lastObservationMs: 1_000_000,
    distinctProxies: 0,
    threshold: 3,
    ttlMs: 900_000,
  };

  it("trips at the threshold and not below", () => {
    expect(resolveSiteChallengeTrip({ ...base, distinctProxies: 2 })).toEqual({
      trippedAt: 0,
      transition: null,
    });
    expect(resolveSiteChallengeTrip({ ...base, distinctProxies: 3 })).toEqual({
      trippedAt: base.now,
      transition: "tripped",
    });
    expect(resolveSiteChallengeTrip({ ...base, distinctProxies: 28 })).toEqual({
      trippedAt: base.now,
      transition: "tripped",
    });
  });

  it("stays tripped without re-transitioning while reports continue", () => {
    const held = resolveSiteChallengeTrip({
      ...base,
      prevTrippedAt: 900_000,
      distinctProxies: 5,
    });
    // Latch keeps the ORIGINAL trip timestamp — that stability is what makes
    // the alert id de-duplicate for the whole outage.
    expect(held).toEqual({ trippedAt: 900_000, transition: null });
  });

  it("holds the latch even after the window empties, until the TTL expires", () => {
    // No proxy inside the rolling window any more, but the last observation is
    // only 10 min old and the TTL is 15 min → still tripped, no transition.
    const held = resolveSiteChallengeTrip({
      ...base,
      prevTrippedAt: 100_000,
      distinctProxies: 0,
      lastObservationMs: base.now - 600_000,
    });
    expect(held).toEqual({ trippedAt: 100_000, transition: null });
  });

  it("clears once the TTL elapses after the last observation", () => {
    const cleared = resolveSiteChallengeTrip({
      ...base,
      prevTrippedAt: 100_000,
      distinctProxies: 0,
      lastObservationMs: base.now - 900_001,
    });
    expect(cleared).toEqual({ trippedAt: 0, transition: "cleared" });
  });

  it("clears when every observation has been GC'd", () => {
    const cleared = resolveSiteChallengeTrip({
      ...base,
      prevTrippedAt: 100_000,
      distinctProxies: 0,
      lastObservationMs: 0,
    });
    expect(cleared).toEqual({ trippedAt: 0, transition: "cleared" });
  });

  it("does not trip on a zero threshold", () => {
    expect(
      resolveSiteChallengeTrip({ ...base, threshold: 0, distinctProxies: 0 }),
    ).toEqual({ trippedAt: 0, transition: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// site_challenge is not a proxy-quality signal
// ─────────────────────────────────────────────────────────────────────────────

describe("site_challenge report kind", () => {
  it("is accepted by the /report kind allowlist", async () => {
    const res = await report(`sc-accept-${crypto.randomUUID()}`, "site_challenge");
    expect(res.status).toBe(200);
    await res.text();
  });

  it("never increments the CF / auto-ban / health counters", async () => {
    const proxy = `sc-inert-${crypto.randomUUID()}`;
    // Well past CF_AUTO_BAN_THRESHOLD (6) — if these leaked into cfEvents the
    // proxy would be banned by now.
    for (let i = 0; i < 10; i++) {
      await reportOk(proxy, "site_challenge");
    }
    const state = await dumpState(proxy);
    expect(state.cfEvents.length).toBe(0);
    expect(state.cfAutoBanEvents.length).toBe(0);
    expect(state.successEvents.length).toBe(0);
    expect(state.failureEvents.length).toBe(0);
    expect(state.banned).toBe(false);
    expect(state.bannedUntil).toBeNull();
    expect(state.bannedReason).toBeNull();
  });

  it("counts distinct proxies, not report volume", async () => {
    const proxy = `sc-distinct-${crypto.randomUUID()}`;
    // One proxy shouting 10 times must not stand in for a walled pool.
    for (let i = 0; i < 10; i++) {
      await reportOk(proxy, "site_challenge");
    }
    const state = await breakerState();
    expect(state.distinct_proxies).toBe(1);
    expect(state.tripped).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Breaker trip / suppression / expiry
// ─────────────────────────────────────────────────────────────────────────────

describe("site-challenge breaker", () => {
  it("does not trip below the threshold", async () => {
    await tripWith(FLOOR_THRESHOLD - 1, `sc-below-${crypto.randomUUID()}`);
    const state = await breakerState();
    expect(state.distinct_proxies).toBe(FLOOR_THRESHOLD - 1);
    expect(state.threshold).toBe(FLOOR_THRESHOLD);
    expect(state.tripped).toBe(false);
    expect(state.tripped_at).toBe(0);
  });

  it("trips exactly at the threshold and surfaces on /ops/snapshot", async () => {
    await tripWith(FLOOR_THRESHOLD, `sc-trip-${crypto.randomUUID()}`);
    const state = await breakerState();
    expect(state.tripped).toBe(true);
    expect(state.distinct_proxies).toBe(FLOOR_THRESHOLD);
    expect(state.threshold).toBe(FLOOR_THRESHOLD);
    expect(state.tripped_at).toBeGreaterThan(0);
    expect(state.window_sec).toBe(TEST_WINDOW_SEC);
    expect(state.ttl_ms).toBe(TEST_TTL_MS);
  });

  it("raises the threshold to a fraction of the registered roster", async () => {
    // A 28-proxy roster at the default 0.5 fraction needs 14 reports, so the
    // 3 that would trip a rosterless deploy must NOT trip this one.
    await registerRoster(28);
    await tripWith(3, "sc-roster");
    const state = await breakerState();
    expect(state.roster_size).toBe(28);
    expect(state.threshold).toBe(14);
    expect(state.distinct_proxies).toBe(3);
    expect(state.tripped).toBe(false);
  });

  it("trips once a majority of the registered roster reports", async () => {
    await registerRoster(28);
    await tripWith(14, "sc-roster");
    const state = await breakerState();
    expect(state.roster_size).toBe(28);
    expect(state.threshold).toBe(14);
    expect(state.distinct_proxies).toBe(14);
    expect(state.tripped).toBe(true);
  });

  it("suppresses CF auto-ban while tripped", async () => {
    await tripWith(FLOOR_THRESHOLD, `sc-suppress-${crypto.randomUUID()}`);
    expect((await breakerState()).tripped).toBe(true);

    // A full CF storm on a proxy that has never succeeded — the exact shape
    // that auto-bans at 6 events — must NOT ban while the wall is site-wide.
    const proxy = `sc-victim-${crypto.randomUUID()}`;
    for (let i = 0; i < 8; i++) {
      await reportOk(proxy, "cf");
    }
    const state = await dumpState(proxy);
    // The CF events are still recorded (penalty factor still applies); only
    // the ban escalation is suppressed.
    expect(state.cfEvents.length).toBe(8);
    expect(state.cfAutoBanEvents.length).toBe(8);
    expect(state.banned).toBe(false);
    expect(state.bannedUntil).toBeNull();
    expect(state.bannedReason).toBeNull();
  });

  it("still auto-bans a single CF-storming proxy when the breaker is clear", async () => {
    // Control for the test above: same CF storm, no site_challenge reports.
    expect((await breakerState()).tripped).toBe(false);
    const proxy = `sc-control-${crypto.randomUUID()}`;
    for (let i = 0; i < 6; i++) {
      await reportOk(proxy, "cf");
    }
    const state = await dumpState(proxy);
    expect(state.banned).toBe(true);
    expect(state.bannedReason).toBe("cf_auto");
  });

  it("expires the tripped state after the post-observation TTL", async () => {
    await tripWith(FLOOR_THRESHOLD, `sc-expire-${crypto.randomUUID()}`);
    expect((await breakerState()).tripped).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, TEST_TTL_MS + 300));

    const after = await breakerState();
    expect(after.tripped).toBe(false);
    expect(after.tripped_at).toBe(0);

    // ...and CF auto-ban is armed again.
    const proxy = `sc-rearmed-${crypto.randomUUID()}`;
    for (let i = 0; i < 6; i++) {
      await reportOk(proxy, "cf");
    }
    expect((await dumpState(proxy)).banned).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Alerting — once per trip, not once per proxy / report
// ─────────────────────────────────────────────────────────────────────────────

describe("site-challenge alerts", () => {
  it("fires exactly once per trip regardless of report volume", async () => {
    const tag = `sc-alert-${crypto.randomUUID()}`;
    await tripWith(FLOOR_THRESHOLD, tag);
    const first = await alerts();
    expect(first.length).toBe(1);
    expect(first[0].details.state).toBe("tripped");
    expect(first[0].summary).toContain("TRIPPED");

    // The incident shape: the rest of a 28-proxy pool piles in, and some
    // proxies report repeatedly. `ban_spike` is per-proxy and would have
    // fired up to 28 times here while never saying "the pool is down".
    for (let i = FLOOR_THRESHOLD; i < 28; i++) {
      await reportOk(`${tag}-${i}`, "site_challenge");
    }
    for (let i = 0; i < FLOOR_THRESHOLD; i++) {
      await reportOk(`${tag}-${i}`, "site_challenge");
    }
    const after = await alerts();
    expect(after.length).toBe(1);
    expect(after[0].id).toBe(first[0].id);
  });

  it("emits one recovery alert when the breaker clears", async () => {
    await tripWith(FLOOR_THRESHOLD, `sc-recover-${crypto.randomUUID()}`);
    const tripped = await alerts();
    expect(tripped.length).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, TEST_TTL_MS + 300));
    expect((await breakerState()).tripped).toBe(false);

    const both = await alerts();
    expect(both.length).toBe(2);
    const cleared = both.find((a) => a.details.state === "cleared");
    expect(cleared).toBeDefined();
    expect(cleared!.summary).toContain("CLEARED");
    // Recovery id pairs with the trip it closes.
    expect(cleared!.id).toBe(`sitechal-clear-${tripped[0].id.split("-")[1]}`);

    // Re-reading the state must not multiply the recovery alert.
    await breakerState();
    expect((await alerts()).length).toBe(2);
  });
});
