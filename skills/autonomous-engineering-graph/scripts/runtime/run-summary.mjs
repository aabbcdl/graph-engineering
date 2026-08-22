const SUCCESS_STATUSES = new Set(["completed", "skipped"]);
const ACTIVE_STATUSES = new Set(["running", "queued", "model_active", "recovering", "waiting_service"]);
const FAILED_STATUSES = new Set(["blocked", "runner_error", "needs_retry", "failed", "interrupted"]);

const DEFAULT_DOMAINS = [
  { id: "engineering", title: "Engineering quality", required: true },
  { id: "product", title: "Product quality", required: true },
  { id: "experience", title: "Experience and accessibility", required: true },
  { id: "security", title: "Security and privacy", required: true },
];

function text(value) {
  return String(value || "").toLowerCase();
}

function domainForReview(review) {
  const haystack = text(`${review?.id} ${review?.title} ${review?.focus} ${(review?.skills || []).join(" ")}`);
  if (/security|privacy|auth|token|secret/.test(haystack)) return "security";
  if (/product|business|monet|activation|requirement|design/.test(haystack)) {
    return /requirement|design/.test(haystack) ? "requirements" : "product";
  }
  if (/experience|ux|ui|access|responsive|render|a11y/.test(haystack)) return "experience";
  if (/release|deploy|packag/.test(haystack)) return "release";
  if (/incident|reliab|outage|root cause/.test(haystack)) return "reliability";
  return "engineering";
}

export function reviewWavesFromPlan(plan = {}) {
  const explicit = Array.isArray(plan.review_waves)
    ? plan.review_waves.filter((wave) => Array.isArray(wave) && wave.length)
    : [];
  const nodes = Array.isArray(plan.review_nodes) ? plan.review_nodes : [];
  const waves = [];
  const seen = new Set();
  const appendWave = (wave) => {
    const next = [];
    for (const review of wave) {
      const key = JSON.stringify({
        id: review?.id || review?.title || null,
        title: review?.title || null,
        focus: review?.focus || null,
        skills: review?.skills || [],
      });
      if (seen.has(key)) continue;
      seen.add(key);
      next.push({ ...review });
    }
    if (next.length) waves.push(next);
  };
  if (nodes.length) appendWave(nodes);
  for (const wave of explicit) appendWave(wave);
  return waves;
}

export function allReviewNodesFromPlan(plan = {}) {
  return reviewWavesFromPlan(plan).flat();
}

function normalizedDomainDefinitions(plan = {}) {
  const declared = plan.coverage?.domains || plan.coverage?.required_domains || [];
  const broadAudit = plan.mode === "audit";
  const map = new Map(DEFAULT_DOMAINS.map((domain) => [domain.id, { ...domain, required: broadAudit && domain.required }]));
  for (const raw of declared) {
    const id = typeof raw === "string" ? raw : raw?.id;
    if (!id) continue;
    const value = typeof raw === "string" ? {} : raw;
    map.set(String(id), {
      id: String(id),
      title: value.title || String(id),
      required: value.required !== false,
    });
  }
  for (const review of allReviewNodesFromPlan(plan)) {
    const id = domainForReview(review);
    if (!map.has(id)) map.set(id, { id, title: id, required: false });
  }
  for (const item of plan.coverage?.omitted_domains || []) {
    const id = typeof item === "string" ? item : item?.id;
    if (id && !map.has(id)) map.set(String(id), { id: String(id), title: String(id), required: item?.required !== false });
  }
  return [...map.values()];
}

function nodeStatus(nodes) {
  if (!nodes.length) return "not_selected";
  const statuses = nodes.map((node) => node.status || "pending");
  const succeeded = (node) => SUCCESS_STATUSES.has(node.status) && !["blocked", "fail"].includes(String(node.gate || ""));
  if (nodes.every(succeeded)) return "completed";
  if (statuses.some((status) => ACTIVE_STATUSES.has(status))) return "running";
  if (statuses.some((status) => FAILED_STATUSES.has(status))) return "blocked";
  return "pending";
}

export function buildCoverageSummary({ plan = {}, graph = {}, run = {} } = {}) {
  const waves = reviewWavesFromPlan(plan);
  const graphNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const reviewNodes = waves.flat();
  const records = run.nodes || {};
  const domainDefinitions = normalizedDomainDefinitions(plan);
  const domains = domainDefinitions.map((domain) => {
    const selected = reviewNodes.filter((review) => domainForReview(review) === domain.id);
    const graphSelected = graphNodes.filter((node) => selected.some((review) => review.id === node.id));
    const statuses = graphSelected.map((node) => records[node.id] || { status: "pending" });
    const status = nodeStatus(statuses);
    const omitted = (plan.coverage?.omitted_domains || []).find((item) => (typeof item === "string" ? item : item?.id) === domain.id);
    return {
      id: domain.id,
      title: domain.title,
      required: domain.required,
      selected: selected.length > 0,
      node_ids: selected.map((review) => review.id),
      status: omitted && !selected.length ? "omitted" : status,
      reason: omitted ? (typeof omitted === "string" ? "Not selected by the planner." : omitted.reason || "Not selected by the planner.") : null,
      evidence: graphSelected.map((node) => ({
        node_id: node.id,
        status: records[node.id]?.status || "pending",
        gate: records[node.id]?.gate || null,
        result: records[node.id]?.result_artifact || records[node.id]?.result || null,
      })),
    };
  });
  const waveSummary = waves.map((wave, index) => {
    const statuses = wave.map((review) => records[review.id] || { status: "pending" });
    return {
      wave: index + 1,
      node_ids: wave.map((review) => review.id),
      status: nodeStatus(statuses),
      completed: statuses.filter((status) => SUCCESS_STATUSES.has(status.status) && !["blocked", "fail"].includes(String(status.gate || ""))).length,
      total: wave.length,
    };
  });
  const selectedIds = new Set(reviewNodes.map((review) => review.id));
  const graphReviewIds = graphNodes.filter((node) => node.kind === "review").map((node) => node.id);
  const unplannedGraphReviews = graphReviewIds.filter((id) => !selectedIds.has(id));
  const verificationGaps = plan.verification_gaps || plan.coverage?.verification_gaps || [];
  return {
    version: 1,
    review_limit_per_wave: plan.coverage?.review_limit_per_wave || null,
    review_limit_total: plan.coverage?.review_limit_total || null,
    total_review_nodes: reviewNodes.length,
    wave_count: waves.length,
    waves: waveSummary,
    domains,
    verification_gaps: verificationGaps,
    excluded_review_nodes: plan.coverage?.excluded_review_nodes || plan.review_cap_exclusions || [],
    unplanned_graph_reviews: unplannedGraphReviews,
    required_domains_complete: domains.filter((domain) => domain.required).every((domain) => ["completed", "not_selected"].includes(domain.status) && domain.status !== "not_selected"),
  };
}

function numericRound(id) {
  const match = String(id || "").match(/-r(\d+)$/);
  return match ? Number(match[1]) : null;
}

export function buildLoopSummary({ run = {}, maxCorrections = null } = {}) {
  const records = run.nodes || {};
  const nodeIds = run.node_order || Object.keys(records);
  const corrections = nodeIds.filter((id) => /^correction-r\d+$/.test(id));
  const verification = nodeIds.filter((id) => /^verification-r\d+$/.test(id));
  const independent = nodeIds.filter((id) => /^independent-review-r\d+$/.test(id));
  const rounds = new Map();
  for (const item of run.loop_history || []) {
    const round = Number.isInteger(item.round) ? item.round : 0;
    const entry = rounds.get(round) || { round, triggers: [], correction_nodes: [], verification_nodes: [], independent_review_nodes: [], files_changed: [], checks: [] };
    if (item.trigger) entry.triggers.push(item.trigger);
    if (item.node_id && /^correction-/.test(item.node_id)) entry.correction_nodes.push(item.node_id);
    if (item.node_id && /^verification-/.test(item.node_id)) entry.verification_nodes.push(item.node_id);
    if (item.node_id && /^independent-review-/.test(item.node_id)) entry.independent_review_nodes.push(item.node_id);
    entry.files_changed.push(...(item.files_changed || []));
    entry.checks.push(...(item.checks || []));
    rounds.set(round, entry);
  }
  for (const id of [...verification, ...independent, ...corrections]) {
    const round = numericRound(id);
    if (round === null || rounds.has(round)) continue;
    const entry = rounds.get(round) || { round, triggers: [], correction_nodes: [], verification_nodes: [], independent_review_nodes: [], files_changed: [], checks: [] };
    if (id.startsWith("correction-")) entry.correction_nodes.push(id);
    if (id.startsWith("verification-")) entry.verification_nodes.push(id);
    if (id.startsWith("independent-review-")) entry.independent_review_nodes.push(id);
    rounds.set(round, entry);
  }
  const normalizedRounds = [...rounds.values()].sort((a, b) => a.round - b.round).map((round) => ({
    ...round,
    correction_nodes: [...new Set(round.correction_nodes)],
    verification_nodes: [...new Set(round.verification_nodes)],
    independent_review_nodes: [...new Set(round.independent_review_nodes)],
    files_changed: [...new Set(round.files_changed)],
    checks: [...new Set(round.checks)],
  }));
  return {
    version: 1,
    correction_rounds: corrections.length,
    verification_rounds: verification.length,
    independent_review_rounds: independent.length,
    max_corrections: maxCorrections,
    no_progress_detected: Boolean(run.loop_no_progress),
    no_progress: run.loop_no_progress || null,
    final_phase: run.loop_phase || null,
    observations: (run.loop_history || []).map((item) => ({
      round: item.round ?? null,
      stage: item.stage || null,
      node_id: item.node_id || null,
      trigger: item.trigger || null,
      failure_fingerprint: item.failure_fingerprint || null,
      repeated: Boolean(item.repeated),
      files_changed: item.files_changed || [],
      checks: item.checks || [],
      observed_at: item.observed_at || null,
    })),
    rounds: normalizedRounds,
  };
}

function durationMs(start, end) {
  const first = Date.parse(start || "");
  const last = Date.parse(end || "");
  return Number.isFinite(first) && Number.isFinite(last) && last >= first ? last - first : null;
}

export function buildTimelineSummary({ run = {}, processAttempts = [] } = {}) {
  const nodes = Object.values(run.nodes || {}).map((record) => ({
    id: record.id,
    kind: record.kind,
    status: record.status,
    started_at: record.started_at || null,
    finished_at: record.finished_at || null,
    duration_ms: durationMs(record.started_at, record.finished_at),
    attempts: record.attempts || 0,
  }));
  const queueAttempts = processAttempts.filter((attempt) => Number.isFinite(attempt.model_queue?.wait_ms));
  const longestQueue = queueAttempts.reduce((best, attempt) => !best || attempt.model_queue.wait_ms > best.model_queue.wait_ms ? attempt : best, null);
  const longestProcess = processAttempts.reduce((best, attempt) => !best || (attempt.duration_ms || 0) > (best.duration_ms || 0) ? attempt : best, null);
  const blockers = Object.entries(run.nodes || {})
    .filter(([, record]) => record.error || ["blocked", "runner_error", "needs_retry", "interrupted"].includes(record.status))
    .map(([id, record]) => ({ id, status: record.status, error: record.error || null }));
  return {
    version: 1,
    nodes,
    attempts: processAttempts.length,
    total_queue_ms: queueAttempts.reduce((sum, attempt) => sum + attempt.model_queue.wait_ms, 0),
    total_process_ms: processAttempts.reduce((sum, attempt) => sum + (Number.isFinite(attempt.duration_ms) ? attempt.duration_ms : 0), 0),
    longest_queue_wait: longestQueue ? { node: longestQueue.node, attempt: longestQueue.attempt, wait_ms: longestQueue.model_queue.wait_ms } : null,
    longest_process: longestProcess ? { node: longestProcess.node, attempt: longestProcess.attempt, duration_ms: longestProcess.duration_ms || null } : null,
    blockers,
  };
}

export function buildNextActions({ run = {}, coverage = {}, loop = {} } = {}) {
  const actions = [];
  const evaluation = run.machine_check_evaluation || {};
  const requiredById = new Map((run.plan?.required_checks || []).map((check) => [String(check.id), check]));
  const machineGaps = new Map();
  for (const gap of [
    ...(evaluation.application_gaps || []),
    ...(evaluation.release_gaps || []),
  ]) {
    if (gap?.id !== null && gap?.id !== undefined) machineGaps.set(String(gap.id), gap);
  }
  const instructionFor = (gap) => {
    const required = requiredById.get(String(gap.id)) || {};
    const command = required.command || (required.evidence_tool ? `evidence tool ${required.evidence_tool}` : null);
    const environment = required.environment_kind || gap.environment_kind || null;
    const detail = required.description || gap.reason || `required check ${gap.id}`;
    return {
      scope: String(gap.blocking_scope || required.blocking_scope || "both").toLowerCase(),
      detail,
      evidence: command ? `Run ${command}` : `Provide machine-observed evidence for ${detail}`,
      environment: environment ? ` in the required ${environment} environment` : "",
    };
  };
  for (const gap of machineGaps.values()) {
    const instruction = instructionFor(gap);
    if (instruction.scope === "apply") {
      actions.push(
        `Application check ${gap.id} is unresolved (${instruction.detail}); the isolated result remains withheld. ` +
          `${instruction.evidence}${instruction.environment}, then start a new Graph run to revalidate application before applying changes.`,
      );
    } else if (instruction.scope === "release") {
      actions.push(
        `Release check ${gap.id} is unresolved (${instruction.detail}); this result is not release-ready. ` +
          `${instruction.evidence}${instruction.environment}, then start a new release-validation Graph run before publishing.`,
      );
    } else {
      const route = run.status === "completed"
        ? "then start a new Graph run because this completed run cannot acquire new completion evidence"
        : `then resume the exact run ${run.run_id || "recorded in completion.json"}`;
      actions.push(
        `Completion and application check ${gap.id} is unresolved (${instruction.detail}). ` +
          `${instruction.evidence}${instruction.environment}, ${route}.`,
      );
    }
  }
  for (const gap of coverage.verification_gaps || []) {
    actions.push(gap.next_action || gap.resolution || `Provide machine evidence for ${gap.description || gap.id}.`);
  }
  for (const domain of coverage.domains || []) {
    if (["pending", "blocked", "omitted", "not_selected"].includes(domain.status) && domain.required) {
      actions.push(domain.reason ? `${domain.title}: ${domain.reason}` : `${domain.title}: complete the missing review wave.`);
    }
  }
  if (run.blocker?.unblock_condition) actions.push(run.blocker.unblock_condition);
  if (loop.no_progress_detected) actions.push("Change the correction hypothesis or start a new run with fresh evidence; the same failure was observed twice.");
  if (!actions.length && run.status === "completed") actions.push("No mandatory follow-up remains; review the retained report and result package before applying isolated changes.");
  return [...new Set(actions)].slice(0, 20);
}
