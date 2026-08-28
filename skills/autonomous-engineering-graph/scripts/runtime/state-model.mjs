/**
 * Small, dependency-free state model shared by the runner, reports and tools.
 * The legacy runner still owns orchestration, but status semantics live here so
 * a single node cannot silently redefine what a run outcome means.
 */

export const RUN_STATUSES = Object.freeze([
  "created",
  "preflight",
  "submitted",
  "planning",
  "queued",
  "running",
  "model_active",
  "recovering",
  "waiting_service",
  "waiting_environment",
  "waiting_owner",
  "waiting_budget",
  "completed_with_gaps",
  "completed",
  "failed_recoverable",
  "failed_system",
  "failed",
  "blocked",
  "cancelled",
  "interrupted",
  "planned",
]);

export const WORK_ITEM_STATUSES = Object.freeze([
  "pending",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "deferred",
  "superseded",
]);

export const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "completed_with_gaps",
  "failed",
  "failed_system",
  "blocked",
  "waiting_owner",
  "waiting_environment",
  "waiting_service",
  "waiting_budget",
  "cancelled",
  "interrupted",
  "planned",
]);

// `completed_with_gaps` is terminal and useful, but it is deliberately not a
// success: callers must not treat a partial result as release-ready work.
export const SUCCESS_RUN_STATUSES = new Set(["completed", "planned"]);
export const PARTIAL_RUN_STATUSES = new Set(["completed_with_gaps"]);
export const SUCCESS_WORK_ITEM_STATUSES = new Set(["succeeded"]);
export const ACTIVE_RUN_STATUSES = new Set([
  "created",
  "preflight",
  "submitted",
  "planning",
  "queued",
  "running",
  "model_active",
  "recovering",
]);

export function isRunTerminal(status) {
  return TERMINAL_RUN_STATUSES.has(String(status || ""));
}

export function isRunSuccessful(status) {
  return SUCCESS_RUN_STATUSES.has(String(status || ""));
}

export function isWorkItemSuccessful(status) {
  return SUCCESS_WORK_ITEM_STATUSES.has(String(status || ""));
}

export function canTransitionRun(from, to) {
  const source = String(from || "created");
  const target = String(to || "");
  if (!RUN_STATUSES.includes(target)) return false;
  if (source === target) return true;
  // A terminal run can only be reopened through an explicit recovery path.
  if (isRunTerminal(source)) return false;
  return true;
}

export function transitionRun(run, status, details = {}) {
  if (!run || typeof run !== "object") throw new TypeError("run is required");
  if (!canTransitionRun(run.status, status)) {
    throw new Error(`Invalid run transition ${run.status || "created"} -> ${status}`);
  }
  return {
    ...run,
    status,
    ...details,
    updated_at: details.updated_at || new Date().toISOString(),
  };
}

export function workItemsFromGraph(graph, run = {}) {
  const resolved = resolvedWorkItems(graph, run);
  return resolved.definitions.filter((node) => {
    // Supervision is an optional control plane. When it is explicitly off,
    // skipped supervision nodes must not become false pending work items.
    return !(run?.options?.supervision === "off" && node.kind === "supervision" && !run?.nodes?.[node.id]);
  }).map((node) => {
    const record = run.nodes?.[node.id] || node;
    const rawStatus = nodeStatusToWorkItemStatus(record.status, record.gate);
    const resolution = resolved.authorized.has(node.id)
      ? "owner_authorized"
      : resolved.superseded.has(node.id)
        ? "resolved_by_follow_up"
        : null;
    const status = resolution === "owner_authorized"
      ? "succeeded"
      : resolution === "resolved_by_follow_up"
        ? "superseded"
        : rawStatus;
    return {
      id: node.id,
      title: node.title || node.id,
      kind: node.kind || "unknown",
      depends_on: [...(node.depends_on || [])],
      status,
      gate: record.gate || null,
      resolution,
      attempts: Number.isInteger(record.attempts) ? record.attempts : 0,
      result_ref: record.result_artifact || record.result || null,
      proof_ref: record.proof || null,
      blocker: record.error ? { reason: record.error } : null,
      started_at: record.started_at || null,
      finished_at: record.finished_at || null,
    };
  });
}

export function nodeStatusToWorkItemStatus(status, gate = null) {
  const value = String(status || "pending");
  if (SUCCESS_WORK_ITEM_STATUSES.has(value) || ["completed", "skipped"].includes(value)) {
    return ["blocked", "fail"].includes(String(gate || "")) ? "failed" : "succeeded";
  }
  if (["running", "queued", "model_active", "recovering", "waiting_service"].includes(value)) return "running";
  if (["blocked", "runner_error", "needs_retry"].includes(value)) return "failed";
  if (value === "interrupted") return "blocked";
  return "pending";
}

function runtimeNodeDefinitions(graph = {}, run = {}) {
  const definitions = [];
  const seen = new Set();
  const add = (id, definition = {}) => {
    const key = String(id || "").trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    definitions.push({ id: key, ...definition });
  };
  for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) add(node?.id, node);
  for (const id of Array.isArray(run?.node_order) ? run.node_order : Object.keys(run?.nodes || {})) {
    add(id, run?.nodes?.[id] || {});
  }
  return definitions;
}

function ownerAuthorizationMatches(run = {}) {
  const scope = run?.plan?.owner_gate?.authorization_scope;
  if (run?.plan?.owner_gate?.required !== true || !scope) return false;
  return (Array.isArray(run.authorizations) ? run.authorizations : []).some((authorization) => authorization?.scope === scope);
}

function resolvedWorkItems(graph = {}, run = {}) {
  const definitions = runtimeNodeDefinitions(graph, run);
  const superseded = new Set();
  const markFailed = (predicate) => {
    for (const definition of definitions) {
      const record = run?.nodes?.[definition.id] || definition;
      if (predicate(definition, record) && nodeStatusToWorkItemStatus(record.status, record.gate) === "failed") {
        superseded.add(definition.id);
      }
    }
  };

  // A passing stage recheck supersedes only the earlier failed supervision
  // records for that stage. The original records remain immutable evidence.
  for (const [stage, state] of Object.entries(run?.supervision_state || {})) {
    if (state?.phase !== "passed" || !state.node_id) continue;
    const prefix = `${stage}-supervision`;
    markFailed((definition) => definition.kind === "supervision" && definition.id.startsWith(prefix) && definition.id !== state.node_id);
  }

  // A successful correction resolves the failed node that triggered that loop
  // round. Later verification failures remain visible until their own round is
  // corrected, so a partial run cannot be upgraded by an unrelated correction.
  for (const observation of Array.isArray(run?.loop_history) ? run.loop_history : []) {
    const round = Math.max(1, Number.isInteger(observation?.round) ? observation.round + (observation.round === 0 ? 1 : 0) : 0);
    if (!round) continue;
    const correction = run?.nodes?.[`correction-r${round}`];
    if (nodeStatusToWorkItemStatus(correction?.status, correction?.gate) !== "succeeded") continue;
    if (observation.stage === "implementation") {
      markFailed((definition) => definition.id === "implementation");
    } else if (observation.stage === "verification") {
      markFailed((definition) => definition.kind === "verification");
    } else if (observation.stage === "independent_review") {
      markFailed((definition) => definition.kind === "independent_review");
    }
  }

  const ownerAuthorized = ownerAuthorizationMatches(run);
  const authorized = new Set();
  if (ownerAuthorized) {
    const synthesis = run?.nodes?.synthesis;
    if (nodeStatusToWorkItemStatus(synthesis?.status, synthesis?.gate) === "failed") authorized.add("synthesis");
  }
  return { definitions, superseded, authorized };
}

export function summarizeWorkItems(workItems = []) {
  const items = Array.isArray(workItems) ? workItems : [];
  const succeeded = items.filter((item) => item.status === "succeeded").length;
  const superseded = items.filter((item) => item.status === "superseded").length;
  const resolved = succeeded + superseded;
  const counts = {
    known: items.length,
    succeeded,
    superseded,
    resolved,
    running: items.filter((item) => item.status === "running").length,
    pending: items.filter((item) => item.status === "pending").length,
    failed: items.filter((item) => ["failed", "blocked"].includes(item.status)).length,
    deferred: items.filter((item) => item.status === "deferred").length,
  };
  return {
    counts,
    has_progress: resolved > 0,
    has_gaps: counts.failed > 0 || counts.pending > 0 || counts.deferred > 0 || counts.running > 0,
    all_succeeded: counts.known > 0 && resolved === counts.known,
  };
}

/**
 * Derive a run-level outcome without hiding a service/owner/environment wait.
 * This function is intentionally pure so it can be used by tests and reports.
 */
export function deriveRunOutcome({
  currentStatus,
  workItems = [],
  reviewOnly = false,
  requiredChecksPass = false,
  independentReviewPass = false,
  requiredDomainsComplete = true,
  assurancePass = true,
  budgetPass = true,
  active = false,
} = {}) {
  const status = String(currentStatus || "running");
  if (["waiting_service", "waiting_environment", "waiting_owner", "waiting_budget", "interrupted", "cancelled"].includes(status)) {
    return status;
  }
  if (active) return status;
  const summary = summarizeWorkItems(workItems);
  if (
    summary.all_succeeded &&
    (reviewOnly || requiredChecksPass) &&
    independentReviewPass &&
    requiredDomainsComplete &&
    assurancePass &&
    budgetPass
  ) return "completed";
  if (summary.has_progress) return "completed_with_gaps";
  if (summary.has_gaps) return "failed_recoverable";
  return status === "completed" ? "completed_with_gaps" : status;
}

export function runtimeStateForRun(run, graph) {
  const workItems = workItemsFromGraph(graph, run);
  return {
    version: 1,
    run_id: run.run_id,
    status: run.status || "created",
    work_items: workItems,
    summary: summarizeWorkItems(workItems),
    updated_at: new Date().toISOString(),
  };
}
