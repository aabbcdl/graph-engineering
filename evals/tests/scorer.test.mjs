import assert from "node:assert/strict";
import test from "node:test";
import { aggregatePairs, classifyRejection, comparabilityErrors, scorePair } from "../lib/scorer.mjs";

const truth = { defects: [{ id: "defect-1" }, { id: "defect-2" }] };
const harness = {
  revision: "test-revision",
  runner_sha256: "runner-hash-1",
  graph_run_version_expected: 3,
};

function arm(overrides = {}) {
  return {
    status: "completed",
    fixture_sha256: "fixture-hash",
    goal_sha256: "goal-hash",
    model: "same-model",
    reasoning_effort: "high",
    token_budget: 1000,
    usage: { input_tokens: 300, output_tokens: 200 },
    harness_identity: { runner_sha256: "runner-hash-1", run_version: 3 },
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
  const scored = scorePair(pair(1, graph, baseline), truth, harness);
  assert.equal(scored.comparable, true);
  assert.equal(scored.graph.validated_recall, 0.5);
  assert.equal(scored.graph.precision, 0.5);
  assert.equal(scored.graph.repair_rate, 0.5);
  assert.equal(scored.baseline.validated_recall, 0.5);
});

test("cost efficiency metrics normalize quality by observed token use", () => {
  const graph = arm({
    findings: [
      { defect_id: "defect-1", validated: true, fixed: true, repair_verified: true },
      { defect_id: "defect-2", validated: true, fixed: true, repair_verified: true },
    ],
    usage: { input_tokens: 200, output_tokens: 200 },
  });
  const baseline = arm({
    findings: [{ defect_id: "defect-1", validated: true }],
    usage: { input_tokens: 300, output_tokens: 200 },
  });
  const scored = scorePair(pair(1, graph, baseline), truth, harness);
  assert.equal(scored.graph.validated_defects_per_mtok, 2 * 1_000_000 / 400);
  assert.equal(scored.graph.verified_repairs_per_mtok, 2 * 1_000_000 / 400);
  assert.equal(scored.graph.tokens_per_validated_defect, 200);
  assert.equal(scored.baseline.validated_defects_per_mtok, 1 * 1_000_000 / 500);
  assert.equal(scored.baseline.tokens_per_validated_defect, 500);
});

test("snapshot, goal, model, effort, and budget mismatches reject a pair", () => {
  for (const [field, value] of [
    ["fixture_sha256", "other-fixture"],
    ["goal_sha256", "other-goal"],
    ["model", "other-model"],
    ["reasoning_effort", "medium"],
    ["token_budget", 2000],
  ]) {
    const errors = comparabilityErrors(pair(1, arm(), arm({ [field]: value })), harness);
    assert.ok(errors.some((error) => error.startsWith(`${field} differs`)), `${field} mismatch was accepted`);
  }
});

test("a token-budget overrun and an adapter contract failure reject a pair", () => {
  const errors = comparabilityErrors(pair(1, arm({ usage: { input_tokens: 900, output_tokens: 200 } }), arm({ harness_errors: ["wrong model"] })), harness);
  assert.ok(errors.some((error) => /exceeded token budget/.test(error)));
  assert.ok(errors.some((error) => /adapter contract failed/.test(error)));
});

test("missing adapter identity rejects a pair as an infrastructure-invalid sample", () => {
  const legacy = arm({ harness_identity: undefined });
  const scored = scorePair(pair(1, legacy, arm()), truth, harness);
  assert.equal(scored.comparable, false);
  assert.ok(scored.comparability_errors.some((error) => /graph adapter runner identity is missing/.test(error)));
  assert.equal(scored.rejection_class, "infrastructure");
});

test("runner identity mismatch between arms rejects a pair", () => {
  const mismatched = comparabilityErrors(
    pair(1, arm(), arm({ harness_identity: { runner_sha256: "runner-hash-2", run_version: 3 } })),
    harness,
  );
  assert.ok(mismatched.some((error) => /runner identity differs between arms/.test(error)));
});

test("a Run schema version that differs from the harness expectation rejects a pair", () => {
  const stale = comparabilityErrors(
    pair(1, arm({ harness_identity: { runner_sha256: "runner-hash-1", run_version: 2 } }), arm()),
    harness,
  );
  assert.ok(stale.some((error) => /Run schema version 2 differs from harness expectation 3/.test(error)));
  const unreported = comparabilityErrors(
    pair(1, arm({ harness_identity: { runner_sha256: "runner-hash-1", run_version: null } }), arm()),
    harness,
  );
  assert.ok(unreported.some((error) => /graph adapter did not report its Run schema version/.test(error)));
});

test("rejection classes separate negative results from infrastructure failures", () => {
  assert.equal(classifyRejection(["graph did not complete"]), "negative_result");
  assert.equal(classifyRejection(["graph exceeded token budget: 1300/1000"]), "negative_result");
  assert.equal(classifyRejection(["graph did not complete", "baseline adapter contract failed: wrong model"]), "infrastructure");
  assert.equal(classifyRejection(["graph adapter runner identity is missing"]), "infrastructure");
  assert.equal(classifyRejection([]), null);

  const overran = scorePair(
    pair(1, arm({ usage: { input_tokens: 1000, output_tokens: 300 } }), arm()),
    truth,
    harness,
  );
  assert.equal(overran.comparable, false);
  assert.equal(overran.rejection_class, "negative_result");
  const broken = scorePair(
    pair(2, arm({ harness_errors: ["adapter crashed"] }), arm()),
    truth,
    harness,
  );
  assert.equal(broken.rejection_class, "infrastructure");
  const report = aggregatePairs([overran, broken], 5, harness);
  assert.equal(report.samples_rejected_negative, 1);
  assert.equal(report.samples_rejected_infrastructure, 1);
  assert.equal(report.samples_rejected, 2);
});

test("fewer than five comparable pairs prohibit performance claims", () => {
  const scored = Array.from({ length: 4 }, (_, index) => scorePair(pair(index + 1), truth, harness));
  const report = aggregatePairs(scored, 5, harness);
  assert.equal(report.claim_ready, false);
  assert.equal(report.harness_binding, "bound");
  assert.match(report.conclusion, /No performance claim allowed/);
});

test("five valid pairs permit only measured fixture-scoped conclusions", () => {
  const scored = Array.from({ length: 5 }, (_, index) => scorePair(pair(index + 1), truth, harness));
  const report = aggregatePairs(scored, 5, harness);
  assert.equal(report.claim_ready, true);
  assert.equal(report.samples_comparable, 5);
  assert.equal(report.version, 2);
  assert.match(report.conclusion, /do not generalize beyond these fixtures/);
  assert.deepEqual(report.statistically_supported_advantages, []);
  assert.deepEqual(report.delta_intervals_95.validated_recall, { low: 0, high: 0 });
});

test("score inputs without harness binding stay descriptive and never reach claim readiness", () => {
  const scored = Array.from({ length: 5 }, (_, index) => scorePair(pair(index + 1), truth, harness));
  const unbound = aggregatePairs(scored, 5, null);
  assert.equal(unbound.claim_ready, false);
  assert.equal(unbound.harness_binding, "missing");
  assert.equal(unbound.harness, undefined);
  assert.match(unbound.conclusion, /no harness binding/);
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
    return scorePair(pair(index + 1, graph, baseline), truth, harness);
  });
  const report = aggregatePairs(scored, 5, harness);
  assert.deepEqual(report.delta_intervals_95.validated_recall, { low: 0.5, high: 0.5 });
  assert.deepEqual(report.delta_intervals_95.wall_ms, { low: -20, high: -20 });
  assert.deepEqual(report.delta_intervals_95.tokens, { low: -100, high: -100 });
  assert.deepEqual(report.delta_intervals_95.validated_defects_per_mtok, { low: 3000, high: 3000 });
  assert.deepEqual(report.delta_intervals_95.tokens_per_validated_defect, { low: -300, high: -300 });
  assert.deepEqual(report.statistically_supported_advantages.sort(), [
    "fewer_tokens_per_validated_defect",
    "lower_token_use",
    "lower_wall_time",
    "validated_defect_recall",
    "validated_defects_per_million_tokens",
    "verified_repair_rate",
    "verified_repairs_per_million_tokens",
  ]);
});
