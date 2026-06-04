export const RECOMMEND_POLICY_MODEL_VERSION = "adr023-shadow-v1";

export type RecommendReasonCode =
  | "low_confidence_prior"
  | "stable_recently"
  | "proxy_underperforming"
  | "banned_cooldown"
  | "cf_bypass_cooldown"
  | "global_pool_unstable";

export interface RecommendationPolicyInput {
  proxy_id: string;
  heuristic_score: number;
  latency_ema_ms: number;
  success_count: number;
  failure_count: number;
  banned: boolean;
  banned_until: number | null;
  requires_cf_bypass: boolean;
  cf_bypass_until: number | null;
  available: boolean;
}

export interface GlobalRecommendationBaseline {
  sample_count: number;
  success_count: number;
  failure_count: number;
  failure_rate: number;
  unstable_pool: boolean;
}

export interface RecommendationShadowFields {
  heuristic_score: number;
  model_score: number;
  confidence: number;
  reason_code: RecommendReasonCode;
  cooldown_until: number | null;
  model_version: string;
}

function clamp(raw: number, min: number, max: number): number {
  if (!Number.isFinite(raw)) return min;
  if (raw < min) return min;
  if (raw > max) return max;
  return raw;
}

function sampleCount(input: RecommendationPolicyInput): number {
  return Math.max(0, input.success_count) + Math.max(0, input.failure_count);
}

export function computeGlobalRecommendationBaseline(
  inputs: RecommendationPolicyInput[],
): GlobalRecommendationBaseline {
  let success = 0;
  let failure = 0;
  for (const input of inputs) {
    success += Math.max(0, input.success_count);
    failure += Math.max(0, input.failure_count);
  }
  const total = success + failure;
  const failureRate = total > 0 ? failure / total : 0;
  return {
    sample_count: total,
    success_count: success,
    failure_count: failure,
    failure_rate: failureRate,
    unstable_pool: total >= 6 && failureRate >= 0.65,
  };
}

export function computeRecommendationShadow(
  input: RecommendationPolicyInput,
  baseline: GlobalRecommendationBaseline,
  _nowMs: number,
): RecommendationShadowFields {
  const heuristicScore = clamp(input.heuristic_score, 0, 1);
  const count = sampleCount(input);
  const successRate = count > 0 ? Math.max(0, input.success_count) / count : 0.5;
  const failureRate = count > 0 ? Math.max(0, input.failure_count) / count : baseline.failure_rate;
  const relativeFailurePenalty = Math.max(0, failureRate - baseline.failure_rate) * 0.45;
  const latency = input.latency_ema_ms > 0 ? input.latency_ema_ms : 500;
  const latencyPenalty = clamp((latency - 500) / 10_000, 0, 0.35);
  const cooldownPenalty = input.banned ? 0.45 : input.requires_cf_bypass ? 0.25 : 0;
  const modelScore =
    count === 0
      ? clamp(0.5 - cooldownPenalty, 0, 1)
      : clamp(successRate - relativeFailurePenalty - latencyPenalty - cooldownPenalty, 0, 1);

  let confidence = count / (count + 20);
  if (baseline.unstable_pool) {
    confidence *= 0.5;
  }

  let reasonCode: RecommendReasonCode;
  if (input.banned) {
    reasonCode = "banned_cooldown";
  } else if (input.requires_cf_bypass) {
    reasonCode = "cf_bypass_cooldown";
  } else if (baseline.unstable_pool) {
    reasonCode = "global_pool_unstable";
  } else if (count < 3) {
    reasonCode = "low_confidence_prior";
  } else if (failureRate > baseline.failure_rate + 0.2) {
    reasonCode = "proxy_underperforming";
  } else {
    reasonCode = "stable_recently";
  }

  const cooldownUntil = input.banned
    ? input.banned_until
    : input.requires_cf_bypass
      ? input.cf_bypass_until
      : null;

  return {
    heuristic_score: heuristicScore,
    model_score: modelScore,
    confidence: clamp(confidence, 0, 1),
    reason_code: reasonCode,
    cooldown_until: cooldownUntil,
    model_version: RECOMMEND_POLICY_MODEL_VERSION,
  };
}

export type RecommendationPolicyMode = "shadow" | "policy";

export interface RecommendationRankScoreInput {
  heuristic_score: number;
  model_score: number;
  confidence: number;
  available: boolean;
  mode: RecommendationPolicyMode;
  exploration_floor: number;
}

export function parseRecommendationPolicyMode(
  raw: string | undefined,
): RecommendationPolicyMode {
  return raw === "policy" ? "policy" : "shadow";
}

export function computeRecommendationRankScore(
  input: RecommendationRankScoreInput,
): number {
  if (!input.available) {
    return -1;
  }
  const heuristic = clamp(input.heuristic_score, 0, 1);
  if (input.mode === "shadow") {
    return heuristic;
  }
  const model = clamp(input.model_score, 0, 1);
  const confidence = clamp(input.confidence, 0, 1);
  const blended = heuristic * (1 - confidence) + model * confidence;
  const floor = clamp(input.exploration_floor, 0, 0.2);
  return clamp(Math.max(floor, blended), 0, 1);
}

export type RecommendationRolloutGate =
  | "observe"
  | "ready"
  | "blocked_global_instability";

export interface RecommendationPolicySummaryInput {
  proxy_id: string;
  heuristic_score: number;
  model_score: number;
  rank_score: number;
  confidence: number;
  available: boolean;
  reason_code: RecommendReasonCode;
}

export interface RecommendationPolicySummary {
  mode: RecommendationPolicyMode;
  candidate_count: number;
  available_count: number;
  average_confidence: number;
  max_score_delta: number;
  disagreement_count: number;
  global_pool_unstable_count: number;
  rollout_gate: RecommendationRolloutGate;
}

export function computeRecommendationPolicySummary(
  rows: RecommendationPolicySummaryInput[],
  mode: RecommendationPolicyMode,
): RecommendationPolicySummary {
  const candidateCount = rows.length;
  const available = rows.filter((row) => row.available);
  const confidenceSum = rows.reduce((acc, row) => acc + clamp(row.confidence, 0, 1), 0);
  const deltas = rows.map((row) =>
    Math.abs(clamp(row.model_score, 0, 1) - clamp(row.heuristic_score, 0, 1)),
  );
  const maxDelta = deltas.length > 0 ? Math.max(...deltas) : 0;
  const disagreementCount = deltas.filter((delta) => delta >= 0.2).length;
  const globalPoolUnstableCount = rows.filter(
    (row) => row.reason_code === "global_pool_unstable",
  ).length;
  const averageConfidence =
    candidateCount > 0 ? confidenceSum / candidateCount : 0;

  let rolloutGate: RecommendationRolloutGate = "observe";
  if (globalPoolUnstableCount > 0) {
    rolloutGate = "blocked_global_instability";
  } else if (
    mode === "policy" &&
    candidateCount > 0 &&
    averageConfidence >= 0.6 &&
    maxDelta < 0.2
  ) {
    rolloutGate = "ready";
  }

  return {
    mode,
    candidate_count: candidateCount,
    available_count: available.length,
    average_confidence: averageConfidence,
    max_score_delta: maxDelta,
    disagreement_count: disagreementCount,
    global_pool_unstable_count: globalPoolUnstableCount,
    rollout_gate: rolloutGate,
  };
}
