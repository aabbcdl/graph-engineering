import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendRunEvent,
  budgetDecision,
  budgetSnapshot,
  buildLoopSummary,
  buildNextActions,
  commandMatches,
  deriveRunOutcome,
  evaluateRequiredChecks,
  isRunSuccessful,
  readRunEvents,
  eventLogMetadataPaths,
  readArtifact,
  runtimeStateForRun,
  summarizeWorkItems,
  workItemsFromGraph,
  writeArtifact,
} from "../runtime/index.mjs";

test("work-item state preserves partial progress as completed_with_gaps", () => {
  const graph = {
    nodes: [
      { id: "review", kind: "review", title: "Review" },
      { id: "verify", kind: "verification", title: "Verify", depends_on: ["review"] },
    ],
  };
  const run = {
    run_id: "run-1",
    status: "failed",
    nodes: {
      review: { status: "completed", gate: "pass", attempts: 1 },
      verify: { status: "runner_error", error: "environment unavailable", attempts: 1 },
    },
  };
  const items = workItemsFromGraph(graph, run);
  assert.deepEqual(items.map((item) => item.status), ["succeeded", "failed"]);
  assert.equal(summarizeWorkItems(items).has_progress, true);
  assert.equal(deriveRunOutcome({ currentStatus: "failed", workItems: items }), "completed_with_gaps");
  assert.equal(runtimeStateForRun(run, graph).summary.counts.succeeded, 1);
});

test("runtime state includes dynamic corrections and resolves historical failures", () => {
  const graph = {
    nodes: [
      { id: "implementation", kind: "implementation", title: "Implementation" },
      { id: "implementation-supervision", kind: "supervision", title: "Implementation supervision" },
    ],
  };
  const run = {
    run_id: "run-correction",
    status: "completed",
    options: { supervision: "on" },
    node_order: ["implementation", "implementation-supervision", "correction-r1", "implementation-supervision-r1"],
    nodes: {
      implementation: { status: "needs_retry", gate: "fail", kind: "implementation", attempts: 1 },
      "implementation-supervision": { status: "needs_retry", gate: "fail", kind: "supervision", attempts: 1 },
      "correction-r1": { status: "completed", gate: "not_applicable", kind: "correction", attempts: 1 },
      "implementation-supervision-r1": { status: "completed", gate: "pass", kind: "supervision", attempts: 1 },
    },
    supervision_state: {
      implementation: { phase: "passed", node_id: "implementation-supervision-r1" },
    },
    loop_history: [{ round: 0, stage: "implementation", node_id: "implementation" }],
  };
  const items = workItemsFromGraph(graph, run);
  assert.deepEqual(items.map((item) => [item.id, item.status]), [
    ["implementation", "superseded"],
    ["implementation-supervision", "superseded"],
    ["correction-r1", "succeeded"],
    ["implementation-supervision-r1", "succeeded"],
  ]);
  const summary = summarizeWorkItems(items);
  assert.equal(summary.counts.superseded, 2);
  assert.equal(summary.all_succeeded, true);
});

test("owner authorization resolves a synthesis blocker without deleting its evidence", () => {
  const graph = { nodes: [{ id: "synthesis", kind: "synthesis", title: "Synthesis" }] };
  const scope = "[owner-test] approve the exact repository change";
  const run = {
    run_id: "run-owner",
    status: "completed",
    plan: { owner_gate: { required: true, authorization_scope: scope } },
    authorizations: [{ scope }],
    node_order: ["synthesis"],
    nodes: { synthesis: { status: "blocked", gate: "blocked", kind: "synthesis", attempts: 1 } },
  };
  const items = workItemsFromGraph(graph, run);
  assert.equal(items[0].status, "succeeded");
  assert.equal(items[0].resolution, "owner_authorized");
  assert.equal(summarizeWorkItems(items).all_succeeded, true);
});

test("event log is append-only and preserves sequence under concurrent writers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-runtime-events-"));
  try {
    await Promise.all(Array.from({ length: 8 }, (_, index) => appendRunEvent(root, {
      type: "WorkItemQueued",
      run_id: "run-2",
      work_item_id: `item-${index}`,
      payload: { index },
    })));
    const events = await readRunEvents(root);
    assert.equal(events.length, 8);
    assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: 8 }, (_, index) => index + 1));
    const raw = await readFile(path.join(root, "events", "events.jsonl"), "utf8");
    assert.equal(raw.trim().split(/\r?\n/).length, 8);
    const filtered = await readRunEvents(root, { since: 4, types: ["WorkItemQueued"] });
    assert.deepEqual(filtered.map((event) => event.sequence), [5, 6, 7, 8]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("event log uses a sparse index for large tails and lazily rebuilds legacy metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-runtime-large-events-"));
  try {
    const paths = eventLogMetadataPaths(root);
    await mkdir(path.dirname(paths.events), { recursive: true });
    const lines = Array.from({ length: 100_000 }, (_, index) => JSON.stringify({
      schema_version: 1,
      sequence: index + 1,
      event_id: `legacy-${index + 1}`,
      type: index % 2 === 0 ? "Even" : "Odd",
      run_id: "large-run",
      payload: { index },
    }));
    await writeFile(paths.events, `${lines.join("\n")}\n`, "utf8");

    const tail = await readRunEvents(root, { since: 99_900, types: ["Even", "Odd"] });
    assert.equal(tail.length, 100);
    assert.equal(tail[0].sequence, 99_901);
    assert.equal(tail.at(-1).sequence, 100_000);
    const head = JSON.parse(await readFile(paths.head, "utf8"));
    const indexLines = (await readFile(paths.index, "utf8")).trim().split(/\r?\n/).filter(Boolean);
    assert.equal(head.sequence, 100_000);
    assert.equal(head.event_count, 100_000);
    assert.ok(indexLines.length > 300);
    assert.ok(indexLines.length < 500);

    await rm(paths.head, { force: true });
    await rm(paths.index, { force: true });
    const rebuiltTail = await readRunEvents(root, { since: 99_990 });
    assert.deepEqual(rebuiltTail.map((event) => event.sequence), Array.from({ length: 10 }, (_, index) => 99_991 + index));
    assert.ok(await readFile(paths.head, "utf8"));
    assert.ok(await readFile(paths.index, "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run outcome preserves hard waits and does not mislabel them as partial success", () => {
  const succeeded = [{ id: "review", status: "succeeded" }];
  assert.equal(deriveRunOutcome({
    currentStatus: "waiting_service",
    workItems: succeeded,
  }), "waiting_service");
  assert.equal(deriveRunOutcome({
    currentStatus: "waiting_environment",
    workItems: succeeded,
  }), "waiting_environment");
  assert.equal(deriveRunOutcome({
    currentStatus: "blocked",
    workItems: succeeded,
  }), "completed_with_gaps");
  assert.equal(deriveRunOutcome({
    currentStatus: "failed",
    workItems: succeeded,
    active: true,
  }), "failed");
  assert.equal(isRunSuccessful("completed"), true);
  assert.equal(isRunSuccessful("completed_with_gaps"), false);
});

test("run outcome requires audit coverage, assurance, and budget gates", () => {
  const items = [{ id: "review", status: "succeeded" }];
  const common = {
    currentStatus: "completed",
    workItems: items,
    requiredChecksPass: true,
    independentReviewPass: true,
  };
  assert.equal(deriveRunOutcome({ ...common, requiredDomainsComplete: false }), "completed_with_gaps");
  assert.equal(deriveRunOutcome({ ...common, assurancePass: false }), "completed_with_gaps");
  assert.equal(deriveRunOutcome({ ...common, budgetPass: false }), "completed_with_gaps");
  assert.equal(deriveRunOutcome({
    ...common,
    requiredDomainsComplete: true,
    assurancePass: true,
    budgetPass: true,
  }), "completed");
});

test("review-only outcome does not require a verification gate", () => {
  assert.equal(deriveRunOutcome({
    currentStatus: "completed",
    reviewOnly: true,
    workItems: [
      { id: "review", status: "succeeded" },
      { id: "independent-review", status: "succeeded" },
    ],
    requiredChecksPass: false,
    independentReviewPass: true,
    requiredDomainsComplete: true,
    assurancePass: true,
    budgetPass: true,
  }), "completed");
});

test("loop summary counts the static review-only independent review", () => {
  const summary = buildLoopSummary({
    run: {
      plan: { mode: "review" },
      node_order: ["discovery", "synthesis", "synthesis-supervision", "independent-review"],
      nodes: {
        "independent-review": { status: "completed", gate: "pass", kind: "independent_review" },
      },
      loop_phase: "review_done",
    },
  });
  assert.equal(summary.independent_review_rounds, 1);
  assert.equal(summary.final_phase, "review_done");
});

test("run budget uses observed attempts and blocks unknown usage before another call", () => {
  const budget = {
    version: 1,
    profile: "default",
    max_tokens: 100,
    max_minutes: 10,
    max_attempts: 2,
    max_cost_usd: null,
  };
  const first = budgetSnapshot({
    budget,
    attempts: [{
      attempt: 1,
      process_succeeded: true,
      duration_ms: 1_000,
      usage: { input_tokens: 60, output_tokens: 20 },
    }],
  });
  assert.equal(first.observed_tokens, 80);
  assert.equal(first.attempts, 1);
  assert.equal(budgetDecision({ budget, snapshot: first }).allowed, true);

  const unknown = budgetSnapshot({
    budget,
    attempts: [
      { attempt: 1, process_succeeded: true, duration_ms: 1_000, usage: { input_tokens: 60, output_tokens: 20 } },
      { attempt: 2, process_succeeded: true, duration_ms: 1_000, usage: null },
    ],
  });
  const decision = budgetDecision({ budget, snapshot: unknown });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "unknown_usage");
  assert.equal(decision.status, "waiting_budget");
});

test("run budget permits one finite token overrun but never a second call at the cap", () => {
  const budget = { version: 1, profile: "default", max_tokens: 100, max_minutes: 10, max_attempts: 5, max_cost_usd: null };
  const snapshot = budgetSnapshot({
    budget,
    attempts: [{ attempt: 1, process_succeeded: true, duration_ms: 1, usage: { input_tokens: 90, output_tokens: 30 } }],
  });
  assert.equal(snapshot.token_overrun, 20);
  assert.equal(budgetDecision({ budget, snapshot }).allowed, false);
  assert.equal(budgetDecision({ budget, snapshot }).reason, "tokens_exhausted");
  assert.equal(budgetDecision({ budget, snapshot, allowCompletedOverrun: true }).allowed, true);
});

test("run budget accounts active reservations before admitting another model call", () => {
  const budget = { version: 1, profile: "default", max_tokens: 100, max_minutes: 10, max_attempts: 5, max_cost_usd: null };
  const snapshot = budgetSnapshot({
    budget,
    attempts: [{ attempt: 1, process_succeeded: true, duration_ms: 1, usage: { input_tokens: 40, output_tokens: 0 } }],
    reservations: {
      "review-a:1": { node_id: "review-a", attempt: 1, tokens: 60, status: "active" },
    },
  });
  assert.equal(snapshot.observed_tokens, 40);
  assert.equal(snapshot.reserved_tokens, 60);
  assert.equal(snapshot.available_tokens, 0);
  assert.equal(snapshot.reserved_attempts, 1);
  const decision = budgetDecision({ budget, snapshot });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "tokens_reserved");
});

test("run budget preserves history while an increased resume limit is accepted", () => {
  const budget = { version: 1, profile: "default", max_tokens: 100, max_minutes: 10, max_attempts: 2, max_cost_usd: null };
  const snapshot = budgetSnapshot({ budget, attempts: [{ attempt: 1, process_succeeded: true, duration_ms: 1, usage: { input_tokens: 80, output_tokens: 20 } }] });
  assert.equal(snapshot.observed_tokens, 100);
  assert.equal(budgetDecision({ budget: { ...budget, max_tokens: 200 }, snapshot }).allowed, true);
  assert.equal(snapshot.attempts, 1);
});

test("blocked gates are not counted as successful work items", () => {
  const graph = { nodes: [{ id: "verify", kind: "verification", title: "Verify" }] };
  const run = {
    run_id: "blocked-gate",
    status: "blocked",
    nodes: { verify: { status: "completed", gate: "blocked", attempts: 1 } },
  };
  const items = workItemsFromGraph(graph, run);
  assert.equal(items[0].status, "failed");
  assert.equal(summarizeWorkItems(items).all_succeeded, false);
  assert.equal(deriveRunOutcome({ currentStatus: "blocked", workItems: items }), "failed_recoverable");
});

test("artifact store is content addressed and validates hashes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-runtime-artifacts-"));
  try {
    const first = await writeArtifact(root, { kind: "plan", value: { answer: 42 } });
    const second = await writeArtifact(root, { kind: "plan", value: { answer: 42 } });
    assert.equal(first.artifact_id, second.artifact_id);
    assert.equal(await readArtifact(root, first), "{\n  \"answer\": 42\n}\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence verifier accepts a PowerShell wrapper and rejects a failed host command", () => {
  assert.equal(commandMatches("pnpm --filter server test", "powershell -Command pnpm --filter server test"), true);
  const passed = evaluateRequiredChecks([
    { id: "server-test", command: "pnpm --filter server test", description: "server tests" },
  ], {
    commands: [{ command: "powershell -Command pnpm --filter server test", exit_code: 0 }],
    claims: [{ id: "server-test", status: "pass", evidence: "host test passed" }],
  });
  assert.equal(passed.pass, true);
  const failed = evaluateRequiredChecks([
    { id: "server-test", command: "pnpm --filter server test", description: "server tests" },
  ], {
    commands: [{ command: "pnpm --filter server test", exit_code: 1 }],
    claims: [{ id: "server-test", status: "pass", evidence: "agent said pass" }],
  });
  assert.equal(failed.pass, false);
  assert.equal(failed.checks[0].status, "missing");

  for (const exitCode of [null, undefined, "", "0"]) {
    const unknown = evaluateRequiredChecks([
      { id: "server-test", command: "pnpm --filter server test", description: "server tests" },
    ], {
      commands: [{ command: "pnpm --filter server test", exit_code: exitCode }],
      claims: [{ id: "server-test", status: "pass", evidence: "agent said pass" }],
    });
    assert.equal(unknown.pass, false, `exit_code=${String(exitCode)} must not prove success`);
    assert.equal(unknown.checks[0].status, "missing");
  }
});

test("evidence verifier accepts the macOS zsh login-shell wrapper", () => {
  assert.equal(commandMatches("npm test", "/bin/zsh -lc 'npm test'"), true);
  assert.equal(commandMatches("npm run build", "zsh -lc \"npm run build\""), true);
  assert.equal(commandMatches("npm test", "/bin/zsh -lc 'npm test && npm run exfiltrate'"), false);

  const evaluation = evaluateRequiredChecks([
    { id: "tests", command: "npm test", description: "repository tests" },
  ], {
    commands: [{ command: "/bin/zsh -lc 'npm test'", exit_code: 0 }],
    claims: [{ id: "tests", status: "pass", evidence: "3 tests passed" }],
  });
  assert.equal(evaluation.pass, true);
  assert.equal(evaluation.checks[0].status, "pass");
});

test("evidence verifier can satisfy a copy-mode Git check from the source snapshot", () => {
  const evaluation = evaluateRequiredChecks([
    {
      id: "git-state",
      description: "Record source repository Git state",
      command: null,
      source_evidence: "source_git_snapshot",
      blocking_scope: "both",
    },
  ], {
    sourceGit: {
      available: true,
      observed_at: "2026-08-27T00:00:00.000Z",
    },
  });
  assert.equal(evaluation.pass, true);
  assert.equal(evaluation.checks[0].status, "pass");
  assert.equal(evaluation.checks[0].observed_source, "source_git_snapshot");
});

test("evidence verifier requires exact commands and does not trust check ids alone", () => {
  assert.equal(commandMatches("npm test", "npm test && npm run exfiltrate"), false);
  assert.equal(commandMatches("npm test", "npm test:dangerous"), false);
  assert.equal(commandMatches("npm test", "powershell -Command npm test; Remove-Item secrets.txt"), false);
  assert.equal(commandMatches("npm test", "powershell -Command npm test"), true);

  const forgedId = evaluateRequiredChecks([
    { id: "unit-tests", command: "npm test", description: "unit tests" },
  ], {
    commands: [{ check_id: "unit-tests", command: "npm test && npm run exfiltrate", exit_code: 0 }],
    claims: [{ id: "unit-tests", status: "pass", evidence: "the required check passed" }],
  });
  assert.equal(forgedId.pass, false);
  assert.equal(forgedId.checks[0].status, "missing");
});

test("evidence verifier separates completion, application, and release scopes", () => {
  const evaluation = evaluateRequiredChecks([
    { id: "both", command: "npm test", description: "local tests", blocking_scope: "both" },
    { id: "apply", command: "node apply-check.mjs", description: "apply check", blocking_scope: "apply" },
    { id: "release", command: "node release-check.mjs", description: "release check", blocking_scope: "release" },
  ], {
    commands: [{ command: "npm test", exit_code: 0 }],
    claims: [{ id: "both", status: "pass", evidence: "local tests passed" }],
  });
  assert.equal(evaluation.pass, false);
  assert.equal(evaluation.completion_pass, true);
  assert.equal(evaluation.blocking_pass, false);
  assert.equal(evaluation.application_pass, false);
  assert.equal(evaluation.release_pass, false);
  assert.deepEqual(evaluation.completion_gaps, []);
  assert.deepEqual(evaluation.application_gaps.map((check) => check.id), ["apply"]);
  assert.deepEqual(evaluation.release_gaps.map((check) => check.id), ["release"]);
});

test("next actions give executable routes for application and release gaps", () => {
  const requiredChecks = [
    { id: "apply", command: "node apply-check.mjs", description: "validate private object access", environment_kind: "service", blocking_scope: "apply" },
    { id: "release", command: "node release-check.mjs", description: "validate the release target", environment_kind: "external_service", blocking_scope: "release" },
  ];
  const evaluation = evaluateRequiredChecks(requiredChecks, { commands: [], claims: [] });
  const actions = buildNextActions({
    run: {
      run_id: "gap-run",
      status: "completed",
      plan: { required_checks: requiredChecks },
      machine_check_evaluation: evaluation,
    },
  });
  assert.equal(actions.length, 2);
  assert.match(actions[0], /Application check apply.*isolated result remains withheld.*start a new Graph run/i);
  assert.match(actions[0], /node apply-check\.mjs.*service environment/i);
  assert.match(actions[1], /Release check release.*not release-ready.*release-validation Graph run/i);
  assert.doesNotMatch(actions.join("\n"), /No mandatory follow-up remains/i);

  const completionGap = evaluateRequiredChecks([
    { id: "both", command: "npm test", description: "run all tests", blocking_scope: "both" },
  ], { commands: [], claims: [] });
  const resumable = buildNextActions({
    run: {
      run_id: "partial-run",
      status: "completed_with_gaps",
      plan: { required_checks: [{ id: "both", command: "npm test", description: "run all tests", blocking_scope: "both" }] },
      machine_check_evaluation: completionGap,
    },
  });
  assert.match(resumable[0], /resume the exact run partial-run/i);
});

test("review-only next actions classify verification as deferred coverage", () => {
  const actions = buildNextActions({
    run: {
      run_id: "review-run",
      status: "completed",
      plan: { mode: "review", required_checks: [] },
    },
    coverage: {
      verification_gaps: [{ id: "device-check", description: "Validate a real device", next_action: "Connect a device later." }],
      domains: [],
    },
  });
  assert.match(actions[0], /review-only.*deferred/i);
  assert.doesNotMatch(actions[0], /unresolved|review error/i);
});
