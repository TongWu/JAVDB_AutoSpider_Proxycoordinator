import { describe, expect, it } from "vitest";
import {
  RECOMMEND_POLICY_MODEL_VERSION,
  computeGlobalRecommendationBaseline,
  computeRecommendationShadow,
  type RecommendationPolicyInput,
} from "../src/recommend_policy";

function input(overrides: Partial<RecommendationPolicyInput>): RecommendationPolicyInput {
  return {
    proxy_id: "P",
    heuristic_score: 0.5,
    latency_ema_ms: 0,
    success_count: 0,
    failure_count: 0,
    banned: false,
    banned_until: null,
    requires_cf_bypass: false,
    cf_bypass_until: null,
    available: true,
    ...overrides,
  };
}

describe("recommend_policy shadow scoring", () => {
  it("keeps unseen proxies neutral with zero confidence", () => {
    const rows = [input({ proxy_id: "P-NEW" })];
    const baseline = computeGlobalRecommendationBaseline(rows);
    const shadow = computeRecommendationShadow(rows[0], baseline, 1_000);

    expect(shadow.heuristic_score).toBe(0.5);
    expect(shadow.model_score).toBe(0.5);
    expect(shadow.confidence).toBe(0);
    expect(shadow.reason_code).toBe("low_confidence_prior");
    expect(shadow.cooldown_until).toBeNull();
    expect(shadow.model_version).toBe(RECOMMEND_POLICY_MODEL_VERSION);
  });

  it("rewards stable low-latency success history", () => {
    const rows = [
      input({
        proxy_id: "P-STABLE",
        heuristic_score: 0.9,
        success_count: 10,
        failure_count: 0,
        latency_ema_ms: 100,
      }),
    ];
    const baseline = computeGlobalRecommendationBaseline(rows);
    const shadow = computeRecommendationShadow(rows[0], baseline, 1_000);

    expect(shadow.model_score).toBe(1);
    expect(shadow.confidence).toBeCloseTo(10 / 30, 5);
    expect(shadow.reason_code).toBe("stable_recently");
  });

  it("penalizes proxies that underperform the global baseline", () => {
    const rows = [
      input({
        proxy_id: "P-BAD",
        heuristic_score: 0.4,
        success_count: 2,
        failure_count: 8,
        latency_ema_ms: 500,
      }),
      input({
        proxy_id: "P-GOOD",
        heuristic_score: 0.9,
        success_count: 10,
        failure_count: 0,
        latency_ema_ms: 100,
      }),
    ];
    const baseline = computeGlobalRecommendationBaseline(rows);
    const bad = computeRecommendationShadow(rows[0], baseline, 1_000);
    const good = computeRecommendationShadow(rows[1], baseline, 1_000);

    expect(baseline.failure_rate).toBeCloseTo(8 / 20, 5);
    expect(bad.model_score).toBeLessThan(0.1);
    expect(bad.reason_code).toBe("proxy_underperforming");
    expect(good.model_score).toBeGreaterThan(bad.model_score);
  });

  it("marks global pool instability separately from proxy-local blame", () => {
    const rows = [
      input({ proxy_id: "P-A", success_count: 0, failure_count: 10 }),
      input({ proxy_id: "P-B", success_count: 0, failure_count: 10 }),
    ];
    const baseline = computeGlobalRecommendationBaseline(rows);
    const shadow = computeRecommendationShadow(rows[0], baseline, 1_000);

    expect(baseline.unstable_pool).toBe(true);
    expect(shadow.reason_code).toBe("global_pool_unstable");
    expect(shadow.confidence).toBeCloseTo((10 / 30) * 0.5, 5);
  });

  it("keeps cooldown information for banned proxies", () => {
    const rows = [
      input({
        proxy_id: "P-BANNED",
        heuristic_score: 1,
        success_count: 20,
        failure_count: 0,
        banned: true,
        banned_until: 123_456,
      }),
    ];
    const baseline = computeGlobalRecommendationBaseline(rows);
    const shadow = computeRecommendationShadow(rows[0], baseline, 1_000);

    expect(shadow.model_score).toBeCloseTo(0.55, 5);
    expect(shadow.reason_code).toBe("banned_cooldown");
    expect(shadow.cooldown_until).toBe(123_456);
  });

  it("keeps cooldown information for cf-bypass proxies", () => {
    const rows = [
      input({
        proxy_id: "P-CF",
        heuristic_score: 0.7,
        success_count: 10,
        failure_count: 0,
        requires_cf_bypass: true,
        cf_bypass_until: 0,
      }),
    ];
    const baseline = computeGlobalRecommendationBaseline(rows);
    const shadow = computeRecommendationShadow(rows[0], baseline, 1_000);

    expect(shadow.model_score).toBeCloseTo(0.75, 5);
    expect(shadow.reason_code).toBe("cf_bypass_cooldown");
    expect(shadow.cooldown_until).toBe(0);
  });
});
