import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const BUDGET_VERSION = 1;

export const BUDGET_PROFILES = Object.freeze({
  default: Object.freeze({ max_tokens: 6_000_000, max_minutes: 240, max_attempts: 96 }),
  extended: Object.freeze({ max_tokens: 12_000_000, max_minutes: 480, max_attempts: 192 }),
  unlimited: Object.freeze({ max_tokens: null, max_minutes: null, max_attempts: null }),
});

function finiteNonNegative(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function integerLimit(value) {
  const number = finiteNonNegative(value);
  return number === null ? null : Math.trunc(number);
}

function valueFrom(input, camel, snake) {
  return input?.[camel] !== undefined ? input[camel] : input?.[snake];
}

export function normalizeRunBudget(input = {}) {
  const legacy = input.legacy === true || input.profile === "legacy-unlimited";
  const requestedProfile = String(input.profile || input.budgetProfile || input.budget_profile || (legacy ? "legacy-unlimited" : "default"))
    .trim()
    .toLowerCase();
  const profile = legacy ? "legacy-unlimited" : requestedProfile;
  if (!legacy && !Object.hasOwn(BUDGET_PROFILES, profile)) {
    throw new Error("Budget profile must be one of: default, extended, unlimited");
  }
  const base = legacy ? BUDGET_PROFILES.unlimited : BUDGET_PROFILES[profile];
  const maxTokensValue = valueFrom(input, "maxRunTokens", "max_tokens");
  const maxMinutesValue = valueFrom(input, "maxRunMinutes", "max_minutes");
  const maxAttemptsValue = valueFrom(input, "maxRunAttempts", "max_attempts");
  const maxCostValue = valueFrom(input, "maxRunCostUsd", "max_cost_usd");
  const hasTokenOverride = maxTokensValue !== undefined && maxTokensValue !== null;
  const hasMinuteOverride = maxMinutesValue !== undefined && maxMinutesValue !== null;
  const hasAttemptOverride = maxAttemptsValue !== undefined && maxAttemptsValue !== null;
  const hasCostOverride = maxCostValue !== undefined && maxCostValue !== null;
  const maxTokens = hasTokenOverride ? integerLimit(maxTokensValue) : base.max_tokens;
  const maxMinutes = hasMinuteOverride ? finiteNonNegative(maxMinutesValue) : base.max_minutes;
  const maxAttempts = hasAttemptOverride ? integerLimit(maxAttemptsValue) : base.max_attempts;
  const maxCostUsd = hasCostOverride ? finiteNonNegative(maxCostValue) : null;
  if (hasTokenOverride && maxTokens === null) throw new Error("--max-run-tokens must be a non-negative integer");
  if (hasMinuteOverride && maxMinutes === null) throw new Error("--max-run-minutes must be a non-negative number");
  if (hasAttemptOverride && maxAttempts === null) throw new Error("--max-run-attempts must be a non-negative integer");
  if (hasCostOverride && maxCostUsd === null) throw new Error("--max-run-cost-usd must be a non-negative number");
  if (maxAttempts === 0) throw new Error("--max-run-attempts must be greater than zero, or use --budget unlimited");
  if (maxMinutes === 0) throw new Error("--max-run-minutes must be greater than zero, or use --budget unlimited");
  return {
    version: BUDGET_VERSION,
    profile,
    max_tokens: maxTokens,
    max_minutes: maxMinutes,
    max_attempts: maxAttempts,
    max_cost_usd: maxCostUsd,
    cost_source: input.costSource || input.cost_source || null,
    started_at: input.startedAt || input.started_at || null,
    pass: true,
  };
}

export function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const value = (candidate) => {
    const number = Number(candidate);
    return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
  };
  const normalized = {
    input_tokens: value(usage.input_tokens ?? usage.inputTokens),
    cached_input_tokens: value(usage.cached_input_tokens ?? usage.cache_read_input_tokens ?? usage.cacheReadInputTokens),
    cache_creation_input_tokens: value(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens),
    output_tokens: value(usage.output_tokens ?? usage.outputTokens),
  };
  return Object.values(normalized).some((candidate) => candidate !== null) ? normalized : null;
}

function attemptIsModelCall(attempt) {
  return attempt?.model_attempt !== false && (
    attempt?.model_attempt === true ||
    attempt?.process_succeeded === true ||
    attempt?.result_recorded === true ||
    attempt?.exit_code !== null && attempt?.exit_code !== undefined ||
    attempt?.model_queue
  );
}

function usageComplete(usage) {
  const normalized = normalizeUsage(usage);
  return Boolean(normalized && normalized.input_tokens !== null && normalized.output_tokens !== null);
}

function observedTokens(usage) {
  const normalized = normalizeUsage(usage) || {};
  const input = normalized.input_tokens ?? ((normalized.cached_input_tokens ?? 0) + (normalized.cache_creation_input_tokens ?? 0));
  const output = normalized.output_tokens ?? 0;
  return input + output;
}

export function budgetSnapshot({ budget, attempts = [], now = Date.now(), activeStartedAtMs = null, activeProcessMs = 0, activeAttempts = 0 } = {}) {
  const records = (attempts || []).filter(attemptIsModelCall);
  const usage = { input_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };
  let observedTokensTotal = 0;
  let processMs = 0;
  let observedCostUsd = 0;
  let costKnown = true;
  let unknownUsageAttempts = 0;
  let lastAttemptTokens = 0;
  for (const attempt of records) {
    const normalized = normalizeUsage(attempt.usage);
    const completed = attempt.process_succeeded === true || attempt.result_recorded === true || attempt.exit_code === 0;
    if (completed && !usageComplete(normalized)) unknownUsageAttempts += 1;
    if (normalized) {
      for (const key of Object.keys(usage)) usage[key] += normalized[key] ?? 0;
      const tokens = observedTokens(normalized);
      observedTokensTotal += tokens;
      lastAttemptTokens = tokens;
    }
    if (Number.isFinite(attempt.duration_ms) && attempt.duration_ms >= 0) processMs += attempt.duration_ms;
    if (Number.isFinite(attempt.cost_usd) && attempt.cost_usd >= 0) observedCostUsd += attempt.cost_usd;
    else if (completed && budget?.max_cost_usd !== null && budget?.max_cost_usd !== undefined) costKnown = false;
  }
  if (Number.isFinite(activeStartedAtMs) && activeStartedAtMs > 0) processMs += Math.max(0, now - activeStartedAtMs);
  if (Number.isFinite(activeProcessMs) && activeProcessMs > 0) processMs += activeProcessMs;
  const maxTokens = budget?.max_tokens ?? null;
  const maxMinutes = budget?.max_minutes ?? null;
  const maxCostUsd = budget?.max_cost_usd ?? null;
  return {
    version: BUDGET_VERSION,
    attempts: records.length + Math.max(0, Math.trunc(Number(activeAttempts) || 0)),
    observed_tokens: observedTokensTotal,
    usage,
    usage_complete: unknownUsageAttempts === 0,
    unknown_usage_attempts: unknownUsageAttempts,
    process_ms: processMs,
    process_minutes: processMs / 60_000,
    observed_cost_usd: costKnown ? observedCostUsd : null,
    cost_known: maxCostUsd === null ? true : costKnown,
    token_overrun: maxTokens === null ? 0 : Math.max(0, observedTokensTotal - maxTokens),
    time_overrun_minutes: maxMinutes === null ? 0 : Math.max(0, processMs / 60_000 - maxMinutes),
    cost_overrun_usd: maxCostUsd === null || !costKnown ? 0 : Math.max(0, observedCostUsd - maxCostUsd),
    last_attempt_tokens: lastAttemptTokens,
    max_tokens: maxTokens,
    max_minutes: maxMinutes,
    max_attempts: budget?.max_attempts ?? null,
    max_cost_usd: maxCostUsd,
  };
}

export function budgetDecision({ budget, snapshot, allowCompletedOverrun = false } = {}) {
  const rawState = snapshot || budgetSnapshot({ budget });
  const state = {
    ...rawState,
    max_tokens: budget?.max_tokens ?? rawState.max_tokens ?? null,
    max_minutes: budget?.max_minutes ?? rawState.max_minutes ?? null,
    max_attempts: budget?.max_attempts ?? rawState.max_attempts ?? null,
    max_cost_usd: budget?.max_cost_usd ?? rawState.max_cost_usd ?? null,
  };
  state.token_overrun = state.max_tokens === null ? 0 : Math.max(0, state.observed_tokens - state.max_tokens);
  state.time_overrun_minutes = state.max_minutes === null ? 0 : Math.max(0, state.process_minutes - state.max_minutes);
  state.cost_overrun_usd = state.max_cost_usd === null || !state.cost_known ? 0 : Math.max(0, state.observed_cost_usd - state.max_cost_usd);
  if (!state.usage_complete) {
    return { allowed: false, status: "waiting_budget", reason: "unknown_usage", snapshot: state };
  }
  if (!state.cost_known) {
    return { allowed: false, status: "waiting_budget", reason: "cost_unknown", snapshot: state };
  }
  if (state.max_attempts !== null && state.attempts >= state.max_attempts) {
    return { allowed: false, status: "waiting_budget", reason: "attempts_exhausted", snapshot: state };
  }
  if (state.max_tokens !== null && state.observed_tokens >= state.max_tokens) {
    if (allowCompletedOverrun && state.token_overrun > 0 && state.token_overrun <= state.last_attempt_tokens) {
      return { allowed: true, status: "within_budget_with_token_overrun", reason: "token_overrun_reportable", snapshot: state };
    }
    return { allowed: false, status: "waiting_budget", reason: "tokens_exhausted", snapshot: state };
  }
  if (state.max_minutes !== null && state.process_minutes >= state.max_minutes) {
    return { allowed: false, status: "waiting_budget", reason: "time_exhausted", snapshot: state };
  }
  if (state.max_cost_usd !== null && state.observed_cost_usd >= state.max_cost_usd) {
    return { allowed: false, status: "waiting_budget", reason: "cost_exhausted", snapshot: state };
  }
  return { allowed: true, status: "within_budget", reason: null, snapshot: state };
}

export function budgetPass({ budget, snapshot } = {}) {
  const decision = budgetDecision({ budget, snapshot, allowCompletedOverrun: true });
  const state = decision.snapshot;
  if (!state.usage_complete || !state.cost_known) return false;
  if (state.time_overrun_minutes > 0 || state.cost_overrun_usd > 0) return false;
  if (state.token_overrun > 0 && state.token_overrun > state.last_attempt_tokens) return false;
  return true;
}

export function budgetLimitIncrease(previous, next) {
  const oldBudget = normalizeRunBudget(previous || { profile: "legacy-unlimited", legacy: true });
  const newBudget = normalizeRunBudget(next || oldBudget);
  const comparable = ["max_tokens", "max_minutes", "max_attempts", "max_cost_usd"];
  for (const key of comparable) {
    const oldValue = oldBudget[key];
    const newValue = newBudget[key];
    if (oldValue !== null && newValue !== null && newValue < oldValue) {
      throw new Error(`Resume budget may only increase ${key}: ${oldValue} -> ${newValue}`);
    }
    if (oldValue !== null && newValue === null && newBudget.profile !== "unlimited") {
      throw new Error(`Resume budget may not remove ${key} without explicitly selecting --budget unlimited`);
    }
    if (oldValue === null && newValue !== null) {
      throw new Error(`Resume budget may not reduce unlimited ${key}`);
    }
  }
  return { ...oldBudget, ...newBudget, started_at: oldBudget.started_at || newBudget.started_at || null };
}

export async function readPricingFile(file) {
  if (!file) throw new Error("A pricing file is required for --max-run-cost-usd");
  const raw = await readFile(file, "utf8");
  const parsed = JSON.parse(raw);
  const models = parsed?.models && typeof parsed.models === "object" ? parsed.models : parsed;
  const entries = Object.entries(models || {}).filter(([, value]) => value && typeof value === "object");
  const valid = entries.filter(([, value]) => ["input_per_1m", "output_per_1m", "input", "output"].some((key) => Number.isFinite(Number(value[key]))));
  if (!valid.length) throw new Error("Pricing file must contain at least one model with numeric input/output rates");
  return {
    path: file,
    sha256: createHash("sha256").update(raw).digest("hex"),
    models: Object.fromEntries(valid),
  };
}

export function priceUsage(usage, pricing, model = null) {
  const normalized = normalizeUsage(usage);
  if (!normalized || !pricing?.models) return null;
  const rate = pricing.models[model] || pricing.models.default || Object.values(pricing.models)[0];
  if (!rate) return null;
  const inputRate = Number(rate.input_per_1m ?? rate.input);
  const outputRate = Number(rate.output_per_1m ?? rate.output);
  if (!Number.isFinite(inputRate) || !Number.isFinite(outputRate)) return null;
  const inputTokens = normalized.input_tokens ?? ((normalized.cached_input_tokens ?? 0) + (normalized.cache_creation_input_tokens ?? 0));
  const outputTokens = normalized.output_tokens;
  if (!Number.isFinite(outputTokens)) return null;
  return (inputTokens / 1_000_000) * inputRate + (outputTokens / 1_000_000) * outputRate;
}
