import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import {
  loadCfAutoBanEnabled,
  loadCfAutoBanThreshold,
  loadCfBanTtlMs,
} from "../src/proxy_coordinator";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const TOKEN = "test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

function asEnv(overrides: Partial<Env>): Env {
  return overrides as Env;
}

async function report(
  proxyId: string,
  kind: "cf" | "success" | "failure" | "ban" = "cf",
  extras: { ttl_ms?: number; reason?: string } = {},
) {
  const req = new Request("https://test.invalid/report", {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ proxy_id: proxyId, kind, ...extras }),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  return await res.json();
}

async function dumpState(proxyId: string) {
  const req = new Request(
    `https://test.invalid/state?proxy_id=${encodeURIComponent(proxyId)}`,
    { method: "GET", headers: { ...AUTH } },
  );
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    cfEvents: number[];
    successEvents: number[];
    bannedUntil: number | null;
    bannedReason: string | null;
    banned: boolean;
    now: number;
  };
}

describe("CF auto-ban env loaders", () => {
  it("use ADR-043 defaults when vars are absent or empty", () => {
    expect(loadCfAutoBanEnabled(asEnv({}))).toBe(true);
    expect(loadCfAutoBanEnabled(asEnv({ CF_AUTO_BAN_ENABLED: "" }))).toBe(true);
    expect(loadCfAutoBanThreshold(asEnv({}))).toBe(6);
    expect(loadCfAutoBanThreshold(asEnv({ CF_AUTO_BAN_THRESHOLD: "" }))).toBe(6);
    expect(loadCfBanTtlMs(asEnv({}))).toBe(21_600_000);
    expect(loadCfBanTtlMs(asEnv({ CF_BAN_TTL_MS: "" }))).toBe(21_600_000);
  });

  it("only exact false and 0 disable auto-ban", () => {
    expect(loadCfAutoBanEnabled(asEnv({ CF_AUTO_BAN_ENABLED: "false" }))).toBe(false);
    expect(loadCfAutoBanEnabled(asEnv({ CF_AUTO_BAN_ENABLED: "0" }))).toBe(false);
    expect(loadCfAutoBanEnabled(asEnv({ CF_AUTO_BAN_ENABLED: "true" }))).toBe(true);
    expect(loadCfAutoBanEnabled(asEnv({ CF_AUTO_BAN_ENABLED: "False" }))).toBe(true);
    expect(loadCfAutoBanEnabled(asEnv({ CF_AUTO_BAN_ENABLED: "no" }))).toBe(true);
  });

  it("accepts positive numeric overrides and floors threshold", () => {
    expect(loadCfAutoBanThreshold(asEnv({ CF_AUTO_BAN_THRESHOLD: "3.9" }))).toBe(3);
    expect(loadCfBanTtlMs(asEnv({ CF_BAN_TTL_MS: "60000" }))).toBe(60_000);
  });

  it("falls back for invalid threshold and ttl values", () => {
    for (const bad of ["NaN", "Infinity", "0", "0.5", "-1", "not-a-number"]) {
      expect(loadCfAutoBanThreshold(asEnv({ CF_AUTO_BAN_THRESHOLD: bad }))).toBe(6);
    }
    for (const bad of ["NaN", "Infinity", "0", "-1", "not-a-number"]) {
      expect(loadCfBanTtlMs(asEnv({ CF_BAN_TTL_MS: bad }))).toBe(21_600_000);
    }
  });
});

describe("CF auto-ban escalation", () => {
  it("fresh proxy state exposes bannedReason=null", async () => {
    const proxy = `cfab-fresh-${crypto.randomUUID()}`;
    const state = await dumpState(proxy);
    expect(state.banned).toBe(false);
    expect(state.bannedUntil).toBeNull();
    expect(state.bannedReason).toBeNull();
  });

  it("six CF reports and zero successes auto-ban the proxy", async () => {
    const proxy = `cfab-six-${crypto.randomUUID()}`;
    for (let i = 0; i < 6; i++) {
      await report(proxy, "cf");
    }

    const state = await dumpState(proxy);
    expect(state.cfEvents.length).toBe(6);
    expect(state.successEvents.length).toBe(0);
    expect(state.banned).toBe(true);
    expect(state.bannedUntil).not.toBeNull();
    expect(state.bannedUntil!).toBeGreaterThan(state.now);
    expect(state.bannedReason).toBe("cf_auto");
  });

  it("five CF reports do not auto-ban the proxy", async () => {
    const proxy = `cfab-five-${crypto.randomUUID()}`;
    for (let i = 0; i < 5; i++) {
      await report(proxy, "cf");
    }

    const state = await dumpState(proxy);
    expect(state.cfEvents.length).toBe(5);
    expect(state.banned).toBe(false);
    expect(state.bannedUntil).toBeNull();
    expect(state.bannedReason).toBeNull();
  });

  it("ban page reason without ttl_ms maps to the hard-ban TTL", async () => {
    const proxy = `cfab-hard-${crypto.randomUUID()}`;
    await report(proxy, "ban", { reason: "ban page detected" });

    const state = await dumpState(proxy);
    expect(state.banned).toBe(true);
    expect(state.bannedReason).toBe("javdb_hardban");
    expect(state.bannedUntil).not.toBeNull();
    expect(state.bannedUntil!).toBeGreaterThan(state.now + 7.5 * 24 * 60 * 60 * 1000);
    expect(state.bannedUntil!).toBeLessThanOrEqual(state.now + 8 * 24 * 60 * 60 * 1000 + 1000);
  });

  it("explicit ttl_ms still wins for ban reports", async () => {
    const proxy = `cfab-manual-${crypto.randomUUID()}`;
    await report(proxy, "ban", { ttl_ms: 60_000, reason: "ban page detected" });

    const state = await dumpState(proxy);
    expect(state.banned).toBe(true);
    expect(state.bannedReason).toBe("javdb_hardban");
    expect(state.bannedUntil).not.toBeNull();
    expect(state.bannedUntil!).toBeLessThanOrEqual(state.now + 61_000);
  });

  it("expired bans clear bannedReason on state dump", async () => {
    const proxy = `cfab-expired-${crypto.randomUUID()}`;
    await report(proxy, "ban", { ttl_ms: 1, reason: "ban page detected" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const state = await dumpState(proxy);
    expect(state.banned).toBe(false);
    expect(state.bannedUntil).toBeNull();
    expect(state.bannedReason).toBeNull();
  });

  it("six CF reports with a success in the window do not auto-ban the proxy", async () => {
    const proxy = `cfab-success-${crypto.randomUUID()}`;
    await report(proxy, "success");
    for (let i = 0; i < 6; i++) {
      await report(proxy, "cf");
    }

    const state = await dumpState(proxy);
    expect(state.cfEvents.length).toBe(6);
    expect(state.successEvents.length).toBe(1);
    expect(state.banned).toBe(false);
    expect(state.bannedUntil).toBeNull();
    expect(state.bannedReason).toBeNull();
  });

  it("generic failure reports do not count toward CF auto-ban threshold", async () => {
    const proxy = `cfab-failure-${crypto.randomUUID()}`;
    for (let i = 0; i < 5; i++) {
      await report(proxy, "failure");
    }
    await report(proxy, "cf");

    const state = await dumpState(proxy);
    expect(state.cfEvents.length).toBe(6);
    expect(state.banned).toBe(false);
    expect(state.bannedUntil).toBeNull();
    expect(state.bannedReason).toBeNull();
  });
});
