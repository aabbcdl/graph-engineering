import assert from "node:assert/strict";
import test from "node:test";
import { aggregatePairs, comparabilityErrors, scorePair } from "../lib/scorer.mjs";

const truth = { defects: [{ id: "defect-1" }, { id: "defect-2" }] };

function arm(overrides = {}) {
  return {
    status: "completed",
    fixture_sha256: "fixture-hash",
    goal_sha256: "goal-hash",
    model: "same-model",
    reasoning_effort: "high",
    token_budget: 1000,
    usage: { input_tokens: 300, output_tokens: 200 },
    findings: [],
    regression_checks: [],
    completed_gates: true,
    wall_ms: 100,
    queue_ms: 0,
    ...overrides,
  };
}

function pair(repetition = 1, graph = arm(), baseline = arm()) {
  return { fixture_id: "fixture", repetition, graph, baseline };
}

test("a comparable pair scores validated defects, repairs, and false positives", () => {
  const graph = arm({
    findings: [
      { defect_id: "defect-1", validated: true, fixed: true, repair_verified: true },
      { defect_id: "not-in-truth", validated: true },
    ],
  });
  const baseline = arm({ findings: [{ defect_id: "defect-2", validated: true }] });
  const scored = scorePair(pair(1, graph, baseline), truth);
  assert.equal(scored.comparable, true);
  assert.equal(scored.graph.validated_recall, 0.5);
  assert.equal(scored.graph.precision, 0.5);
  assert.equal(scored.graph.repair_rate, 0.5);
  assert.equal(scored.baseline.validated_recall, 0.5);
});

test("snapshot, goal, model, effort, and budget mismatches reject a pair", () => {
  for (const [field, value] of [
    ["fixture_sha256", "other-fixture"],
    ["goal_sha256", "other-goal"],
    ["model", "other-model"],
    ["reasoning_effort", "medium"],
    ["token_budget", 2000],
  ]) {
    const errors = comparabilityErrors(pair(1, arm(), arm({ [field]: value })));
    assert.ok(errors.some((error) => error.startsWith(`${field} differs`)), `${field} mismatch was accepted`);
  }
});

test("a token-budget overrun and an adapter contract failure reject a pair", () => {
  const errors = comparabilityErrors(pair(1, arm({ usage: { input_tokens: 900, output_tokens: 200 } }), arm({ harness_errors: ["wrong model"] })));
  assert.ok(errors.some((error) => /exceeded token budget/.test(error)));
  assert.ok(errors.some((error) => /adapter contract failed/.test(error)));
});

test("fewer than five comparable pairs prohibit performance claims", () => {
  const scored = Array.from({ length: 4 }, (_, index) => scorePair(pair(index + 1), truth));
  const report = aggregatePairs(scored, 5);
  assert.equal(report.claim_ready, false);
  assert.match(report.conclusion, /No performance claim allowed/);
});

test("five valid pairs permit only measured fixture-scoped conclusions", () => {
  const scored = Array.from({ length: 5 }, (_, index) => scorePair(pair(index + 1), truth));
  const report = aggregatePairs(scored, 5);
  assert.equal(report.claim_ready, true);
  assert.equal(report.samples_comparable, 5);
  assert.match(report.conclusion, /do not generalize beyond these fixtures/);
  assert.deepEqual(report.statistically_supported_advantages, []);
  assert.deepEqual(report.delta_intervals_95.validated_recall, { low: 0, high: 0 });
});

test("an advantage is named only when its paired 95 percent interval stays on the favorable side", () => {
  const scored = Array.from({ length: 5 }, (_, index) => {
    const graph = arm({
      findings: [
        { defect_id: "defect-1", validated: true, fixed: true, repair_verified: true },
        { defect_id: "defect-2", validated: true, fixed: true, repair_verified: true },
      ],
      wall_ms: 80,
      usage: { input_tokens: 200, output_tokens: 200 },
    });
    const baseline = arm({
      findings: [{ defect_id: "defect-1", validated: true }],
      wall_ms: 100,
      usage: { input_tokens: 300, output_tokens: 200 },
    });
    return scorePair(pair(index + 1, graph, baseline), truth);
  });
  const report = aggregatePairs(scored, 5);
  assert.deepEqual(report.delta_intervals_95.validated_recall, { low: 0.5, high: 0.5 });
  assert.deepEqual(report.delta_intervals_95.wall_ms, { low: -20, high: -20 });
  assert.deepEqual(report.delta_intervals_95.tokens, { low: -100, high: -100 });
  assert.deepEqual(report.statistically_supported_advantages.sort(), [
    "lower_token_use",
    "lower_wall_time",
    "validated_defect_recall",
    "verified_repair_rate",
  ]);
});
