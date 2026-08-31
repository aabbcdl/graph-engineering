import { createHash } from "node:crypto";

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function finite(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveBudget(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nonNegativeDuration(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function usageTotal(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = tokenCount(usage.input_tokens);
  const output = tokenCount(usage.output_tokens);
  if (input === null || output === null) return null;
  if (input > Number.MAX_SAFE_INTEGER - output) return null;
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

// A rejected pair is a negative result when every error describes what the
// measured system actually did (unfinished run, budget overrun). Any error
// about the measurement itself (adapter contract, identity, unknown usage,
// declaration mismatch) makes the sample infrastructure-invalid instead.
const NEGATIVE_RESULT_PATTERNS = [/did not complete/, /exceeded token budget/, /regression gates did not pass/];
const MINIMUM_PAIRS_FOR_CLAIM = 5;
const HARNESS_HASH_FIELDS = [
  "runner_sha256",
  "runtime_sha256",
  "evals_lib_sha256",
  "adapters_sha256",
  "manifest_sha256",
];
const HARNESS_CONTRACT_FIELDS = ["budget_contract", "toolchain_contract"];
const HARNESS_ENVIRONMENT_FIELDS = ["node", "platform", "arch"];

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function gitRevision(value) {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

function sha256String(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function harnessValidationErrors(harness) {
  if (harness === null || harness === undefined) return ["harness binding is missing"];
  if (typeof harness !== "object" || Array.isArray(harness)) return ["harness binding is not an object"];
  const errors = [];
  if (!gitRevision(harness.revision)) errors.push("harness revision is missing or invalid");
  for (const field of HARNESS_HASH_FIELDS) {
    if (!sha256String(harness[field])) errors.push(`harness ${field} is missing or invalid`);
  }
  if (!Number.isInteger(harness.graph_run_version_expected) || harness.graph_run_version_expected <= 0) {
    errors.push("harness graph Run schema version is missing or invalid");
  }
  for (const field of HARNESS_ENVIRONMENT_FIELDS) {
    if (!nonEmptyString(harness.environment?.[field])) errors.push(`harness environment ${field} is missing`);
  }
  if (harness.budget_contract !== null && harness.budget_contract !== undefined) {
    const contract = harness.budget_contract;
    if (contract?.token_scope !== "aggregate" || contract?.wall_time_scope !== "aggregate" || contract?.enforcement !== "hard") {
      errors.push("harness budget_contract is invalid");
    }
  }
  if (harness.toolchain_contract !== null && harness.toolchain_contract !== undefined) {
    const contract = harness.toolchain_contract;
    if (
      !nonEmptyString(contract?.ecosystem) ||
      !nonEmptyString(contract?.version) ||
      !nonEmptyString(contract?.platform) ||
      !sha256String(contract?.binary_sha256)
    ) {
      errors.push("harness toolchain_contract is invalid");
    }
  }
  return errors;
}

function harnessBinding(harness) {
  if (harness === null || harness === undefined) return "missing";
  return harnessValidationErrors(harness).length ? "invalid" : "bound";
}

function identityFieldErrors(name, identity, harness) {
  const errors = [];
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    return [`${name} adapter runner identity is missing`];
  }
  if (!identity.runner_sha256) errors.push(`${name} adapter runner identity is missing`);
  for (const field of ["revision", ...HARNESS_HASH_FIELDS]) {
    if (!identity[field]) {
      if (field !== "runner_sha256") errors.push(`${name} adapter ${field} is missing`);
      continue;
    }
    if (harness && identity[field] !== harness[field]) {
      errors.push(`${name} ${field} differs from harness`);
    }
  }
  if (harness) {
    if (identity.graph_run_version_expected !== harness.graph_run_version_expected) {
      errors.push(`${name} graph Run schema version expectation differs from harness`);
    }
    for (const field of HARNESS_ENVIRONMENT_FIELDS) {
      if (identity.environment?.[field] !== harness.environment?.[field]) {
        errors.push(`${name} environment ${field} differs from harness`);
      }
    }
    for (const field of HARNESS_CONTRACT_FIELDS) {
      if (canonicalJson(identity[field] ?? null) !== canonicalJson(harness[field] ?? null)) {
        errors.push(`${name} ${field} differs from harness`);
      }
    }
  }
  return errors;
}

function pairedDifference(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) ? left - right : null;
}

function validateMinimumPairs(value) {
  if (!Number.isSafeInteger(value) || value < MINIMUM_PAIRS_FOR_CLAIM) {
    throw new Error(`minimum pair count must be an integer of at least ${MINIMUM_PAIRS_FOR_CLAIM}`);
  }
  return value;
}

function validatePairIdentities(scoredPairs) {
  if (!Array.isArray(scoredPairs)) throw new Error("scored pairs must be an array");
  const identities = new Set();
  for (const pair of scoredPairs) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(pair?.fixture_id || "")) {
      throw new Error("scored pair fixture_id is missing or invalid");
    }
    if (!Number.isSafeInteger(pair.repetition) || pair.repetition <= 0) {
      throw new Error(`scored pair repetition is invalid for fixture ${pair.fixture_id}`);
    }
    const identity = `${pair.fixture_id.toLowerCase()}/${pair.repetition}`;
    if (identities.has(identity)) throw new Error(`duplicate scored pair identity: ${identity}`);
    identities.add(identity);
  }
}

function classifyRejection(errors) {
  if (!errors.length) return null;
  const infrastructure = errors.some((error) => !NEGATIVE_RESULT_PATTERNS.some((pattern) => pattern.test(error)));
  return infrastructure ? "infrastructure" : "negative_result";
}

function comparabilityErrors(pair, harness = null) {
  const errors = [];
  const harnessErrors = harnessValidationErrors(harness);
  errors.push(...harnessErrors);
  const left = pair.graph;
  const right = pair.baseline;
  for (const field of ["fixture_sha256", "goal_sha256", "model", "reasoning_effort", "token_budget", "timeout_minutes"]) {
    if (left?.[field] !== right?.[field]) errors.push(`${field} differs: graph=${left?.[field]} baseline=${right?.[field]}`);
  }
  for (const [name, arm] of [["graph", left], ["baseline", right]]) {
    if (!arm?.fixture_sha256) errors.push(`${name} fixture hash is missing`);
    if (!arm?.goal_sha256) errors.push(`${name} goal hash is missing`);
    if (!arm?.model) errors.push(`${name} actual model is missing`);
    if (!arm?.reasoning_effort) errors.push(`${name} actual reasoning effort is missing`);
    if (!positiveBudget(arm?.token_budget)) errors.push(`${name} token budget is invalid`);
    if (!positiveBudget(arm?.timeout_minutes)) errors.push(`${name} timeout budget is invalid`);
    if (!arm || arm.status !== "completed") errors.push(`${name} did not complete`);
    if (typeof arm?.completed_gates !== "boolean") errors.push(`${name} completed_gates is missing or invalid`);
    else if (!arm.completed_gates) errors.push(`${name} did not complete declared gates`);
    if (!Array.isArray(arm?.regression_checks) || arm.regression_checks.length === 0) {
      errors.push(`${name} regression checks are missing or invalid`);
    }
    else if (arm.regression_checks.some((check) => check?.status !== "pass")) {
      errors.push(`${name} regression gates did not pass`);
    }
    if (!nonNegativeDuration(arm?.wall_ms)) errors.push(`${name} wall time is missing or invalid`);
    if (!nonNegativeDuration(arm?.queue_ms)) errors.push(`${name} queue time is missing or invalid`);
    if (Array.isArray(arm?.harness_errors) && arm.harness_errors.length) {
      errors.push(`${name} adapter contract failed: ${arm.harness_errors.join("; ")}`);
    }
    const used = usageTotal(arm?.usage);
    if (used === null) errors.push(`${name} token usage is unknown`);
    else if (Number.isFinite(arm.token_budget) && used > arm.token_budget) {
      errors.push(`${name} exceeded token budget: ${used}/${arm.token_budget}`);
    }
    errors.push(...identityFieldErrors(name, arm?.harness_identity, harness));
    if (harness?.budget_contract) {
      const enforcement = arm?.budget_enforcement;
      if (
        !enforcement ||
        enforcement.token_scope !== harness.budget_contract.token_scope ||
        enforcement.wall_time_scope !== harness.budget_contract.wall_time_scope ||
        enforcement.enforcement !== harness.budget_contract.enforcement
      ) {
        errors.push(`${name} budget enforcement does not satisfy the harness contract`);
      }
    }
  }
  const graphIdentity = left?.harness_identity;
  const baselineIdentity = right?.harness_identity;
  if (graphIdentity?.runner_sha256 && baselineIdentity?.runner_sha256 && graphIdentity.runner_sha256 !== baselineIdentity.runner_sha256) {
    errors.push(
      `runner identity differs between arms: graph=${graphIdentity.runner_sha256} baseline=${baselineIdentity.runner_sha256}`,
    );
  }
  const expectedRunVersion = Number.isInteger(harness?.graph_run_version_expected) ? harness.graph_run_version_expected : null;
  if (expectedRunVersion !== null) {
    if (!Number.isInteger(graphIdentity?.run_version)) errors.push("graph adapter did not report its Run schema version");
    else if (graphIdentity.run_version !== expectedRunVersion) {
      errors.push(`graph Run schema version ${graphIdentity.run_version} differs from harness expectation ${expectedRunVersion}`);
    }
  }
  if (positiveBudget(left?.token_budget)) {
    if (graphIdentity?.run_budget?.max_tokens !== left.token_budget) {
      errors.push(`graph Run max token budget differs from declared token budget`);
    }
  }
  if (positiveBudget(left?.timeout_minutes)) {
    if (graphIdentity?.run_budget?.max_minutes !== left.timeout_minutes) {
      errors.push(`graph Run max minute budget differs from declared timeout`);
    }
  }
  return errors;
}

function armMetrics(arm, truth) {
  const knownDefects = new Set((truth.defects || []).map((defect) => defect.id));
  const findings = Array.isArray(arm.findings) ? arm.findings : [];
  const detected = new Set(
    findings
      .filter((finding) => finding.validated === true && knownDefects.has(finding.defect_id))
      .map((finding) => finding.defect_id),
  );
  const falsePositives = findings.filter(
    (finding) => finding.validated === true && (!finding.defect_id || !knownDefects.has(finding.defect_id)),
  ).length;
  const fixed = new Set(
    findings
      .filter((finding) =>
        finding.validated === true &&
        finding.fixed === true &&
        finding.repair_verified === true &&
        knownDefects.has(finding.defect_id),
      )
      .map((finding) => finding.defect_id),
  );
  const regressionFailures = (arm.regression_checks || []).filter((check) => check.status !== "pass").length;
  const expected = knownDefects.size;
  const tokens = usageTotal(arm.usage);
  const perMillionTokens = (count) => (tokens !== null && tokens > 0 ? (count * 1_000_000) / tokens : null);
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
    tokens,
    validated_defects_per_mtok: perMillionTokens(detected.size),
    verified_repairs_per_mtok: perMillionTokens(fixed.size),
    tokens_per_validated_defect: tokens !== null && detected.size > 0 ? tokens / detected.size : null,
  };
}

function scorePair(pair, truth, harness = null) {
  const errors = comparabilityErrors(pair, harness);
  return {
    fixture_id: pair.fixture_id,
    repetition: pair.repetition,
    comparable: errors.length === 0,
    comparability_errors: errors,
    rejection_class: classifyRejection(errors),
    graph: armMetrics(pair.graph || {}, truth),
    baseline: armMetrics(pair.baseline || {}, truth),
  };
}

function average(values) {
  if (!values.length || values.some((value) => !Number.isFinite(value))) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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
  if (!values.length || values.some((value) => !Number.isFinite(value))) return null;
  const mean = average(values);
  if (values.length === 1) return { low: null, high: null };
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1);
  const standardError = Math.sqrt(variance / values.length);
  const critical = confidence === 0.95 ? tCritical95(values.length - 1) : null;
  if (!Number.isFinite(critical)) throw new Error(`Unsupported confidence level: ${confidence}`);
  const margin = critical * standardError;
  return { low: mean - margin, high: mean + margin };
}

function aggregatePairs(scoredPairs, minimumPairs = 5, harness = null) {
  validateMinimumPairs(minimumPairs);
  validatePairIdentities(scoredPairs);
  const comparable = scoredPairs.filter((pair) => pair.comparable);
  const rejected = scoredPairs.filter((pair) => !pair.comparable);
  const rejectedInfrastructure = rejected.filter((pair) => pair.rejection_class === "infrastructure").length;
  const rejectedNegative = rejected.filter((pair) => pair.rejection_class === "negative_result").length;
  const incomplete = rejected.length;
  const harnessStatus = harnessBinding(harness);
  const harnessBound = harnessStatus === "bound";
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
    validated_defects_per_mtok: average(comparable.map((pair) => pair[arm].validated_defects_per_mtok)),
    verified_repairs_per_mtok: average(comparable.map((pair) => pair[arm].verified_repairs_per_mtok)),
    tokens_per_validated_defect: average(comparable.map((pair) => pair[arm].tokens_per_validated_defect)),
  });
  const graph = summarize("graph");
  const baseline = summarize("baseline");
  const claimReady = comparable.length >= minimumPairs && incomplete === 0 && harnessBound;
  const pairedDeltas = {
    validated_recall: comparable.map((pair) => pairedDifference(pair.graph.validated_recall, pair.baseline.validated_recall)),
    precision: comparable.map((pair) => pairedDifference(pair.graph.precision, pair.baseline.precision)),
    repair_rate: comparable.map((pair) => pairedDifference(pair.graph.repair_rate, pair.baseline.repair_rate)),
    completion_rate: comparable.map((pair) => pairedDifference(Number(pair.graph.completed_gates), Number(pair.baseline.completed_gates))),
    regression_failures: comparable.map((pair) => pairedDifference(pair.graph.regression_failures, pair.baseline.regression_failures)),
    wall_ms: comparable.map((pair) => pairedDifference(pair.graph.wall_ms, pair.baseline.wall_ms)),
    tokens: comparable.map((pair) => pairedDifference(pair.graph.tokens, pair.baseline.tokens)),
    validated_defects_per_mtok: comparable.map((pair) => pairedDifference(pair.graph.validated_defects_per_mtok, pair.baseline.validated_defects_per_mtok)),
    verified_repairs_per_mtok: comparable.map((pair) => pairedDifference(pair.graph.verified_repairs_per_mtok, pair.baseline.verified_repairs_per_mtok)),
    tokens_per_validated_defect: comparable.map((pair) => pairedDifference(pair.graph.tokens_per_validated_defect, pair.baseline.tokens_per_validated_defect)),
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
      ["validated_defects_per_mtok", "validated_defects_per_million_tokens"],
      ["verified_repairs_per_mtok", "verified_repairs_per_million_tokens"],
    ];
    const negative = [
      ["regression_failures", "fewer_regression_failures"],
      ["wall_ms", "lower_wall_time"],
      ["tokens", "lower_token_use"],
      ["tokens_per_validated_defect", "fewer_tokens_per_validated_defect"],
    ];
    for (const [metric, label] of positive) {
      if (Number.isFinite(deltaIntervals[metric]?.low) && deltaIntervals[metric].low > 0) advantages.push(label);
    }
    for (const [metric, label] of negative) {
      if (Number.isFinite(deltaIntervals[metric]?.high) && deltaIntervals[metric].high < 0) advantages.push(label);
    }
  }
  return {
    version: 2,
    harness_binding: harnessStatus,
    harness_validation_errors: harnessValidationErrors(harness),
    ...(harnessBound ? { harness } : {}),
    samples_total: scoredPairs.length,
    samples_comparable: comparable.length,
    samples_rejected: incomplete,
    samples_rejected_infrastructure: rejectedInfrastructure,
    samples_rejected_negative: rejectedNegative,
    minimum_pairs_for_claim: minimumPairs,
    claim_ready: claimReady,
    graph,
    baseline,
    deltas: {
      validated_recall: pairedDifference(graph.validated_recall, baseline.validated_recall),
      precision: pairedDifference(graph.precision, baseline.precision),
      repair_rate: pairedDifference(graph.repair_rate, baseline.repair_rate),
      completion_rate: comparable.length ? pairedDifference(graph.completed_runs, baseline.completed_runs) / comparable.length : null,
      wall_ms: pairedDifference(graph.wall_ms, baseline.wall_ms),
      tokens: pairedDifference(graph.tokens, baseline.tokens),
      validated_defects_per_mtok: pairedDifference(graph.validated_defects_per_mtok, baseline.validated_defects_per_mtok),
      verified_repairs_per_mtok: pairedDifference(graph.verified_repairs_per_mtok, baseline.verified_repairs_per_mtok),
      tokens_per_validated_defect: pairedDifference(graph.tokens_per_validated_defect, baseline.tokens_per_validated_defect),
    },
    delta_intervals_95: deltaIntervals,
    statistically_supported_advantages: advantages,
    conclusion: claimReady
      ? advantages.length
        ? `Comparable sample threshold reached. Report only these fixture-scoped advantages with paired 95% intervals: ${advantages.join(", ")}. Do not generalize beyond these fixtures.`
        : "Comparable sample threshold reached, but no measured advantage has a paired 95% interval wholly on the favorable side. Report deltas as descriptive fixture results only; do not generalize beyond these fixtures."
      : harnessStatus !== "bound"
        ? `No performance claim allowed: no harness binding (${harnessStatus}); samples are descriptive history only until the complete launch fingerprint is validated.`
        : `No performance claim allowed: need at least ${minimumPairs} complete comparable pairs and currently have ${comparable.length}.`,
    rejected_pairs: rejected.map((pair) => ({
      fixture_id: pair.fixture_id,
      repetition: pair.repetition,
      rejection_class: pair.rejection_class,
      errors: pair.comparability_errors,
    })),
    report_sha256: sha256(JSON.stringify(scoredPairs)),
  };
}

export {
  aggregatePairs,
  armMetrics,
  classifyRejection,
  comparabilityErrors,
  MINIMUM_PAIRS_FOR_CLAIM,
  pairedMeanInterval,
  scorePair,
  validateMinimumPairs,
  usageTotal,
  wilsonInterval,
};
