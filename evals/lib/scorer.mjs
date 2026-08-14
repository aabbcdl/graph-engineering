import { createHash } from "node:crypto";

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function finite(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function usageTotal(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = finite(usage.input_tokens);
  const output = finite(usage.output_tokens);
  if (input === null || output === null) return null;
  return input + output;
}

function wilsonInterval(successes, total, z = 1.96) {
  if (!Number.isInteger(total) || total <= 0) return null;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function comparabilityErrors(pair) {
  const errors = [];
  const left = pair.graph;
  const right = pair.baseline;
  for (const field of ["fixture_sha256", "goal_sha256", "model", "reasoning_effort", "token_budget"]) {
    if (left?.[field] !== right?.[field]) errors.push(`${field} differs: graph=${left?.[field]} baseline=${right?.[field]}`);
  }
  for (const [name, arm] of [["graph", left], ["baseline", right]]) {
    if (!arm?.fixture_sha256) errors.push(`${name} fixture hash is missing`);
    if (!arm?.goal_sha256) errors.push(`${name} goal hash is missing`);
    if (!arm?.model) errors.push(`${name} actual model is missing`);
    if (!arm?.reasoning_effort) errors.push(`${name} actual reasoning effort is missing`);
    if (!Number.isFinite(arm?.token_budget) || arm.token_budget <= 0) errors.push(`${name} token budget is invalid`);
    if (!arm || arm.status !== "completed") errors.push(`${name} did not complete`);
    if (Array.isArray(arm?.harness_errors) && arm.harness_errors.length) {
      errors.push(`${name} adapter contract failed: ${arm.harness_errors.join("; ")}`);
    }
    const used = usageTotal(arm?.usage);
    if (used === null) errors.push(`${name} token usage is unknown`);
    else if (Number.isFinite(arm.token_budget) && used > arm.token_budget) {
      errors.push(`${name} exceeded token budget: ${used}/${arm.token_budget}`);
    }
  }
  return errors;
}

function armMetrics(arm, truth) {
  const knownDefects = new Set((truth.defects || []).map((defect) => defect.id));
  const findings = Array.isArray(arm.findings) ? arm.findings : [];
  const detected = new Set(
    findings
      .filter((finding) => finding.validated !== false && knownDefects.has(finding.defect_id))
      .map((finding) => finding.defect_id),
  );
  const falsePositives = findings.filter(
    (finding) => finding.validated !== false && (!finding.defect_id || !knownDefects.has(finding.defect_id)),
  ).length;
  const fixed = new Set(
    findings
      .filter((finding) => finding.fixed === true && finding.repair_verified === true && knownDefects.has(finding.defect_id))
      .map((finding) => finding.defect_id),
  );
  const regressionFailures = (arm.regression_checks || []).filter((check) => check.status !== "pass").length;
  const expected = knownDefects.size;
  return {
    expected_defects: expected,
    validated_defects: detected.size,
    validated_recall: expected ? detected.size / expected : 1,
    false_positives: falsePositives,
    precision: detected.size + falsePositives > 0 ? detected.size / (detected.size + falsePositives) : expected ? 0 : 1,
    verified_repairs: fixed.size,
    repair_rate: expected ? fixed.size / expected : 1,
    regression_failures: regressionFailures,
    completed_gates: arm.completed_gates === true,
    wall_ms: finite(arm.wall_ms),
    queue_ms: finite(arm.queue_ms),
    tokens: usageTotal(arm.usage),
  };
}

function scorePair(pair, truth) {
  const errors = comparabilityErrors(pair);
  return {
    fixture_id: pair.fixture_id,
    repetition: pair.repetition,
    comparable: errors.length === 0,
    comparability_errors: errors,
    graph: armMetrics(pair.graph || {}, truth),
    baseline: armMetrics(pair.baseline || {}, truth),
  };
}

function average(values) {
  const known = values.filter(Number.isFinite);
  return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
}

function tCritical95(degreesOfFreedom) {
  const table = [
    null,
    12.706,
    4.303,
    3.182,
    2.776,
    2.571,
    2.447,
    2.365,
    2.306,
    2.262,
    2.228,
    2.201,
    2.179,
    2.16,
    2.145,
    2.131,
    2.12,
    2.11,
    2.101,
    2.093,
    2.086,
    2.08,
    2.074,
    2.069,
    2.064,
    2.06,
    2.056,
    2.052,
    2.048,
    2.045,
    2.042,
  ];
  if (degreesOfFreedom < table.length) return table[degreesOfFreedom];
  if (degreesOfFreedom <= 40) return 2.021;
  if (degreesOfFreedom <= 60) return 2.0;
  if (degreesOfFreedom <= 120) return 1.98;
  return 1.96;
}

function pairedMeanInterval(values, confidence = 0.95) {
  const known = values.filter(Number.isFinite);
  if (!known.length) return null;
  const mean = average(known);
  if (known.length === 1) return { low: null, high: null };
  const variance = known.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (known.length - 1);
  const standardError = Math.sqrt(variance / known.length);
  const critical = confidence === 0.95 ? tCritical95(known.length - 1) : null;
  if (!Number.isFinite(critical)) throw new Error(`Unsupported confidence level: ${confidence}`);
  const margin = critical * standardError;
  return { low: mean - margin, high: mean + margin };
}

function aggregatePairs(scoredPairs, minimumPairs = 5) {
  const comparable = scoredPairs.filter((pair) => pair.comparable);
  const incomplete = scoredPairs.length - comparable.length;
  const summarize = (arm) => ({
    samples: comparable.length,
    validated_recall: average(comparable.map((pair) => pair[arm].validated_recall)),
    precision: average(comparable.map((pair) => pair[arm].precision)),
    repair_rate: average(comparable.map((pair) => pair[arm].repair_rate)),
    regression_failures: comparable.reduce((sum, pair) => sum + pair[arm].regression_failures, 0),
    completed_runs: comparable.filter((pair) => pair[arm].completed_gates).length,
    completion_interval_95: wilsonInterval(comparable.filter((pair) => pair[arm].completed_gates).length, comparable.length),
    wall_ms: average(comparable.map((pair) => pair[arm].wall_ms)),
    queue_ms: average(comparable.map((pair) => pair[arm].queue_ms)),
    tokens: average(comparable.map((pair) => pair[arm].tokens)),
  });
  const graph = summarize("graph");
  const baseline = summarize("baseline");
  const claimReady = comparable.length >= minimumPairs && incomplete === 0;
  const pairedDeltas = {
    validated_recall: comparable.map((pair) => pair.graph.validated_recall - pair.baseline.validated_recall),
    precision: comparable.map((pair) => pair.graph.precision - pair.baseline.precision),
    repair_rate: comparable.map((pair) => pair.graph.repair_rate - pair.baseline.repair_rate),
    completion_rate: comparable.map((pair) => Number(pair.graph.completed_gates) - Number(pair.baseline.completed_gates)),
    regression_failures: comparable.map((pair) => pair.graph.regression_failures - pair.baseline.regression_failures),
    wall_ms: comparable.map((pair) => pair.graph.wall_ms - pair.baseline.wall_ms),
    tokens: comparable.map((pair) => pair.graph.tokens - pair.baseline.tokens),
  };
  const deltaIntervals = Object.fromEntries(
    Object.entries(pairedDeltas).map(([metric, values]) => [metric, pairedMeanInterval(values)]),
  );
  const advantages = [];
  if (claimReady) {
    const positive = [
      ["validated_recall", "validated_defect_recall"],
      ["precision", "finding_precision"],
      ["repair_rate", "verified_repair_rate"],
      ["completion_rate", "completion_rate"],
    ];
    const negative = [
      ["regression_failures", "fewer_regression_failures"],
      ["wall_ms", "lower_wall_time"],
      ["tokens", "lower_token_use"],
    ];
    for (const [metric, label] of positive) {
      if (Number.isFinite(deltaIntervals[metric]?.low) && deltaIntervals[metric].low > 0) advantages.push(label);
    }
    for (const [metric, label] of negative) {
      if (Number.isFinite(deltaIntervals[metric]?.high) && deltaIntervals[metric].high < 0) advantages.push(label);
    }
  }
  return {
    version: 1,
    samples_total: scoredPairs.length,
    samples_comparable: comparable.length,
    samples_rejected: incomplete,
    minimum_pairs_for_claim: minimumPairs,
    claim_ready: claimReady,
    graph,
    baseline,
    deltas: {
      validated_recall: graph.validated_recall === null || baseline.validated_recall === null ? null : graph.validated_recall - baseline.validated_recall,
      precision: graph.precision === null || baseline.precision === null ? null : graph.precision - baseline.precision,
      repair_rate: graph.repair_rate === null || baseline.repair_rate === null ? null : graph.repair_rate - baseline.repair_rate,
      completion_rate: comparable.length ? (graph.completed_runs - baseline.completed_runs) / comparable.length : null,
      wall_ms: graph.wall_ms === null || baseline.wall_ms === null ? null : graph.wall_ms - baseline.wall_ms,
      tokens: graph.tokens === null || baseline.tokens === null ? null : graph.tokens - baseline.tokens,
    },
    delta_intervals_95: deltaIntervals,
    statistically_supported_advantages: advantages,
    conclusion: claimReady
      ? advantages.length
        ? `Comparable sample threshold reached. Report only these fixture-scoped advantages with paired 95% intervals: ${advantages.join(", ")}. Do not generalize beyond these fixtures.`
        : "Comparable sample threshold reached, but no measured advantage has a paired 95% interval wholly on the favorable side. Report deltas as descriptive fixture results only; do not generalize beyond these fixtures."
      : `No performance claim allowed: need at least ${minimumPairs} complete comparable pairs and currently have ${comparable.length}.`,
    rejected_pairs: scoredPairs.filter((pair) => !pair.comparable).map((pair) => ({
      fixture_id: pair.fixture_id,
      repetition: pair.repetition,
      errors: pair.comparability_errors,
    })),
    report_sha256: sha256(JSON.stringify(scoredPairs)),
  };
}

export { aggregatePairs, armMetrics, comparabilityErrors, pairedMeanInterval, scorePair, usageTotal, wilsonInterval };
