import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  atomicWriteJson,
  agentCapabilityPath,
  agentCapabilityDoctor,
  automaticFallbackBackendAllowed,
  acquireLock,
  acquireModelSlot,
  AGENT_BACKENDS,
  assertRunCanResume,
  catalogForPlanner,
  captureWorkspaceManifest,
  allocateRunDirectory,
  childEnvironment,
  codexExecArgs,
  claudeAgentArgs,
  claudeSandboxSettings,
  claudeSandboxCapabilityPath,
  claudeLastMessageFromEvents,
  clearResolvedAssuranceBlocker,
  clearResolvedBudgetBlocker,
  configureAssurance,
  recordAgentSandboxProbe,
  recordClaudeSandboxProbe,
  commandExecutables,
  compactResultForDependency,
  compileGraph,
  classifyEnvironmentGap,
  createFrozenWorkspace,
  correctionSkillsForResult,
  executeGarbageCollection,
  configuredGitAliases,
  dependencyGateSatisfied,
  dependencyContext,
  diffManifests,
  discoverSkills,
  effectiveReviewLimits,
  enrichSynthesisEvidence,
  ensureNodeResultConsistency,
  ensurePlanEnvironmentContracts,
  fallbackBackendOrder,
  generateReport,
  gitStateChanged,
  gcRunCandidates,
  httpStatusesInEvidence,
  inferGoalMode,
  invocationIdentity,
  agentSandboxCapabilityMatches,
  inspectModelQueue,
  isolatedCodexConfigArgs,
  latestCompletedCorrection,
  listRuns,
  makeLoopNode,
  machineFailuresFromProof,
  modelQueueRoot,
  modelCapacityOutcome,
  mergeRunOptionsForResume,
  backendEndpointKey,
  buildNodePrompt,
  normalizeAgentBackend,
  newestWorkingCodexInvocation,
  nodeSandboxMode,
  nodeInputBudget,
  nodeInputBudgetError,
  normalizeQueueScope,
  normalizePlannerResult,
  normalizeSynthesisArtifact,
  optionsForResume,
  parseArgs,
  permanentBackendFailure,
  plannerEnvironmentCoverageOverride,
  proofFromClaudeEvents,
  proofFromEvents,
  readonlySandboxProbeEvidence,
  progressSnapshot,
  queueMutexContentionError,
  RESUME_CLEARABLE_BLOCKERS,
  replaceFileWithRetry,
  RedactingLineTransform,
  removeFrozenWorkspace,
  resolveCodexInvocation,
  separateCodexHomeRequired,
  runtimeSnapshot,
  runIdPrefix,
  renderProgress,
  runPool,
  saveRun,
  safeGitConfigEnvironment,
  sourceGitProvenance,
  stateRootUsageSummary,
  shouldRetrySupervisionRecheck,
  transientExecutionFailure,
  tokenBudgetGuard,
  unsatisfiedCheckIds,
  workspaceFileMap,
  waitForBackgroundHandoff,
  WATCH_TERMINAL_STATUSES,
  workspaceBucket,
} from "../graph-runner.mjs";
import { applyResults } from "../apply-results.mjs";
import { acquireRuntimeAdmission, runtimeControlRoot } from "../runtime-admission.mjs";
import { appendRunEvent, evaluateRequiredChecks } from "../runtime/index.mjs";
import { prepareExecutionWorkspace, __test as workspacePreflightTest } from "../workspace-preflight.mjs";
import { installGraph } from "../../../../scripts/install.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(TEST_DIR, "..", "graph-runner.mjs");
const RESTORE = path.resolve(TEST_DIR, "..", "restore-run.mjs");
const APPLY_RESULTS = path.resolve(TEST_DIR, "..", "apply-results.mjs");
const INSTALLER = path.resolve(TEST_DIR, "..", "..", "..", "..", "scripts", "install.mjs");
const FAKE_NOTIFIER = path.join(TEST_DIR, "fake-notifier.mjs");
const FAKE_CODEX = path.join(TEST_DIR, "fake-codex.mjs");
const AUTONOMOUS_SKILL = path.resolve(TEST_DIR, "..", "..", "SKILL.md");
const GRAPH_CONTRACT = path.resolve(TEST_DIR, "..", "..", "references", "graph-contract.md");
const LIFECYCLE_CONTROLLER = path.resolve(TEST_DIR, "..", "..", "references", "lifecycle-controller.md");
const NODE_RUNTIME_CONTRACT = path.resolve(TEST_DIR, "..", "..", "references", "node-runtime-contract.md");
const INTEGRATION_TIMEOUT = 60_000;
// Windows process creation and the installer hash scan can exceed the normal
// child deadline when the host is under load. Keep the bound finite, but give
// those deliberately slow integration paths enough room to report a result.
const SLOW_INTEGRATION_TIMEOUT = 120_000;
const ACTIVE_MODEL_START_TIMEOUT = 15_000;
const TEST_QUEUE_ROOT = path.join(os.tmpdir(), `aeg-test-model-queue-${process.pid}`);
const TEST_CONTROL_ROOT = path.join(os.tmpdir(), `aeg-test-runtime-control-${process.pid}`);
process.env.AEG_MODEL_QUEUE_ROOT = TEST_QUEUE_ROOT;
process.env.AEG_TEST_MODE = "1";
process.env.AEG_TEST_RUNTIME_CONTROL_ROOT = TEST_CONTROL_ROOT;
process.env.AEG_WORKSPACE_MODE = "live";
process.env.AEG_DISABLE_NOTIFICATIONS = "1";
after(async () => {
  await rm(TEST_QUEUE_ROOT, { recursive: true, force: true });
  await rm(TEST_CONTROL_ROOT, { recursive: true, force: true });
});

function contentHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

const defaultFileMode = 0o666 & ~process.umask();

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aeg-test-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

function spawnResultDetails(result) {
  const details = [result?.error?.message, result?.stderr, result?.stdout]
    .filter(Boolean)
    .map(String)
    .join("\n")
    .trim();
  return details || `child exited without output (status=${result?.status ?? "null"}, signal=${result?.signal ?? "none"})`;
}

async function writeSkill(root, name, description) {
  const directory = path.join(root, "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nInspect the fixture.\n`,
    "utf8",
  );
}

function runRunnerAsync(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER, ...args], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`runner timed out after ${options.timeout || INTEGRATION_TIMEOUT} ms`));
    }, options.timeout || INTEGRATION_TIMEOUT);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, { timeout = 5_000, poll = 20, message = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await wait(poll);
  }
  throw new Error(`Timed out waiting for ${message}`);
}

test("parseArgs handles values and booleans", () => {
  assert.deepEqual(parseArgs(["start", "--goal", "fix it", "--user-approved", "--plan-only", "--max-parallel", "4", "--service-retry-minutes", "7", "--use-user-codex-config"]), {
    command: "start",
    options: {
      goal: "fix it",
      "user-approved": true,
      "plan-only": true,
      "max-parallel": "4",
      "service-retry-minutes": "7",
      "use-user-codex-config": true,
    },
  });
  assert.throws(() => parseArgs(["start", "goal"]), /Unexpected argument/);
  assert.throws(() => parseArgs(["start", "--goal"]), /Missing value/);
  assert.deepEqual(parseArgs(["resume", "--isolated-codex-config"]), {
    command: "resume",
    options: { "isolated-codex-config": true },
  });
  assert.deepEqual(
    parseArgs(["submit", "--goal", "audit", "--user-approved", "--codex-model", "gpt-test", "--claude-model", "opus", "--reasoning-effort", "high"]),
    {
      command: "submit",
      options: {
        goal: "audit",
        "user-approved": true,
        "codex-model": "gpt-test",
        "claude-model": "opus",
        "reasoning-effort": "high",
      },
    },
  );
  assert.deepEqual(parseArgs(["resume", "--background", "--follow", "--run", "fixture"]), {
    command: "resume",
    options: { background: true, follow: true, run: "fixture" },
  });
  assert.deepEqual(parseArgs(["watch", "--run", "fixture", "--interval-seconds", "3", "--stale-seconds", "90", "--heartbeat-seconds", "60", "--changes-only", "--once", "--no-clear"]), {
    command: "watch",
    options: {
      run: "fixture",
      "interval-seconds": "3",
      "stale-seconds": "90",
      "heartbeat-seconds": "60",
      "changes-only": true,
      once: true,
      "no-clear": true,
    },
  });
  assert.deepEqual(
    parseArgs([
      "start",
      "--role-model",
      "planner=strong-model",
      "--role-model",
      "review=standard-model",
      "--role-effort",
      "planner=high,review=medium",
      "--workspace-mode",
      "worktree",
      "--supervision",
      "stage",
    ]),
    {
      command: "start",
      options: {
        "role-model": ["planner=strong-model", "review=standard-model"],
        "role-effort": ["planner=high,review=medium"],
        "workspace-mode": "worktree",
        supervision: "stage",
      },
    },
  );
});

test("CLI help exposes isolation, supervision, role routing, notifications, and result application", () => {
  const help = spawnSync(process.execPath, [RUNNER, "help"], { encoding: "utf8", timeout: INTEGRATION_TIMEOUT });
  assert.equal(help.status, 0, help.stderr || help.stdout);
  for (const option of [
    "--workspace-mode <auto|live|worktree|copy>",
    "--machine-preflight",
    "--machine-preflight-gradle",
    "--supervision <stage|off>",
    "--role-model <role=model>",
    "--role-effort <role=effort>",
    "--role-backend <role=backend>",
    "--max-review-nodes <1-6>",
    "--notify / --no-notify",
    "--notification-command <command>",
    "--interval-seconds <n>",
    "--stale-seconds <n>",
    "--since <sequence>",
    "--type <event>",
  ]) {
    assert.match(help.stdout, new RegExp(option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(help.stdout, /completion\.json/);
  assert.match(help.stdout, /results[\\/]apply\.mjs/);

  const startHelp = spawnSync(process.execPath, [RUNNER, "start", "--help"], { encoding: "utf8", timeout: INTEGRATION_TIMEOUT });
  assert.equal(startHelp.status, 0, startHelp.stderr || startHelp.stdout);
  assert.match(startHelp.stdout, /isolated snapshot/i);
  assert.match(startHelp.stdout, /stage supervision/i);
  const eventsHelp = spawnSync(process.execPath, [RUNNER, "events", "--help"], { encoding: "utf8", timeout: INTEGRATION_TIMEOUT });
  assert.equal(eventsHelp.status, 0, eventsHelp.stderr || eventsHelp.stdout);
  assert.match(eventsHelp.stdout, /append-only event stream/i);
});

test("first start reports storage locations once without contaminating JSON stdout", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "D-drive", "graph-runs");
  const executionRoot = path.join(root, "D-drive", "graph-workspaces");
  const queueRoot = path.join(root, "D-drive", "model-queue");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  const args = [
    RUNNER,
    "start",
    "--user-approved",
    "--workspace",
    workspace,
    "--state-root",
    stateRoot,
    "--workspace-mode",
    "copy",
    "--goal",
    "Storage notice fixture",
    "--dry-run",
    "--json",
  ];
  const environment = {
    ...process.env,
    AEG_EXECUTION_ROOT: executionRoot,
    AEG_MODEL_QUEUE_ROOT: queueRoot,
    AEG_DISABLE_NOTIFICATIONS: "1",
  };
  const first = spawnSync(process.execPath, args, { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: environment });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const firstOutput = JSON.parse(first.stdout.trim());
  assert.ok(firstOutput.run_id);
  assert.match(first.stderr, /首次运行存储提示/);
  for (const location of [stateRoot, executionRoot, queueRoot]) {
    assert.match(first.stderr, new RegExp(location.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const marker = JSON.parse(await readFile(path.join(stateRoot, ".storage-location-notice-v1.json"), "utf8"));
  assert.equal(marker.paths.state, path.resolve(stateRoot));
  assert.equal(marker.paths.execution, await realpath(executionRoot));
  assert.equal(marker.paths.queue, path.resolve(queueRoot));

  const second = spawnSync(
    process.execPath,
    args.map((value) => (value === "Storage notice fixture" ? "Storage notice fixture second run" : value)),
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: environment },
  );
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.ok(JSON.parse(second.stdout.trim()).run_id);
  assert.doesNotMatch(second.stderr, /首次运行存储提示/);
});

test("watch terminal states include environment waits", () => {
  assert.equal(WATCH_TERMINAL_STATUSES.has("waiting_environment"), true);
  assert.equal(WATCH_TERMINAL_STATUSES.has("completed_with_gaps"), true);
});

test("events CLI reads one exact run without contacting a model", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  const runId = "events-cli-fixture";
  const runDir = path.join(workspaceBucket(stateRoot, workspace), runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "run.json"), `${JSON.stringify({
    run_id: runId,
    workspace,
    status: "running",
    nodes: {},
    node_order: [],
    options: {},
  })}\n`, "utf8");
  await appendRunEvent(runDir, { run_id: runId, type: "WorkItemStarted", work_item_id: "review", payload: { attempt: 1 } });
  await appendRunEvent(runDir, { run_id: runId, type: "WorkItemFailed", work_item_id: "review", payload: { reason: "fixture" } });
  const result = spawnSync(
    process.execPath,
    [RUNNER, "events", "--workspace", workspace, "--state-root", stateRoot, "--run", runId, "--type", "WorkItemFailed", "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.run_id, runId);
  assert.equal(output.events.length, 1);
  assert.equal(output.events[0].type, "WorkItemFailed");
  assert.equal(output.events[0].sequence, 2);
});

test("Run IDs retain millisecond timestamp and slug shape while retrying same-millisecond collisions", async (t) => {
  const root = await temporaryDirectory(t);
  const bucket = path.join(root, "bucket");
  const prefix = runIdPrefix("Audit fixture", new Date("2026-08-22T12:34:56.789Z"));
  assert.equal(prefix, "20260822T123456.789Z-audit-fixture");
  const collided = `${prefix}-aaaaaaaaaaaa`;
  await mkdir(path.join(bucket, collided), { recursive: true });
  const suffixes = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"];
  const allocated = await allocateRunDirectory(bucket, prefix, () => suffixes.shift());
  assert.equal(allocated.run_id || allocated.runId, `${prefix}-bbbbbbbbbbbb`);
  assert.equal(await lstat(allocated.runDir).then(() => true), true);
  assert.match(allocated.runId, /^20260822T123456\.789Z-audit-fixture-[a-f0-9]{12}$/);
});

test("state usage warning is raised only above the 20 GiB threshold", () => {
  const threshold = 20 * 1024 ** 3;
  assert.equal(stateRootUsageSummary(threshold).warning, false);
  assert.equal(stateRootUsageSummary(threshold + 1).warning, true);
  assert.equal(stateRootUsageSummary(threshold + 1).threshold_bytes, threshold);
});

test("GC preserves newest, active, and recoverable Runs and keeps an execution manifest", async (t) => {
  const root = await temporaryDirectory(t);
  const stateRoot = path.join(root, "state");
  const controlRoot = path.join(root, "control");
  const workspace = path.join(root, "workspace");
  const bucket = path.join(stateRoot, "workspace-bucket");
  await mkdir(bucket, { recursive: true });

  async function writeRun(runId, ageDays, status = "completed") {
    const directory = path.join(bucket, runId);
    const createdAt = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1_000).toISOString();
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "run.json"), `${JSON.stringify({
      version: 3,
      run_id: runId,
      workspace,
      status,
      created_at: createdAt,
      updated_at: createdAt,
    })}\n`, "utf8");
    return directory;
  }

  await writeRun("newest", 31);
  await writeRun("second-newest", 32);
  await writeRun("third-newest", 33);
  const candidate = await writeRun("candidate", 34);
  const active = await writeRun("active", 35);
  const recoverable = await writeRun("waiting-budget", 36, "waiting_budget");
  const release = await acquireLock(active, { controlRoot });
  try {
    const candidates = await gcRunCandidates(stateRoot);
    assert.deepEqual(candidates.map((item) => item.run.run_id), ["candidate"]);
    const preview = await executeGarbageCollection(stateRoot);
    assert.equal(preview.status, "preview");
    assert.deepEqual(preview.candidates.map((item) => item.run_id), ["candidate"]);
    assert.equal(await lstat(candidate).then(() => true), true);
    assert.equal(await lstat(active).then(() => true), true);
    assert.equal(await lstat(recoverable).then(() => true), true);
  } finally {
    await release();
  }

  const executed = await executeGarbageCollection(stateRoot, { execute: true });
  assert.deepEqual(executed.deleted, ["candidate", "active"]);
  assert.equal(await lstat(candidate).catch(() => null), null);
  assert.equal(await lstat(active).catch(() => null), null);
  const manifest = JSON.parse(await readFile(executed.manifest, "utf8"));
  assert.deepEqual(manifest.deleted, ["candidate", "active"]);
});

test("progress snapshots expose honest checkpoints without an ETA", () => {
  const run = {
    run_id: "fixture-progress",
    status: "model_active",
    node_order: ["planner", "review-a", "verification-r0"],
    nodes: {
      planner: { id: "planner", kind: "planner", status: "completed", gate: "pass" },
      "review-a": { id: "review-a", kind: "review", status: "model_active", gate: null },
      "verification-r0": { id: "verification-r0", kind: "verification", status: "pending", gate: null },
    },
    updated_at: "2026-08-16T00:00:00.000Z",
    report: null,
  };
  const graph = {
    nodes: [
      { id: "planner", kind: "planner", depends_on: [] },
      { id: "review-a", kind: "review", depends_on: ["planner"] },
      { id: "verification-r0", kind: "verification", depends_on: ["review-a"] },
    ],
  };
  const runtime = {
    phase: "model_active",
    current_node: "review-a",
    current_node_kind: "review",
    last_progress_at: "2026-08-16T00:00:00.000Z",
    runner_active: true,
    model_active: true,
    queue_position: null,
    queue_waiting: 0,
    queue_capacity: 4,
    runtime_update_required: false,
  };
  const snapshot = progressSnapshot(run, graph, runtime, {
    now: Date.parse("2026-08-16T00:00:42.000Z"),
    staleAfterSeconds: 300,
  });
  assert.equal(snapshot.health, "active");
  assert.deepEqual(snapshot.node_counts, {
    completed: 1,
    active: 1,
    pending: 1,
    blocked: 0,
    interrupted: 0,
    known: 3,
    work_items_succeeded: 1,
    work_items_failed: 0,
    work_items_deferred: 0,
  });
  assert.equal(snapshot.next_node, null);
  assert.equal(snapshot.activity_age_seconds, 42);
  assert.equal(snapshot.runner_active, true);
  assert.equal(snapshot.model_active, true);
  assert.equal(Object.hasOwn(snapshot, "eta_seconds"), false);
  assert.match(renderProgress(snapshot), /Nodes: 1\/3 completed/);
  assert.match(renderProgress(snapshot), /runner active \| model active/);
});

test("progress recommends exact-run resume when the installed budget supersedes an older blocker", () => {
  const run = {
    run_id: "fixture-old-budget",
    workspace: "D:\\fixture",
    state_root: "D:\\state",
    status: "blocked",
    node_order: ["verification-r0"],
    nodes: {
      "verification-r0": { id: "verification-r0", kind: "verification", status: "runner_error", gate: "blocked" },
    },
    blocker: {
      type: "NODE_INPUT_BUDGET_EXCEEDED",
      node_id: "verification-r0",
      input_bytes: 196_773,
      budget_bytes: 192_000,
      reason: "input exceeded the old verification budget",
      unblock_condition: "start a new run",
    },
  };
  const graph = {
    nodes: [{ id: "verification-r0", kind: "verification", depends_on: [] }],
  };
  const snapshot = progressSnapshot(run, graph, {
    phase: "blocked",
    current_node: "verification-r0",
    current_node_kind: "verification",
    attempt: 1,
    runner_active: false,
    model_active: false,
    queue_position: null,
    queue_waiting: 0,
    queue_capacity: 4,
  });
  assert.equal(snapshot.health, "terminal");
  assert.match(snapshot.recommended_action, /current runtime budget.*256000.*recorded 192000/i);
  assert.match(snapshot.recommended_action, /resume this exact run/i);
  assert.doesNotMatch(snapshot.recommended_action, /start a new run/i);
  assert.match(renderProgress(snapshot), /Recommended: .*resume this exact run/i);
});

test("codex configuration mode can be explicitly switched on resume", () => {
  const defaults = {
    model: null,
    maxParallel: 1,
    maxCorrections: 3,
    timeoutMinutes: 45,
    serviceRetryMinutes: 120,
    queueWaitMinutes: 240,
    isolatedCodexConfig: true,
  };
  const saved = { options: { isolated_codex_config: false } };
  assert.equal(optionsForResume(defaults, { "isolated-codex-config": true }, saved).isolatedCodexConfig, true);
  assert.equal(optionsForResume(defaults, { "use-user-codex-config": true }, saved).isolatedCodexConfig, false);
  assert.throws(
    () => optionsForResume(defaults, { "isolated-codex-config": true, "use-user-codex-config": true }, saved),
    /cannot be used together/,
  );
});

test("review node cap is explicit, bounded, and preserved in a normalized plan", () => {
  const catalog = [{ name: "fixture-review", description: "review fixture", origin: "project" }];
  const plan = normalizePlannerResult(
    {
      task_summary: "Audit the fixture",
      mode: "audit",
      review_nodes: [
        { id: "one", title: "One", focus: "one", skills: ["fixture-review"] },
        { id: "two", title: "Two", focus: "two", skills: ["fixture-review"] },
        { id: "three", title: "Three", focus: "three", skills: ["fixture-review"] },
      ],
      required_checks: [{ id: "tests", description: "Run tests", command: "npm test" }],
    },
    catalog,
    "Audit the fixture",
    2,
  );
  assert.equal(plan.review_nodes.length, 2);
  assert.deepEqual(plan.review_nodes.map((review) => review.id), ["review-one", "review-two"]);
  assert.equal(normalizePlannerResult({ review_nodes: [] }, catalog, "audit", 99).review_nodes.length <= 6, true);
});

test("temporary failure detection ignores a false timeout marker", () => {
  assert.equal(
    transientExecutionFailure({
      execution: { timed_out: false, proof: { errors: ["fixture node process failure"] }, stderr: "" },
      message: "Node review-risk failed: exit=1, timeout=false",
    }),
    false,
  );
  assert.equal(
    transientExecutionFailure({
      execution: { timed_out: false, proof: { errors: ["503 Service Unavailable"] }, stderr: "" },
    }),
    true,
  );
  assert.equal(transientExecutionFailure({ message: "Timed out waiting for model service" }), true);
});

test("status identifies a legacy runtime-definition change and gives an exact same-run resume command", async (t) => {
  const runDir = await temporaryDirectory(t);
  const stateRoot = path.join(runDir, "state");
  const workspace = path.join(runDir, "workspace");
  await mkdir(workspace, { recursive: true });
  const run = {
    run_id: "fixture-runtime-update",
    workspace,
    state_root: stateRoot,
    status: "blocked",
    updated_at: new Date().toISOString(),
    options: { agent_backend: "codex", queue_scope: "global" },
    node_order: ["review-security"],
    nodes: {
      "review-security": {
        id: "review-security",
        kind: "review",
        status: "runner_error",
        attempts: 2,
        error: "Shared controller reference hash mismatch for references/lifecycle-contract.md",
      },
    },
    blocker: {
      type: "NODE_PROCESS_FAILURE",
      reason: "Shared controller reference hash mismatch for references/lifecycle-contract.md",
    },
  };
  const snapshot = await runtimeSnapshot(run, runDir);
  assert.equal(snapshot.runtime_update_required, true);
  assert.equal(snapshot.runner_active, false);
  assert.equal(snapshot.runner_pid, null);
  assert.match(snapshot.resume_command, /resume .*--run "fixture-runtime-update"/);
  assert.match(snapshot.recommended_action, /do not create a replacement run/i);
});

test("a definition update stops without retry and the same run resumes with a refreshed skill catalog", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const environment = {
    ...process.env,
    AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
    AEG_FAKE_SCENARIO: "happy",
    AEG_FAKE_PLANNER_HOLD_MS: "500",
  };
  const startedPromise = runRunnerAsync(
    [
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--goal",
      "Audit the fixture while Graph definitions are updated",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    { env: environment, timeout: 20_000 },
  );
  const selected = await waitFor(async () => (await listRuns(stateRoot, workspace))[0] || null, {
    message: "runtime-update run state",
  });
  const catalogPath = path.join(selected.directory, "skill-catalog.json");
  const catalog = await waitFor(async () => {
    const content = await readFile(catalogPath, "utf8").catch(() => null);
    return content ? JSON.parse(content) : null;
  }, { message: "saved skill catalog" });
  const fixtureSkill = catalog.find((skill) => skill.name === "fixture-review");
  assert.ok(fixtureSkill, "fixture skill missing from planner catalog");
  fixtureSkill.sha256 = "0".repeat(64);
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

  const interrupted = await startedPromise;
  assert.equal(interrupted.status, 0, interrupted.stderr || interrupted.stdout);
  const summary = JSON.parse(interrupted.stdout.trim());
  assert.equal(summary.status, "interrupted");
  const interruptedRun = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  assert.equal(interruptedRun.blocker.type, "RUNTIME_UPDATED");
  assert.equal(interruptedRun.nodes.discovery.attempts, 1);
  const attempts = JSON.parse(await readFile(path.join(summary.run_dir, "nodes", "discovery", "attempts.json"), "utf8"));
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].runtime_definition_changed, true);
  assert.equal(attempts[0].retry_scheduled, false);

  const resumed = spawnSync(
    process.execPath,
    [RUNNER, "resume", "--workspace", workspace, "--state-root", stateRoot, "--run", summary.run_id, "--json"],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: { ...environment, AEG_FAKE_PLANNER_HOLD_MS: "0" },
    },
  );
  assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
  assert.equal(JSON.parse(resumed.stdout.trim()).status, "completed");
  const completedRun = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  assert.equal(completedRun.runtime_updates.length, 1);
  assert.ok(completedRun.runtime_updates[0].refreshed_skill_count > 0);
  const refreshedCatalog = JSON.parse(await readFile(catalogPath, "utf8"));
  assert.notEqual(refreshedCatalog.find((skill) => skill.name === "fixture-review").sha256, "0".repeat(64));
});

test("a permanent backend rejection is never treated as a temporary failure", () => {
  // Reproduces the real gateway response: the agent CLI retries internally and
  // prints "Reconnecting..." even though the model will never be served.
  const permanent404 = {
    execution: {
      timed_out: false,
      stderr: "",
      proof: {
        errors: [
          'Reconnecting... 1/5 (unexpected status 404 Not Found: Model "fixture-model" is not supported by any configured account in this group)',
          'Reconnecting... 5/5 (unexpected status 404 Not Found: Model "fixture-model" is not supported by any configured account in this group)',
          'unexpected status 404 Not Found: Model "fixture-model" is not supported by any configured account in this group',
        ],
      },
    },
  };
  assert.equal(transientExecutionFailure(permanent404), false);
  assert.equal(permanentBackendFailure(permanent404).reason, "model_not_served");

  const missingCredentials = { execution: { timed_out: false, stderr: '{"code":"API_KEY_REQUIRED"}' } };
  assert.equal(transientExecutionFailure(missingCredentials), false);
  assert.equal(permanentBackendFailure(missingCredentials).reason, "credentials");

  const exhaustedQuota = { execution: { timed_out: false, stderr: "error: insufficient_quota for this account" } };
  assert.equal(permanentBackendFailure(exhaustedQuota).reason, "quota_exhausted");

  const bareForbidden = { execution: { timed_out: false, stderr: "unexpected status 403 Forbidden" } };
  assert.equal(permanentBackendFailure(bareForbidden).reason, "http_403");
});

test("temporary failure detection does not fire on incidental three-digit numbers", () => {
  for (const stderr of [
    "SyntaxError at Fixture.kt:512 unexpected token",
    "FAILED testHttp500Fallback expected true",
    "AssertionError: expected 5 got 500",
  ]) {
    assert.equal(transientExecutionFailure({ execution: { timed_out: false, stderr } }), false, stderr);
    assert.equal(permanentBackendFailure({ execution: { timed_out: false, stderr } }), null, stderr);
  }
  for (const stderr of ["unexpected status 503 Service Unavailable", "unexpected status 429 Too Many Requests"]) {
    assert.equal(transientExecutionFailure({ execution: { timed_out: false, stderr } }), true, stderr);
  }
});

test("only explicit capacity rejection contracts the shared queue", () => {
  assert.deepEqual(
    modelCapacityOutcome({ execution: { exit_code: null, timed_out: true, stderr: "" } }),
    { outcome: "neutral", reason: null },
  );
  assert.deepEqual(
    modelCapacityOutcome({ execution: { exit_code: 1, timed_out: false, stderr: "request timed out" } }),
    { outcome: "neutral", reason: null },
  );
  assert.deepEqual(
    modelCapacityOutcome({ execution: { exit_code: 1, timed_out: false, stderr: "unexpected status 503 Service Unavailable" } }),
    { outcome: "overload", reason: "http_503" },
  );
  assert.deepEqual(
    modelCapacityOutcome({ execution: { exit_code: 1, timed_out: false, stderr: "502 Bad Gateway" } }),
    { outcome: "overload", reason: "http_502" },
  );
  assert.deepEqual(
    modelCapacityOutcome({ execution: { exit_code: 1, timed_out: false, stderr: "unexpected status 429 Too Many Requests" } }),
    { outcome: "overload", reason: "http_429" },
  );
  assert.deepEqual(
    modelCapacityOutcome({ execution: { exit_code: 1, timed_out: false, stderr: "model service overloaded" } }),
    { outcome: "overload", reason: "structured_capacity_rejection" },
  );
});

test("http status extraction only trusts explicit status phrasing", () => {
  assert.deepEqual([...httpStatusesInEvidence("unexpected status 404 Not Found")], [404]);
  assert.deepEqual([...httpStatusesInEvidence("HTTP/1.1 503 Service Unavailable")], [503]);
  assert.deepEqual([...httpStatusesInEvidence("failed at line 512 of 900")], []);
  assert.deepEqual([...httpStatusesInEvidence("testHttp500Fallback failed")], []);
});

test("model admission is global by default and can be scoped to a real endpoint", () => {
  const globalCodex = modelQueueRoot("codex");
  assert.equal(modelQueueRoot("claude"), globalCodex);
  assert.equal(modelQueueRoot("codex", "global"), globalCodex);
  const endpointCodex = modelQueueRoot("codex", "endpoint");
  assert.notEqual(endpointCodex, globalCodex);
  assert.ok(endpointCodex.startsWith(globalCodex));
  assert.equal(endpointCodex.endsWith(backendEndpointKey("codex")), true);

  assert.equal(normalizeQueueScope(undefined), "global");
  assert.equal(normalizeQueueScope("ENDPOINT"), "endpoint");
  assert.throws(() => normalizeQueueScope("per-model"), /--queue-scope must be one of/);
});

test("queue inspection remains read-only when queue storage does not exist", async (t) => {
  const root = await temporaryDirectory(t);
  const queueRoot = path.join(root, "queue");

  const snapshot = await inspectModelQueue({ queueRoot });

  assert.equal(snapshot.capacity.current, 2);
  assert.deepEqual(snapshot.active, []);
  assert.deepEqual(snapshot.waiting, []);
  assert.equal(snapshot.legacy_active, false);
  assert.equal((await readdir(root)).includes("queue"), false);
});

test("Windows mutex access errors are treated as retryable queue contention", () => {
  assert.equal(queueMutexContentionError({ code: "EEXIST" }), true);
  assert.equal(queueMutexContentionError({ code: "EACCES" }), true);
  assert.equal(queueMutexContentionError({ code: "EPERM" }), true);
  assert.equal(queueMutexContentionError({ code: "ENOENT" }), false);
});

test("adaptive admission permits bounded read concurrency while writers remain exclusive", async (t) => {
  const root = await temporaryDirectory(t);
  const queueRoot = path.join(root, "queue");
  const capacityConfig = { initial: 3, minimum: 1, maximum: 4, successThreshold: 2, cooldownMs: 0 };
  const workspaceA = path.join(root, "workspace-a");
  const workspaceB = path.join(root, "workspace-b");
  const workspaceC = path.join(root, "workspace-c");
  const first = await acquireModelSlot({
    backend: "claude",
    queueRoot,
    workspace: workspaceA,
    capacityConfig,
    waitMinutes: 1,
    pollMs: 10,
    runId: "run-a",
    nodeId: "review-a",
    accessMode: "read",
  });
  const second = await acquireModelSlot({
    backend: "codex",
    queueRoot,
    workspace: workspaceB,
    capacityConfig,
    waitMinutes: 1,
    pollMs: 10,
    runId: "run-b",
    nodeId: "review-risk",
    accessMode: "read",
  });
  try {
    assert.equal(first.capacity_at_acquire, 3);
    assert.equal(second.capacity_at_acquire, 3);
    assert.notEqual(first.lease_path, second.lease_path);
    const queueSnapshot = await inspectModelQueue({ queueRoot, capacityConfig });
    assert.equal(queueSnapshot.capacity.current, 3);
    assert.deepEqual(queueSnapshot.active.map((lease) => lease.run_id).sort(), ["run-a", "run-b"]);
    const readA = await acquireModelSlot({
      backend: "claude",
      queueRoot,
      workspace: workspaceA,
      accessMode: "read",
      workspaceReadLanes: 2,
      capacityConfig,
      waitMinutes: 1,
      pollMs: 10,
    });
    const sameWorkspace = await inspectModelQueue({ queueRoot, capacityConfig });
    assert.equal(sameWorkspace.active.filter((lease) => lease.workspace === path.resolve(workspaceA)).length, 2);
    assert.ok(sameWorkspace.active.filter((lease) => lease.workspace === path.resolve(workspaceA)).every((lease) => lease.access_mode === "read"));
    await second.release({ outcome: "neutral" });
    await assert.rejects(acquireModelSlot({
      backend: "claude",
      queueRoot,
      workspace: workspaceA,
      accessMode: "write",
      capacityConfig,
      waitMinutes: 0,
      pollMs: 10,
    }), (error) => error.code === "MODEL_QUEUE_TIMEOUT");
    await assert.rejects(
      acquireModelSlot({
        backend: "claude",
        queueRoot,
        workspace: workspaceA,
        accessMode: "read",
        workspaceReadLanes: 2,
        capacityConfig,
        waitMinutes: 0,
        pollMs: 10,
      }),
      (error) => error.code === "MODEL_QUEUE_TIMEOUT",
    );
    const readC = await acquireModelSlot({
      backend: "claude",
      queueRoot,
      workspace: workspaceC,
      accessMode: "read",
      capacityConfig,
      waitMinutes: 1,
      pollMs: 10,
    });
    await readC.release({ outcome: "neutral" });
    await readA.release({ outcome: "neutral" });
  } finally {
    await Promise.all([
      first.release({ outcome: "neutral" }).catch(() => {}),
      second.release({ outcome: "neutral" }).catch(() => {}),
    ]);
  }
});

test("adaptive admission expands after stable successes and contracts on structured overload", async (t) => {
  const root = await temporaryDirectory(t);
  const queueRoot = path.join(root, "queue");
  const capacityConfig = { initial: 2, minimum: 1, maximum: 4, successThreshold: 2, cooldownMs: 0 };

  for (const name of ["stable-a", "stable-b"]) {
    const slot = await acquireModelSlot({
      queueRoot,
      workspace: path.join(root, name),
      capacityConfig,
      waitMinutes: 1,
      pollMs: 10,
    });
    await slot.release({ outcome: "success" });
  }
  let state = await inspectModelQueue({ queueRoot, capacityConfig });
  assert.equal(state.capacity.current, 3);
  assert.equal(state.capacity.success_streak, 0);

  const active = [];
  for (const name of ["load-a", "load-b", "load-c"]) {
    active.push(await acquireModelSlot({
      queueRoot,
      workspace: path.join(root, name),
      capacityConfig,
      waitMinutes: 1,
      pollMs: 10,
    }));
  }
  assert.equal(active.at(-1).capacity_at_acquire, 3);
  await active[0].release({ outcome: "overload", reason: "http_429" });
  state = await inspectModelQueue({ queueRoot, capacityConfig });
  assert.equal(state.capacity.current, 2);
  assert.equal(state.capacity.last_overload_reason, "http_429");
  await Promise.all(active.slice(1).map((slot) => slot.release({ outcome: "neutral" })));
});

test("an expired legacy timeout contraction returns to the initial capacity", async (t) => {
  const root = await temporaryDirectory(t);
  const queueRoot = path.join(root, "queue");
  await mkdir(queueRoot, { recursive: true });
  await writeFile(
    path.join(queueRoot, "capacity.json"),
    `${JSON.stringify({
      version: 1,
      initial: 2,
      minimum: 1,
      maximum: 4,
      current: 1,
      success_streak: 1,
      cooldown_until: new Date(Date.now() - 1_000).toISOString(),
      last_overload_at: new Date(Date.now() - 10_000).toISOString(),
      last_overload_reason: "timeout",
      updated_at: new Date(Date.now() - 1_000).toISOString(),
    })}\n`,
    "utf8",
  );

  const snapshot = await inspectModelQueue({
    queueRoot,
    capacityConfig: { initial: 2, minimum: 1, maximum: 4, successThreshold: 3, cooldownMs: 0 },
  });
  assert.equal(snapshot.capacity.current, 2);
  assert.equal(snapshot.capacity.success_streak, 0);
  assert.equal(snapshot.capacity.last_overload_reason, null);
});

test("model admission preserves first-arrival order across waiting workspaces", async (t) => {
  const root = await temporaryDirectory(t);
  const queueRoot = path.join(root, "queue");
  const capacityConfig = { initial: 1, minimum: 1, maximum: 1, successThreshold: 2, cooldownMs: 0 };
  const held = await acquireModelSlot({
    queueRoot,
    workspace: path.join(root, "holder"),
    capacityConfig,
    waitMinutes: 1,
    pollMs: 10,
  });
  const order = [];
  const firstWaiting = acquireModelSlot({
    queueRoot,
    workspace: path.join(root, "first-waiting"),
    capacityConfig,
    waitMinutes: 1,
    pollMs: 10,
  }).then(async (slot) => {
    order.push("first");
    await wait(30);
    await slot.release();
  });
  await wait(30);
  const secondWaiting = acquireModelSlot({
    queueRoot,
    workspace: path.join(root, "second-waiting"),
    capacityConfig,
    waitMinutes: 1,
    pollMs: 10,
  }).then(async (slot) => {
    order.push("second");
    await slot.release();
  });
  await wait(30);
  await held.release();
  await Promise.all([firstWaiting, secondWaiting]);
  assert.deepEqual(order, ["first", "second"]);
});

test("adaptive admission counts a live legacy lock during rolling migration", async (t) => {
  const root = await temporaryDirectory(t);
  const queueRoot = path.join(root, "queue");
  await mkdir(queueRoot, { recursive: true });
  await writeFile(
    path.join(queueRoot, "active.lock"),
    `${JSON.stringify({ pid: process.pid, child_pid: null, token: "legacy-runner", acquired_at: new Date().toISOString() })}\n`,
    "utf8",
  );
  const firstNew = await acquireModelSlot({
    queueRoot,
    workspace: path.join(root, "new-workspace-a"),
    waitMinutes: 1,
    pollMs: 10,
  });
  try {
    const snapshot = await inspectModelQueue({ queueRoot });
    assert.equal(snapshot.legacy_active, true);
    assert.equal(snapshot.active.length, 1);
    await assert.rejects(
      acquireModelSlot({
        queueRoot,
        workspace: path.join(root, "new-workspace-b"),
        waitMinutes: 0,
        pollMs: 10,
      }),
      (error) => error.code === "MODEL_QUEUE_TIMEOUT",
    );
    assert.equal(JSON.parse(await readFile(path.join(queueRoot, "active.lock"), "utf8")).token, "legacy-runner");
  } finally {
    await firstNew.release();
  }
});

test("a structured planner owner gate is downgraded to non-blocking and never re-derived from synthesis", () => {
  const plan = normalizePlannerResult(
    {
      task_summary: "Rotate the production signing key",
      scope: ["ci"],
      risk_level: "high",
      owner_gate: {
        required: true,
        reason: "Rotate the production signing key.",
        unblock_condition: "Approve this exact signing-key rotation.",
      },
      review_nodes: [],
      implementation_skills: [],
      verification_skills: [],
      required_checks: [],
    },
    [],
    "Rotate the production signing key",
  );
  // P2: the planner schema no longer carries owner_gate; a legacy planner
  // declaration is parsed defensively but its required flag is ignored.
  assert.equal(plan.owner_gate.required, false);
  assert.equal(plan.owner_gate.derived_from, "planner");

  const ordinary = normalizePlannerResult(
    {
      task_summary: "Fix a failing unit test",
      scope: ["src"],
      risk_level: "low",
      review_nodes: [],
      implementation_skills: [],
      verification_skills: [],
      required_checks: [],
    },
    [],
    "Fix a failing unit test",
  );
  assert.equal(ordinary.owner_gate.required, false);
  assert.equal(ordinary.owner_gate.derived_from, "planner");
});

test("a high-risk audit does not create an owner gate without a concrete protected action", () => {
  const plan = normalizePlannerResult(
    {
      task_summary: "Comprehensively audit a large repository and repair reversible defects",
      mode: "audit",
      scope: [
        "Review requirements, engineering, product, experience, security, privacy, tests, and release readiness.",
        "Make only reversible repository-local changes and do not deploy or delete data.",
      ],
      risk_level: "high",
      owner_gate: {
        required: false,
        reason: "No owner gate is required for repository-local audit and reversible repair.",
        unblock_condition: "Create a later gate only for one concrete protected action.",
      },
      completion_criteria: ["audit and verification complete"],
      required_checks: [],
      discovery_skills: [],
      review_nodes: [],
      implementation_skills: [],
      verification_skills: [],
      excluded_surfaces: [],
    },
    [],
    "Audit and repair reversible defects without deployment or destructive actions",
  );

  assert.equal(plan.risk_level, "high");
  assert.equal(plan.owner_gate.required, false);
  assert.equal(plan.owner_gate.gate_id, null);
  assert.equal(plan.owner_gate.authorization_scope, null);
});

test("auto assurance does not mistake package metadata for a release task", () => {
  const ordinary = configureAssurance(
    { assurance: "auto", agentBackend: "codex", agentFallback: false },
    {
      mode: "task",
      required_checks: [{
        id: "tests",
        description: "Run the repository test suite",
        source: "package.json test script",
        blocking_scope: "both",
      }],
    },
    process.cwd(),
  );
  assert.equal(ordinary.level, "standard");
  assert.equal(ordinary.pass, true);

  const release = configureAssurance(
    { assurance: "auto", agentBackend: "codex", agentFallback: false },
    {
      mode: "task",
      required_checks: [{
        id: "release-package",
        description: "Build the release package",
        source: "release workflow",
        blocking_scope: "both",
      }],
    },
    process.cwd(),
  );
  assert.equal(release.level, "high");
});

test("auto assurance keeps review-only deferred release checks at standard", () => {
  const review = configureAssurance(
    { assurance: "auto", agentBackend: "codex", agentFallback: false },
    {
      mode: "review",
      required_checks: [{
        id: "macos-clean-release",
        description: "Verify the signed Apple Silicon release package on a clean Mac",
        source: "release workflow",
        blocking_scope: "both",
      }],
    },
    process.cwd(),
  );
  assert.equal(review.level, "standard");
  assert.equal(review.pass, true);
  assert.equal(review.status, "ready");
});

test("a resumed assurance wait clears once review assurance is satisfied", () => {
  const run = {
    assurance: { pass: true },
    blocker: {
      type: "ASSURANCE_ENVIRONMENT_REQUIRED",
      reason: "stale assurance wait",
    },
    runner_error: "stale assurance wait",
  };
  assert.equal(clearResolvedAssuranceBlocker(run), true);
  assert.equal(run.blocker, null);
  assert.equal(run.runner_error, null);
  assert.equal(RESUME_CLEARABLE_BLOCKERS.has("ASSURANCE_ENVIRONMENT_REQUIRED"), true);
});

test("an increased budget clears the previous budget blocker and its budget record", () => {
  const run = {
    budget: {
      pass: true,
      blocker: { reason: "tokens_exhausted" },
    },
    blocker: {
      type: "RUN_BUDGET_EXHAUSTED",
      reason: "stale budget wait",
    },
    runner_error: "stale budget wait",
  };
  assert.equal(clearResolvedBudgetBlocker(run), true);
  assert.equal(run.budget.blocker, null);
  assert.equal(run.blocker, null);
  assert.equal(run.runner_error, null);
});

test("reviewing production release topology never overrides a structured no-gate decision", () => {
  const plan = normalizePlannerResult(
    {
      task_summary: "Audit the exact frozen repository and repair reversible local defects",
      mode: "audit",
      scope: [
        "CI gates, lockfile integrity, Docker development and production topology, runtime image, Nginx, and release documentation",
        "Review authentication, authorization, payments, data retention, and production configuration without performing protected actions",
      ],
      risk_level: "high",
      owner_gate: {
        required: false,
        reason: "The scope is read-only review plus reversible repository-local repair.",
        unblock_condition: "Create a later gate only for one concrete protected action.",
      },
      completion_criteria: ["audit complete"],
      required_checks: [],
      discovery_skills: [],
      review_nodes: [],
      implementation_skills: [],
      verification_skills: [],
      excluded_surfaces: [],
    },
    [],
    "Audit production release readiness without deployment",
  );
  assert.equal(plan.owner_gate.required, false);
  assert.equal(plan.owner_gate.gate_id, null);
  assert.equal(plan.owner_gate.authorization_scope, null);
});

test("planner checks exclude Graph lifecycle stages and non-executable prose", () => {
  const plan = normalizePlannerResult(
    {
      task_summary: "Audit and repair the fixture",
      mode: "audit",
      scope: ["workspace"],
      risk_level: "medium",
      owner_gate: { required: false, reason: "", unblock_condition: "" },
      completion_criteria: ["verified"],
      required_checks: [
        {
          id: "unit-tests",
          description: "Run unit tests",
          command: "npm test",
          evidence_tool: null,
          source: "package.json",
        },
        {
          id: "independent-release-review",
          description: "Run the Graph final review",
          command: null,
          evidence_tool: "Fresh-context review artifact in host events",
          source: "Graph lifecycle",
        },
        {
          id: "rendered-probe",
          description: "Inspect a rendered screen when tooling exists",
          command: null,
          evidence_tool: "Host events followed by screenshots or a gap report",
          source: "optional tooling",
        },
      ],
      discovery_skills: [],
      review_nodes: [],
      implementation_skills: [],
      verification_skills: [],
      excluded_surfaces: [],
    },
    [],
    "Audit and repair the fixture",
  );

  assert.deepEqual(plan.required_checks.map((check) => check.id), ["unit-tests"]);
  assert.equal(
    plan.excluded_surfaces.some((entry) => entry.surface === "rendered-probe" && /machine-verifiable/i.test(entry.reason)),
    true,
  );
  assert.equal(plan.excluded_surfaces.some((entry) => entry.surface === "independent-release-review"), false);
});

test("planner keeps an exact machine tool identifier for a genuine non-command check", () => {
  const plan = normalizePlannerResult(
    {
      task_summary: "Inspect the rendered fixture",
      mode: "review",
      scope: ["workspace"],
      risk_level: "low",
      owner_gate: { required: false, reason: "", unblock_condition: "" },
      completion_criteria: ["verified"],
      required_checks: [
        {
          id: "rendered-view",
          description: "Inspect the rendered fixture",
          command: null,
          evidence_tool: "browser.screenshot",
          source: "project instructions",
        },
      ],
      discovery_skills: [],
      review_nodes: [],
      implementation_skills: [],
      verification_skills: [],
      excluded_surfaces: [],
    },
    [],
    "Inspect the rendered fixture",
  );

  assert.deepEqual(plan.required_checks.map((check) => check.id), ["rendered-view"]);
  assert.equal(plan.required_checks[0].evidence_tool, "browser.screenshot");
});

test("planner infers a waiting-environment contract for external browser and service checks", () => {
  const plan = normalizePlannerResult(
    {
      task_summary: "Verify the web application",
      mode: "audit",
      scope: ["workspace"],
      risk_level: "medium",
      completion_criteria: ["fresh browser evidence"],
      required_checks: [
        {
          id: "admin-browser",
          description: "Capture the rendered admin page",
          command: "pnpm exec playwright screenshot http://127.0.0.1:5173/ admin.png",
          evidence_tool: null,
          source: "project verification",
        },
        {
          id: "health-probe",
          description: "Probe the local service health endpoint",
          command: "Invoke-WebRequest http://127.0.0.1:3000/health",
          evidence_tool: null,
          source: "project verification",
        },
      ],
      discovery_skills: [],
      review_nodes: [],
      implementation_skills: [],
      verification_skills: [],
      excluded_surfaces: [],
    },
    [],
    "Verify the web application",
  );

  assert.equal(plan.required_checks.find((check) => check.id === "admin-browser").environment_required, true);
  assert.equal(plan.required_checks.find((check) => check.id === "admin-browser").gap_policy, "waiting_environment");
  assert.equal(plan.required_checks.find((check) => check.id === "health-probe").environment_required, true);
  assert.equal(plan.required_checks.find((check) => check.id === "health-probe").gap_policy, "waiting_environment");
});

test("verification evaluates required checks even when the worker returns a blocked gate", () => {
  const requiredChecks = [
    {
      id: "docker-start",
      description: "Start the isolated database container",
      command: "docker compose up -d",
      evidence_tool: null,
      source: "project verification",
      environment_required: true,
      gap_policy: "waiting_environment",
    },
  ];
  const proof = {
    commands: [{ command: "docker compose up -d", exit_code: 1, status: "failed", output_excerpt: "Docker engine permission denied" }],
    tool_calls: [],
  };
  const result = ensureNodeResultConsistency(
    {
      status: "completed",
      gate: "blocked",
      summary: "The Docker environment is unavailable",
      skills_applied: [],
      evidence: [],
      findings: [],
      commands: [],
      checks: [],
      files_changed: [],
      blockers: [{
        type: "ENVIRONMENT_GAP",
        reason: "Docker engine is unavailable",
        unblock_condition: "Start Docker and resume the run",
        required_for_current_goal: true,
        protected_action: null,
      }],
      next_actions: [],
    },
    { kind: "verification" },
    proof,
    [],
    [],
    requiredChecks,
  );

  assert.equal(result.machine_check_evaluation.gaps.length, 1);
  const gap = classifyEnvironmentGap(result, requiredChecks, proof);
  assert.deepEqual(gap.check_ids, ["docker-start"]);
  assert.equal(
    classifyEnvironmentGap(result, requiredChecks, {
      commands: [{ command: "docker compose up -d", exit_code: 1, status: "failed", output_excerpt: "Expected 2 to equal 3" }],
    }),
    null,
  );
  assert.equal(
    classifyEnvironmentGap(result, requiredChecks, {
      commands: [{ command: "npm test", exit_code: 1, status: "failed", output_excerpt: "connection refused in an unrelated unit test" }],
    }),
    null,
  );

  const claimMissingProof = {
    commands: [{ command: "docker compose up -d", exit_code: 0, status: "completed" }],
    tool_calls: [],
  };
  const claimMissingResult = {
    machine_check_evaluation: evaluateRequiredChecks(requiredChecks, claimMissingProof),
  };
  assert.equal(classifyEnvironmentGap(claimMissingResult, requiredChecks, claimMissingProof), null);

  const browserChecks = [{
    id: "browser",
    description: "Run the Playwright browser tests",
    command: "npx playwright test",
    environment_required: true,
    environment_kind: "browser",
    gap_policy: "waiting_environment",
  }];
  const browserProof = {
    commands: [{
      command: "npx playwright test",
      exit_code: 1,
      status: "failed",
      output_excerpt: "expect(locator).toBeVisible: Timeout 5000ms exceeded",
    }],
  };
  assert.equal(classifyEnvironmentGap({
    machine_check_evaluation: evaluateRequiredChecks(browserChecks, browserProof),
  }, browserChecks, browserProof), null);

  const serviceChecks = [{
    id: "health",
    description: "Probe the local service",
    command: "curl http://127.0.0.1:3000/health",
    environment_required: true,
    environment_kind: "service",
    gap_policy: "waiting_environment",
  }];
  const serviceProof = {
    commands: [{
      command: "curl http://127.0.0.1:3000/health",
      exit_code: 7,
      status: "failed",
      output_excerpt: "Failed to connect: connection refused",
    }],
  };
  assert.deepEqual(classifyEnvironmentGap({
    machine_check_evaluation: evaluateRequiredChecks(serviceChecks, serviceProof),
  }, serviceChecks, serviceProof).check_ids, ["health"]);
});

test("apply-only and release-only gaps do not turn a blocked verifier into a local retry", () => {
  const requiredChecks = [
    { id: "apply", description: "Apply-only environment", command: "node apply-check.mjs", blocking_scope: "apply" },
    { id: "release", description: "Release-only environment", command: "node release-check.mjs", blocking_scope: "release" },
  ];
  const normalized = ensureNodeResultConsistency(
    {
      status: "blocked",
      gate: "blocked",
      summary: "The optional release environment is unavailable",
      skills_applied: [],
      evidence: [],
      findings: [],
      commands: [],
      checks: [
        { id: "apply", status: "fail", evidence: "environment unavailable", command: "node apply-check.mjs", finding_ids: [] },
        { id: "release", status: "fail", evidence: "environment unavailable", command: "node release-check.mjs", finding_ids: [] },
      ],
      files_changed: [],
      blockers: [{ type: "ENVIRONMENT_GAP", reason: "optional environment", unblock_condition: "start it" }],
      next_actions: [],
    },
    { kind: "verification" },
    { commands: [], tool_calls: [] },
    [],
    [],
    requiredChecks,
  );
  assert.equal(normalized.status, "completed");
  assert.equal(normalized.gate, "pass");
  assert.equal(normalized.machine_check_evaluation.completion_pass, true);
  assert.equal(normalized.machine_check_evaluation.application_pass, false);
  assert.equal(normalized.machine_check_evaluation.release_pass, false);
});

test("a completed node with a blocked gate cannot satisfy a dependency", () => {
  assert.equal(
    dependencyGateSatisfied({ status: "completed", gate: "blocked", blockers: [{ type: "ENVIRONMENT_GAP" }], findings: [] }),
    false,
  );
});

test("planner preserves an explicit release-only check scope", () => {
  const plan = normalizePlannerResult(
    {
      task_summary: "Validate release packaging",
      mode: "task",
      scope: ["release"],
      risk_level: "medium",
      completion_criteria: ["code is verified"],
      required_checks: [{
        id: "release-config",
        description: "Validate the release manifest",
        command: "node scripts/verify-release.mjs",
        evidence_tool: null,
        source: "release workflow",
        blocking_scope: "release",
      }],
      discovery_skills: [],
      review_nodes: [],
      implementation_skills: [],
      verification_skills: [],
      excluded_surfaces: [],
    },
    [],
    "Validate release packaging",
  );

  assert.equal(plan.required_checks[0].blocking_scope, "release");
});

test("environment inference covers common project runtimes without marking ordinary commands", () => {
  const cases = [
    ["npx playwright test", "browser"],
    ["docker compose up -d", "container"],
    ["mysql --host 127.0.0.1", "database"],
    ["adb shell getprop", "device"],
    ["curl http://127.0.0.1:3000/health", "service"],
    ["curl https://staging.example.test/health", "external_service"],
  ];
  for (const [command, kind] of cases) {
    const plan = normalizePlannerResult(
      {
        task_summary: "runtime check",
        mode: "task",
        scope: ["workspace"],
        risk_level: "low",
        completion_criteria: ["verified"],
        required_checks: [{ id: "runtime", description: command, command }],
        discovery_skills: [],
        review_nodes: [],
        implementation_skills: [],
        verification_skills: [],
        excluded_surfaces: [],
      },
      [],
      "runtime check",
    );
    assert.equal(plan.required_checks[0].environment_required, true, command);
    assert.equal(plan.required_checks[0].environment_kind, kind, command);
    assert.equal(plan.required_checks[0].gap_policy, "waiting_environment", command);
  }
  const localizedCases = [
    ["微信小程序真机测试", "device"],
    ["微信开发者工具测试", "device"],
    ["在浏览器中采集响应式截图", "browser"],
    ["启动本地数据库容器", "database"],
  ];
  for (const [description, kind] of localizedCases) {
    const plan = normalizePlannerResult(
      {
        task_summary: "localized runtime check",
        mode: "task",
        scope: ["workspace"],
        risk_level: "low",
        completion_criteria: ["verified"],
        required_checks: [{ id: "localized-runtime", description, command: `echo ${description}` }],
        discovery_skills: [],
        review_nodes: [],
        implementation_skills: [],
        verification_skills: [],
        excluded_surfaces: [],
      },
      [],
      "localized runtime check",
    );
    assert.equal(plan.required_checks[0].environment_required, true, description);
    assert.equal(plan.required_checks[0].environment_kind, kind, description);
  }
  const ordinary = normalizePlannerResult(
    {
      task_summary: "unit check",
      mode: "task",
      scope: ["workspace"],
      risk_level: "low",
      completion_criteria: ["verified"],
      required_checks: [{ id: "unit", description: "Run unit tests", command: "npm test" }],
      discovery_skills: [],
      review_nodes: [],
      implementation_skills: [],
      verification_skills: [],
      excluded_surfaces: [],
    },
    [],
    "unit check",
  );
  assert.equal(ordinary.required_checks[0].environment_required, false);
  assert.equal(ordinary.required_checks[0].gap_policy, "fail");

  const localizedRendered = normalizePlannerResult(
    {
      task_summary: "localized rendered evidence",
      mode: "task",
      scope: ["workspace"],
      risk_level: "low",
      completion_criteria: ["在桌面端和移动端完成响应式渲染并保留截图"],
      required_checks: [{ id: "unit", description: "Run unit tests", command: "npm test" }],
      discovery_skills: [],
      review_nodes: [],
      implementation_skills: [],
      verification_skills: [],
      excluded_surfaces: [],
    },
    [],
    "localized rendered evidence",
  );
  assert.ok(localizedRendered.required_checks.some((check) => check.id === "rendered-responsive-evidence"));
});

test("legacy plans gain inferred environment and blocking contracts on exact-run resume", () => {
  const plan = {
    completion_criteria: ["verified"],
    required_checks: [{ id: "browser", description: "Capture a browser screenshot", command: "npx playwright screenshot http://127.0.0.1:3000" }],
    coverage: {},
  };
  assert.equal(ensurePlanEnvironmentContracts(plan), true);
  assert.equal(plan.required_checks[0].environment_required, true);
  assert.equal(plan.required_checks[0].environment_kind, "browser");
  assert.equal(plan.required_checks[0].blocking_scope, "both");
  assert.equal(ensurePlanEnvironmentContracts(plan), false);
});

test("release-only evidence gaps do not become application gate gaps", () => {
  const evaluation = evaluateRequiredChecks([
    { id: "unit", description: "unit tests", command: "npm test", blocking_scope: "both" },
    { id: "release", description: "release check", command: "node release-check.mjs", blocking_scope: "release" },
  ], {
    commands: [{ command: "npm test", exit_code: 0 }],
    claims: [{ id: "unit", status: "pass", evidence: "unit passed" }],
  });
  assert.equal(evaluation.pass, false);
  assert.equal(evaluation.completion_pass, true);
  assert.equal(evaluation.blocking_pass, true);
  assert.equal(evaluation.application_pass, true);
  assert.deepEqual(evaluation.blocking_gaps, []);
  assert.deepEqual(evaluation.release_gaps.map((check) => check.id), ["release"]);
});

test("a release-only gap keeps isolated results applicable while marking the run release-unready", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");

  const execution = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--workspace-mode",
      "copy",
      "--state-root",
      stateRoot,
      "--goal",
      "Repair the fixture and retain release-only environment gaps",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_CLAUDE_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_FAKE_SCENARIO: "release-only-gap",
      },
    },
  );

  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const summary = JSON.parse(execution.stdout.trim());
  assert.equal(summary.status, "completed");
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  const completion = JSON.parse(await readFile(path.join(summary.run_dir, "completion.json"), "utf8"));
  const resultDir = path.join(summary.run_dir, "results");
  const metadata = JSON.parse(await readFile(path.join(resultDir, "metadata.json"), "utf8"));

  assert.equal(completion.machine_check_evaluation.pass, false);
  assert.equal(completion.machine_check_evaluation.blocking_pass, true);
  assert.deepEqual(completion.machine_check_evaluation.release_gaps.map((check) => check.id), ["release-environment"]);
  assert.equal(completion.release_ready, false);
  assert.deepEqual(completion.release_readiness.gaps, ["release-environment"]);
  assert.match(completion.next_actions.join("\n"), /Release check release-environment.*not release-ready.*release-validation Graph run/i);
  assert.equal(run.results.eligible_to_apply, true);
  assert.equal(metadata.eligible_to_apply, true);

  const applied = spawnSync(
    process.execPath,
    [path.join(resultDir, "apply.mjs"), "--result-dir", resultDir, "--workspace", workspace],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  assert.equal(await readFile(path.join(workspace, "graph-output.txt"), "utf8"), "implemented by fake Codex\n");
});

test("an apply-only gap completes local verification but withholds isolated result application", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");

  const execution = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--workspace-mode",
      "copy",
      "--state-root",
      stateRoot,
      "--goal",
      "Repair the fixture but require an apply-only environment check",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_FAKE_SCENARIO: "apply-only-gap",
      },
    },
  );

  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const summary = JSON.parse(execution.stdout.trim());
  assert.equal(summary.status, "completed");
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  const completion = JSON.parse(await readFile(path.join(summary.run_dir, "completion.json"), "utf8"));
  const resultDir = path.join(summary.run_dir, "results");
  const metadata = JSON.parse(await readFile(path.join(resultDir, "metadata.json"), "utf8"));

  assert.equal(completion.machine_check_evaluation.completion_pass, true);
  assert.equal(completion.machine_check_evaluation.application_pass, false);
  assert.deepEqual(completion.machine_check_evaluation.application_gaps.map((check) => check.id), ["apply-environment"]);
  assert.equal(completion.application_ready, false);
  assert.equal(completion.release_ready, true);
  assert.match(completion.next_actions.join("\n"), /Application check apply-environment.*isolated result remains withheld.*start a new Graph run/i);
  assert.equal(run.results.eligible_to_apply, false);
  assert.equal(metadata.application_passed, false);
  assert.equal(metadata.eligible_to_apply, false);
  assert.equal(await readFile(path.join(resultDir, "apply.mjs"), "utf8").catch(() => null), null);
  assert.equal(await readFile(path.join(workspace, "graph-output.txt"), "utf8").catch(() => null), null);
});

test("workspace preflight recognizes Playwright projects and keeps browser preparation isolated", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "package.json"), `${JSON.stringify({
    name: "browser-fixture",
    private: true,
    devDependencies: { "@playwright/test": "1.50.0" },
    scripts: { test: "playwright test" },
  })}\n`, "utf8");
  await writeFile(path.join(workspace, "package-lock.json"), "{}\n", "utf8");
  const plan = await workspacePreflightTest.nodePreparationPlan(workspace, { AEG_AUTO_PREPARE_BROWSERS: "0" });
  assert.equal(workspacePreflightTest.declaredBrowserTool({ devDependencies: { "@playwright/test": "1.50.0" } }), "playwright");
  assert.equal(workspacePreflightTest.declaredBrowserTool({ devDependencies: { puppeteer: "23.0.0" } }), "puppeteer");
  assert.equal(workspacePreflightTest.declaredBrowserTool({ scripts: { test: "agent-browser run" } }), "agent-browser");
  assert.equal(plan.browser.tool, "playwright");
  assert.equal(plan.browser.action, "disabled");
  assert.deepEqual(plan.browser.browsers, ["chromium"]);
  assert.equal(plan.lifecycle_scripts, "disabled");
  assert.ok(plan.args.includes("--ignore-scripts"));
  const deferred = await workspacePreflightTest.nodePreparationPlan(workspace, {});
  assert.equal(deferred.browser.action, "deferred");
  const requested = await workspacePreflightTest.nodePreparationPlan(workspace, {}, { requiredEnvironmentKinds: ["browser"] });
  assert.equal(requested.browser.action, "install");
});

test("workspace preflight detects Node, Python, Go, Rust, Java, and .NET lock inputs without guessing", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "package.json"), `${JSON.stringify({ name: "multi-ecosystem", private: true })}\n`, "utf8");
  await writeFile(path.join(workspace, "package-lock.json"), "{}\n", "utf8");
  await writeFile(path.join(workspace, "pyproject.toml"), "[project]\nname = 'fixture'\n", "utf8");
  await writeFile(path.join(workspace, "poetry.lock"), "# locked\n", "utf8");
  await mkdir(path.join(workspace, "services", "go"), { recursive: true });
  await writeFile(path.join(workspace, "services", "go", "go.mod"), "module fixture\n\ngo 1.22\n", "utf8");
  await writeFile(path.join(workspace, "services", "go", "go.sum"), "fixture v1.0.0 h1:fixture\n", "utf8");
  await mkdir(path.join(workspace, "services", "rust"), { recursive: true });
  await writeFile(path.join(workspace, "services", "rust", "Cargo.toml"), "[package]\nname='fixture'\nversion='0.1.0'\n", "utf8");
  await writeFile(path.join(workspace, "services", "rust", "Cargo.lock"), "version = 3\n", "utf8");
  await mkdir(path.join(workspace, "services", "java", ".mvn", "wrapper"), { recursive: true });
  await writeFile(path.join(workspace, "services", "java", "pom.xml"), "<project></project>\n", "utf8");
  await writeFile(path.join(workspace, "services", "java", "mvnw.cmd"), "@echo off\n", "utf8");
  await writeFile(path.join(workspace, "services", "java", ".mvn", "wrapper", "maven-wrapper.properties"), "distributionUrl=https://example.invalid/maven.zip\n", "utf8");
  await mkdir(path.join(workspace, "services", "dotnet"), { recursive: true });
  await writeFile(path.join(workspace, "services", "dotnet", "fixture.csproj"), "<Project />\n", "utf8");
  await writeFile(path.join(workspace, "services", "dotnet", "packages.lock.json"), "{}\n", "utf8");

  const plans = await workspacePreflightTest.detectEcosystemPlans(workspace, workspace);
  assert.deepEqual(plans.map((plan) => plan.ecosystem), ["python", "go", "java", "rust", "dotnet"]);
  assert.ok(plans.every((plan) => plan.status === "ready"));
  assert.ok(plans.every((plan) => plan.trusted_lock === true));
  const preparation = await prepareExecutionWorkspace({ workspace, isolated: true });
  assert.equal(preparation.status, "pass");
  assert.equal(preparation.plans.length, 6);
  assert.ok(preparation.preparations.filter((item) => item.ecosystem !== "node").every((item) => item.status === "deferred"));
  assert.equal(preparation.commands.length, 0);
});

test("ecosystem preflight records missing and ambiguous locks instead of inventing install commands", async (t) => {
  const root = await temporaryDirectory(t);
  const missing = path.join(root, "missing-python");
  await mkdir(missing, { recursive: true });
  await writeFile(path.join(missing, "pyproject.toml"), "[project]\nname = 'missing-lock'\n", "utf8");
  const missingPlan = await workspacePreflightTest.planPythonProject(missing);
  assert.equal(missingPlan.status, "missing-lock");
  assert.equal(missingPlan.action, "environment_gap");
  assert.deepEqual(missingPlan.args, []);

  const ambiguous = path.join(root, "ambiguous-python");
  await mkdir(ambiguous, { recursive: true });
  await writeFile(path.join(ambiguous, "pyproject.toml"), "[project]\nname = 'ambiguous'\n", "utf8");
  await writeFile(path.join(ambiguous, "uv.lock"), "version = 1\n", "utf8");
  await writeFile(path.join(ambiguous, "poetry.lock"), "# lock\n", "utf8");
  const ambiguousPlan = await workspacePreflightTest.planPythonProject(ambiguous);
  assert.equal(ambiguousPlan.status, "ambiguous");
  assert.equal(ambiguousPlan.action, "environment_gap");
  assert.deepEqual(ambiguousPlan.args, []);
});

test("standard-library-only Go modules do not require a synthetic go.sum", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "stdlib-go");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "go.mod"), "module example.com/stdlib\n\ngo 1.22\n", "utf8");
  const plan = await workspacePreflightTest.planGoProject(workspace);
  assert.equal(plan.status, "ready");
  assert.equal(plan.action, "none");
  assert.deepEqual(plan.lockfiles, []);
  assert.equal(plan.dependency_mode, "stdlib-only");
  const preparation = await prepareExecutionWorkspace({ workspace, isolated: true });
  assert.equal(preparation.status, "pass");
  assert.equal(preparation.readiness, "ready");
  assert.equal(preparation.ready, true);
  assert.deepEqual(preparation.environment_gaps || [], []);
});

test("Go modules with external requirements still need go.sum", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "external-go");
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(workspace, "go.mod"),
    "module example.com/external\n\ngo 1.22\n\nrequire golang.org/x/sync v0.7.0\n",
    "utf8",
  );
  const plan = await workspacePreflightTest.planGoProject(workspace);
  assert.equal(plan.status, "missing-lock");
  assert.equal(plan.action, "environment_gap");
  assert.equal(plan.dependency_mode, "external");
  const preparation = await prepareExecutionWorkspace({ workspace, isolated: true });
  assert.equal(preparation.status, "pass");
  assert.equal(preparation.readiness, "environment_gap");
  assert.equal(preparation.ready, false);
  assert.equal(preparation.environment_gaps.length, 1);
  assert.equal(preparation.environment_gaps[0].status, "missing-lock");
});

test("preflight separates successful inspection from environment readiness", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "unlocked-python");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "pyproject.toml"), "[project]\nname = 'unlocked'\n", "utf8");
  const preparation = await prepareExecutionWorkspace({ workspace, isolated: true });
  assert.equal(preparation.status, "pass");
  assert.equal(preparation.readiness, "environment_gap");
  assert.equal(preparation.ready, false);
  assert.ok(preparation.environment_gaps.some((gap) => gap.ecosystem === "python"));
});

test("workspace preflight disables lifecycle scripts for every supported Node package manager", async (t) => {
  const root = await temporaryDirectory(t);
  const fixtures = [
    { name: "npm", lockfile: "package-lock.json", packageManager: "npm@10.8.0", expected: "--ignore-scripts" },
    { name: "pnpm", lockfile: "pnpm-lock.yaml", packageManager: "pnpm@9.12.0", expected: "--ignore-scripts" },
    { name: "yarn-classic", lockfile: "yarn.lock", packageManager: "yarn@1.22.22", expected: "--ignore-scripts" },
    { name: "yarn-modern", lockfile: "yarn.lock", packageManager: "yarn@4.5.0", expected: "--mode=skip-builds" },
    { name: "bun", lockfile: "bun.lock", packageManager: "bun@1.1.0", expected: "--ignore-scripts" },
  ];
  for (const fixture of fixtures) {
    const workspace = path.join(root, fixture.name);
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "package.json"), `${JSON.stringify({
      name: fixture.name,
      version: "1.0.0",
      private: true,
      packageManager: fixture.packageManager,
      dependencies: { fixture: "1.0.0" },
    })}\n`, "utf8");
    await writeFile(path.join(workspace, fixture.lockfile), "fixture lock\n", "utf8");
    const plan = await workspacePreflightTest.nodePreparationPlan(workspace, {});
    assert.equal(plan.lifecycle_scripts, "disabled", fixture.name);
    assert.ok(plan.args.includes(fixture.expected), `${fixture.name} must use ${fixture.expected}`);
  }
});

test("workspace dependency preparation never runs repository lifecycle scripts", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const marker = path.join(root, "preinstall-ran.txt");
  await mkdir(workspace, { recursive: true });
  const script = "node -e \"require('node:fs').writeFileSync('../preinstall-ran.txt', 'ran')\"";
  await writeFile(path.join(workspace, "package.json"), `${JSON.stringify({
    name: "preflight-script-fixture",
    version: "1.0.0",
    private: true,
    scripts: { preinstall: script, install: script, postinstall: script },
  })}\n`, "utf8");
  await writeFile(path.join(workspace, "package-lock.json"), `${JSON.stringify({
    name: "preflight-script-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "preflight-script-fixture", version: "1.0.0", hasInstallScript: true },
    },
  })}\n`, "utf8");

  const preparation = await prepareExecutionWorkspace({
    workspace,
    isolated: true,
    timeoutMs: 30_000,
    env: workspacePreflightTest.preflightEnvironment(process.env),
    allowHostDependencyPreparation: true,
  });
  assert.equal(preparation.status, "pass");
  assert.equal(preparation.plans[0].lifecycle_scripts, "disabled");
  assert.ok(preparation.commands[0].args.includes("--ignore-scripts"));
  assert.equal(await readFile(marker, "utf8").catch(() => null), null);
});

test("Windows batch package managers preserve command paths containing spaces", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows cmd.exe contract");
    return;
  }
  const invocation = workspacePreflightTest.portableInvocation(
    "C:\\Program Files\\nodejs\\npm.cmd",
    ["ci", "--ignore-scripts"],
  );
  assert.match(invocation.command, /cmd\.exe$/i);
  assert.deepEqual(invocation.args, [
    "/d",
    "/s",
    "/c",
    'call "C:\\Program Files\\nodejs\\npm.cmd" ci --ignore-scripts',
  ]);
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.equal(
    workspacePreflightTest.portableInvocation("C:\\Program Files\\nodejs\\node.exe", ["fixture with spaces"]).windowsVerbatimArguments,
    false,
  );
});

test("workspace preflight honors packageManager and rejects ambiguous or mismatched lockfiles", async (t) => {
  const root = await temporaryDirectory(t);
  const npmWorkspace = path.join(root, "npm-declared");
  await mkdir(npmWorkspace, { recursive: true });
  await writeFile(path.join(npmWorkspace, "package.json"), `${JSON.stringify({
    name: "npm-declared",
    private: true,
    packageManager: "npm@10.8.0",
    dependencies: { fixture: "1.0.0" },
  })}\n`, "utf8");
  await writeFile(path.join(npmWorkspace, "package-lock.json"), "npm lock\n", "utf8");
  await writeFile(path.join(npmWorkspace, "pnpm-lock.yaml"), "pnpm lock\n", "utf8");
  const npmPlan = await workspacePreflightTest.nodePreparationPlan(npmWorkspace, {});
  assert.equal(npmPlan.manager, "npm");
  assert.equal(npmPlan.lockfile, "package-lock.json");
  assert.equal(npmPlan.package_manager, "npm@10.8.0");

  const ambiguous = path.join(root, "ambiguous");
  await mkdir(ambiguous, { recursive: true });
  await writeFile(path.join(ambiguous, "package.json"), `${JSON.stringify({
    name: "ambiguous",
    private: true,
    dependencies: { fixture: "1.0.0" },
  })}\n`, "utf8");
  await writeFile(path.join(ambiguous, "package-lock.json"), "npm lock\n", "utf8");
  await writeFile(path.join(ambiguous, "pnpm-lock.yaml"), "pnpm lock\n", "utf8");
  await assert.rejects(
    workspacePreflightTest.nodePreparationPlan(ambiguous, {}),
    (error) => error?.code === "DEPENDENCY_LOCK_AMBIGUOUS" && /packageManager/.test(error.message),
  );

  const mismatch = path.join(root, "mismatch");
  await mkdir(mismatch, { recursive: true });
  await writeFile(path.join(mismatch, "package.json"), `${JSON.stringify({
    name: "mismatch",
    private: true,
    packageManager: "npm@10.8.0",
    dependencies: { fixture: "1.0.0" },
  })}\n`, "utf8");
  await writeFile(path.join(mismatch, "pnpm-lock.yaml"), "pnpm lock\n", "utf8");
  await assert.rejects(
    workspacePreflightTest.nodePreparationPlan(mismatch, {}),
    (error) => error?.code === "DEPENDENCY_LOCK_MISMATCH" && /npm@10\.8\.0/.test(error.message),
  );
});

test("workspace preflight defers repository-selected host execution and clears isolated dependency caches", async (t) => {
  const root = await temporaryDirectory(t);
  const dependencyWorkspace = path.join(root, "dependencies");
  const dependencyDirectory = path.join(dependencyWorkspace, "node_modules");
  await mkdir(dependencyDirectory, { recursive: true });
  await writeFile(path.join(dependencyWorkspace, "package.json"), `${JSON.stringify({
    name: "dependency-boundary",
    private: true,
    packageManager: "npm@10.8.0",
    dependencies: { fixture: "1.0.0" },
  })}\n`, "utf8");
  await writeFile(path.join(dependencyWorkspace, "package-lock.json"), "npm lock\n", "utf8");
  await writeFile(path.join(dependencyDirectory, "modified-marker.txt"), "untrusted cache\n", "utf8");
  const plan = await workspacePreflightTest.nodePreparationPlan(dependencyWorkspace, {});
  const previous = {
    version: 2,
    status: "pass",
    host: `${os.platform()}-${os.arch()}`,
    dependency_fingerprint: plan.dependency_fingerprint,
    fingerprint: plan.fingerprint,
    plans: [plan],
    preparations: [],
    commands: [],
  };
  const preparation = await prepareExecutionWorkspace({
    workspace: dependencyWorkspace,
    isolated: true,
    previous,
    env: workspacePreflightTest.preflightEnvironment(process.env),
  });
  assert.equal(preparation.cache_reused, false);
  assert.equal(preparation.preparations.find((item) => item.kind === "dependencies")?.status, "deferred");
  assert.equal(preparation.commands.length, 0);
  assert.equal(await readFile(path.join(dependencyDirectory, "modified-marker.txt"), "utf8").catch(() => null), null);

  const browserWorkspace = path.join(root, "browser");
  const browserBin = path.join(browserWorkspace, "node_modules", ".bin");
  const externalMarker = path.join(root, "playwright-host-ran.txt");
  await mkdir(browserBin, { recursive: true });
  await writeFile(path.join(browserWorkspace, "package.json"), `${JSON.stringify({
    name: "browser-boundary",
    private: true,
    scripts: { test: "playwright test" },
  })}\n`, "utf8");
  const browserCommand = path.join(browserBin, process.platform === "win32" ? "playwright.cmd" : "playwright");
  await writeFile(
    browserCommand,
    process.platform === "win32"
      ? `@node -e "require('node:fs').writeFileSync(${JSON.stringify(externalMarker)}, 'ran')"\n`
      : `#!/bin/sh\nnode -e "require('node:fs').writeFileSync(${JSON.stringify(externalMarker)}, 'ran')"\n`,
    "utf8",
  );
  const browserPreparation = await prepareExecutionWorkspace({
    workspace: browserWorkspace,
    isolated: true,
    requiredEnvironmentKinds: ["browser"],
    env: workspacePreflightTest.preflightEnvironment({
      ...process.env,
      AEG_AUTO_PREPARE_BROWSERS: "1",
    }),
  });
  assert.equal(browserPreparation.preparations[0].status, "deferred");
  assert.equal(browserPreparation.preparations[0].host_execution_authorized, false);
  assert.equal(browserPreparation.commands.length, 0);
  assert.equal(await readFile(externalMarker, "utf8").catch(() => null), null);
});

test("workspace preflight never reuses stale browser actions or browser lists", async (t) => {
  const workspace = await temporaryDirectory(t);
  await mkdir(path.join(workspace, "node_modules", ".bin"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), `${JSON.stringify({
    name: "browser-cache",
    private: true,
    scripts: { test: "playwright test" },
  })}\n`, "utf8");
  const oldPlan = await workspacePreflightTest.nodePreparationPlan(
    workspace,
    { AEG_AUTO_PREPARE_BROWSERS: "1", AEG_PLAYWRIGHT_BROWSERS: "chromium" },
    { requiredEnvironmentKinds: ["browser"] },
  );
  const oldRecord = {
    version: 2,
    status: "pass",
    host: `${os.platform()}-${os.arch()}`,
    dependency_fingerprint: oldPlan.dependency_fingerprint,
    fingerprint: oldPlan.fingerprint,
    plans: [oldPlan],
    preparations: [{ ...oldPlan.browser, status: "pass", host_execution_authorized: true }],
    commands: [],
  };
  const expanded = await prepareExecutionWorkspace({
    workspace,
    isolated: true,
    previous: oldRecord,
    requiredEnvironmentKinds: ["browser"],
    env: { AEG_AUTO_PREPARE_BROWSERS: "1", AEG_PLAYWRIGHT_BROWSERS: "chromium,firefox" },
  });
  assert.deepEqual(expanded.plans[0].browser.browsers, ["chromium", "firefox"]);
  assert.deepEqual(expanded.preparations[0].browsers, ["chromium", "firefox"]);
  assert.equal(expanded.preparations[0].status, "deferred");

  const disabledPlan = await workspacePreflightTest.nodePreparationPlan(
    workspace,
    { AEG_AUTO_PREPARE_BROWSERS: "0" },
    { requiredEnvironmentKinds: ["browser"] },
  );
  const disabledRecord = {
    ...oldRecord,
    fingerprint: disabledPlan.fingerprint,
    plans: [disabledPlan],
    preparations: [{ ...disabledPlan.browser, status: "disabled" }],
  };
  const enabled = await prepareExecutionWorkspace({
    workspace,
    isolated: true,
    previous: disabledRecord,
    requiredEnvironmentKinds: ["browser"],
    env: { AEG_AUTO_PREPARE_BROWSERS: "1" },
  });
  assert.equal(enabled.plans[0].browser.action, "install");
  assert.equal(enabled.preparations[0].status, "deferred");
  assert.notEqual(enabled.preparations[0].status, "disabled");
});

test("workspace preflight resolves package managers only from the host PATH", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const hostBin = path.join(root, "host-bin");
  await mkdir(workspace, { recursive: true });
  await mkdir(hostBin, { recursive: true });
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  await writeFile(path.join(workspace, executable), "repository shim\n", "utf8");
  await writeFile(path.join(hostBin, executable), "host tool\n", "utf8");

  const resolved = await workspacePreflightTest.findCommand(["npm"], workspace, {
    PATH: [workspace, path.join(workspace, "node_modules", ".bin"), hostBin].join(path.delimiter),
    Path: [workspace, path.join(workspace, "node_modules", ".bin"), hostBin].join(path.delimiter),
  });
  assert.equal(path.resolve(resolved), path.resolve(hostBin, executable));
});

test("workspace preflight excludes ambient secrets unless a key is explicitly requested", () => {
  const source = {
    PATH: process.env.PATH || "host-path",
    SystemRoot: process.env.SystemRoot || "C:\\Windows",
    GRAPH_TEST_SECRET_TOKEN: "must-not-reach-install-scripts",
    NPM_TOKEN: "explicit-private-registry-token",
    AEG_AUTO_PREPARE_BROWSERS: "0",
    AEG_PLAYWRIGHT_BROWSERS: "chromium,firefox",
  };
  const safe = workspacePreflightTest.preflightEnvironment(source);
  assert.equal(safe.GRAPH_TEST_SECRET_TOKEN, undefined);
  assert.equal(safe.NPM_TOKEN, undefined);
  assert.equal(safe.AEG_AUTO_PREPARE_BROWSERS, "0");
  assert.equal(safe.AEG_PLAYWRIGHT_BROWSERS, "chromium,firefox");
  assert.ok(safe.PATH);

  const explicit = workspacePreflightTest.preflightEnvironment({
    ...source,
    AEG_PREFLIGHT_ENV_KEYS: "NPM_TOKEN",
  });
  assert.equal(explicit.NPM_TOKEN, "explicit-private-registry-token");
  assert.equal(explicit.GRAPH_TEST_SECRET_TOKEN, undefined);
});

test("start requires an explicit user approval marker without guessing goal wording", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });

  const baseArgs = [
    RUNNER,
    "start", // Deliberately omit --user-approved for the rejection case.
    "--workspace",
    workspace,
    "--state-root",
    stateRoot,
    "--goal",
    "Implement the owner-approved portfolio redesign",
    "--dry-run",
    "--json",
  ];
  const rejected = spawnSync(process.execPath, baseArgs, { encoding: "utf8", timeout: INTEGRATION_TIMEOUT });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /--user-approved/);
  assert.deepEqual(await readdir(stateRoot).catch(() => []), []);

  const approved = spawnSync(process.execPath, [...baseArgs, "--user-approved"], {
    encoding: "utf8",
    timeout: INTEGRATION_TIMEOUT,
  });
  assert.equal(approved.status, 0, approved.stderr || approved.stdout);
  const summary = JSON.parse(approved.stdout.trim());
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  assert.equal(run.options.user_approved, true);
  assert.match(run.options.user_approved_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(await readFile(summary.report, "utf8"), /New-run approval marker: recorded at/);
});

test("skill metadata requires explicit Graph opt-in and automatic post-launch monitoring", async () => {
  const metadata = await readFile(path.resolve(TEST_DIR, "..", "..", "agents", "openai.yaml"), "utf8");
  const skill = await readFile(path.resolve(TEST_DIR, "..", "..", "SKILL.md"), "utf8");
  assert.match(metadata, /allow_implicit_invocation:\s*false/);
  assert.match(skill, /current task.*explicitly names|explicitly accepts/is);
  assert.match(skill, /submit .*--user-approved --follow/);
  assert.match(skill, /must not need to ask for status or say "continue"/i);
});

test("agent backend selection validates names and reports usable fallbacks", () => {
  assert.equal(normalizeAgentBackend(undefined), "codex");
  assert.equal(normalizeAgentBackend("claude"), "claude");
  assert.equal(normalizeAgentBackend("CLAUDE"), "claude");
  assert.throws(() => normalizeAgentBackend("gpt-cli"), /--agent-backend must be one of/);
  const order = fallbackBackendOrder("codex", process.cwd());
  assert.equal(Array.isArray(order), true);
  assert.equal(order.includes("codex"), false);
  for (const name of order) assert.ok(AGENT_BACKENDS.includes(name));
});

test("Windows automatic fallback excludes Claude until both native sandbox probes pass", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows capability gate");
    return;
  }
  const root = await temporaryDirectory(t);
  const capabilityFile = path.join(root, "claude-sandbox.json");
  const previousCommand = process.env.AEG_CLAUDE_COMMAND_JSON;
  const previousCapabilityFile = process.env.AEG_CLAUDE_SANDBOX_CAPABILITY_FILE;
  process.env.AEG_CLAUDE_COMMAND_JSON = JSON.stringify([process.execPath, FAKE_CODEX]);
  process.env.AEG_CLAUDE_SANDBOX_CAPABILITY_FILE = capabilityFile;
  t.after(() => {
    if (previousCommand === undefined) delete process.env.AEG_CLAUDE_COMMAND_JSON;
    else process.env.AEG_CLAUDE_COMMAND_JSON = previousCommand;
    if (previousCapabilityFile === undefined) delete process.env.AEG_CLAUDE_SANDBOX_CAPABILITY_FILE;
    else process.env.AEG_CLAUDE_SANDBOX_CAPABILITY_FILE = previousCapabilityFile;
  });

  assert.equal(automaticFallbackBackendAllowed("claude", root), false);
  assert.equal(fallbackBackendOrder("codex", root).includes("claude"), false);
  const readOnly = await recordClaudeSandboxProbe("read-only", root);
  assert.equal(readOnly.automatic_fallback_ready, false);
  assert.equal(fallbackBackendOrder("codex", root).includes("claude"), false);
  const writer = await recordClaudeSandboxProbe("workspace-write", root);
  assert.equal(writer.automatic_fallback_ready, true);
  assert.equal(automaticFallbackBackendAllowed("claude", root), true);
  assert.equal(fallbackBackendOrder("codex", root).includes("claude"), true);
});

test("Claude capability probes use the same configurable record path for writes and reads", () => {
  const previousShared = process.env.AEG_CLAUDE_SANDBOX_CAPABILITY_FILE;
  const previousGeneric = process.env.AEG_CLAUDE_CAPABILITY_FILE;
  const target = path.join(os.tmpdir(), `aeg-claude-capability-${process.pid}.json`);
  delete process.env.AEG_CLAUDE_SANDBOX_CAPABILITY_FILE;
  process.env.AEG_CLAUDE_CAPABILITY_FILE = target;
  try {
    assert.equal(claudeSandboxCapabilityPath(), target);
    assert.equal(claudeSandboxCapabilityPath(), agentCapabilityPath("claude"));
  } finally {
    if (previousShared === undefined) delete process.env.AEG_CLAUDE_SANDBOX_CAPABILITY_FILE;
    else process.env.AEG_CLAUDE_SANDBOX_CAPABILITY_FILE = previousShared;
    if (previousGeneric === undefined) delete process.env.AEG_CLAUDE_CAPABILITY_FILE;
    else process.env.AEG_CLAUDE_CAPABILITY_FILE = previousGeneric;
  }
});

test("agent capability identity rejects same-metadata executable replacement", async (t) => {
  const root = await temporaryDirectory(t);
  const executable = path.join(root, "agent-binary.fixture");
  await writeFile(executable, "aaaaaa", "utf8");
  const fixedTime = new Date("2020-01-01T00:00:00.000Z");
  await utimes(executable, fixedTime, fixedTime);
  const before = invocationIdentity({ command: executable, prefix: [] }, root);
  await writeFile(executable, "bbbbbb", "utf8");
  await utimes(executable, fixedTime, fixedTime);
  const after = invocationIdentity({ command: executable, prefix: [] }, root);

  assert.equal(before.size, after.size);
  assert.equal(before.mtime_ms, after.mtime_ms);
  assert.notEqual(before.content_sha256, after.content_sha256);

  const record = {
    version: 3,
    backend: "codex",
    platform: process.platform,
    arch: process.arch,
    runner_sha256: "runner-fixture",
    invocation: before,
    probes: { "read-only": { passed_at: new Date().toISOString() }, "workspace-write": { passed_at: new Date().toISOString() } },
  };
  assert.equal(agentSandboxCapabilityMatches(record, { ...record, invocation: before }), true);
  assert.equal(agentSandboxCapabilityMatches(record, { ...record, invocation: after }), false);
  assert.equal(agentSandboxCapabilityMatches({ ...record, version: 2 }, { ...record, invocation: before }), false);
});

test("agent capability identity binds a prefixed CLI script", async (t) => {
  const root = await temporaryDirectory(t);
  const script = path.join(root, "agent-cli.fixture.mjs");
  const fixedTime = new Date("2020-01-01T00:00:00.000Z");
  await writeFile(script, "aaaaaa", "utf8");
  await utimes(script, fixedTime, fixedTime);
  const before = invocationIdentity({ command: process.execPath, prefix: [script] }, root);
  await writeFile(script, "bbbbbb", "utf8");
  await utimes(script, fixedTime, fixedTime);
  const after = invocationIdentity({ command: process.execPath, prefix: [script] }, root);

  assert.notDeepEqual(before.prefix_files, after.prefix_files);
  assert.notEqual(before.prefix_files[0].content_sha256, after.prefix_files[0].content_sha256);
});

test("concurrent capability probes merge both sandbox dimensions", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows capability record contract");
    return;
  }
  const root = await temporaryDirectory(t);
  const capabilityFile = path.join(root, "codex.json");
  const previousCommand = process.env.AEG_CODEX_COMMAND_JSON;
  const previousCapability = process.env.AEG_CODEX_CAPABILITY_FILE;
  process.env.AEG_CODEX_COMMAND_JSON = JSON.stringify([process.execPath, FAKE_CODEX]);
  process.env.AEG_CODEX_CAPABILITY_FILE = capabilityFile;
  t.after(() => {
    if (previousCommand === undefined) delete process.env.AEG_CODEX_COMMAND_JSON;
    else process.env.AEG_CODEX_COMMAND_JSON = previousCommand;
    if (previousCapability === undefined) delete process.env.AEG_CODEX_CAPABILITY_FILE;
    else process.env.AEG_CODEX_CAPABILITY_FILE = previousCapability;
  });
  await Promise.all([
    recordAgentSandboxProbe("codex", "read-only", root),
    recordAgentSandboxProbe("codex", "workspace-write", root),
  ]);
  const record = JSON.parse(await readFile(capabilityFile, "utf8"));
  assert.ok(record.probes?.["read-only"]?.passed_at);
  assert.ok(record.probes?.["workspace-write"]?.passed_at);
});

test("test-only capability bypass requires the repository fake-agent binding", () => {
  const matrix = {
    backend: "codex",
    installed: { status: "PASS", value: "codex" },
    invocable: { status: "PASS", value: "fixture" },
    "read-sandbox-verified": { status: "WARN", value: "unverified" },
    "write-sandbox-verified": { status: "WARN", value: "unverified" },
    "automatic-fallback-ready": { status: "WARN", value: "not-ready" },
  };
  const previousMode = process.env.AEG_TEST_MODE;
  const previousCommand = process.env.AEG_CODEX_COMMAND_JSON;
  const previousClaudeCommand = process.env.AEG_CLAUDE_COMMAND_JSON;
  const previousScenario = process.env.AEG_FAKE_SCENARIO;
  process.env.AEG_TEST_MODE = "1";
  delete process.env.AEG_CODEX_COMMAND_JSON;
  delete process.env.AEG_CLAUDE_COMMAND_JSON;
  delete process.env.AEG_FAKE_SCENARIO;
  try {
    assert.equal(agentCapabilityDoctor({ backend: "codex", matrix, strict: true }).status, "blocked");
    process.env.AEG_CODEX_COMMAND_JSON = JSON.stringify([process.execPath, FAKE_CODEX]);
    process.env.AEG_FAKE_SCENARIO = "happy";
    assert.equal(agentCapabilityDoctor({ backend: "codex", matrix, strict: true }).status, "ready");
    assert.equal(agentCapabilityDoctor({ backend: "claude", matrix: { ...matrix, backend: "claude" }, strict: true }).status, "blocked");
  } finally {
    if (previousMode === undefined) delete process.env.AEG_TEST_MODE;
    else process.env.AEG_TEST_MODE = previousMode;
    if (previousCommand === undefined) delete process.env.AEG_CODEX_COMMAND_JSON;
    else process.env.AEG_CODEX_COMMAND_JSON = previousCommand;
    if (previousClaudeCommand === undefined) delete process.env.AEG_CLAUDE_COMMAND_JSON;
    else process.env.AEG_CLAUDE_COMMAND_JSON = previousClaudeCommand;
    if (previousScenario === undefined) delete process.env.AEG_FAKE_SCENARIO;
    else process.env.AEG_FAKE_SCENARIO = previousScenario;
  }
});

test("read-only smoke evidence requires a host-observed denied write", () => {
  const noOp = readonlySandboxProbeEvidence({
    sandbox: "read-only",
    commands: [],
    tool_calls: [],
    machine_failures: [],
  }, "blocked.txt");
  assert.equal(noOp.passed, false);

  const denied = readonlySandboxProbeEvidence({
    sandbox: "read-only",
    commands: [{ command: "[IO.File]::WriteAllText('blocked.txt', 'x')", exit_code: 0, status: "completed" }],
    tool_calls: [],
    machine_failures: [{ type: "sandbox_write_denied", operation: "WriteAllText" }],
  }, "blocked.txt");
  assert.equal(denied.passed, true);
});

test("machine proof recognizes a caught PowerShell write denial", () => {
  const failures = machineFailuresFromProof({
    sandbox: "read-only",
    commands: [{
      command: "[IO.File]::WriteAllText('blocked.txt', 'x')",
      exit_code: 0,
      status: "completed",
      output_excerpt: "Access is denied",
    }],
    tool_calls: [],
    errors: [],
  });
  assert.ok(failures.some((failure) => failure.type === "sandbox_write_denied"));
});

test("claude node arguments deny file mutation for a read-only node", () => {
  const workspace = "C:\\fixture\\workspace";
  const settingsPath = "C:\\fixture\\claude-settings.json";
  const readOnly = claudeAgentArgs({
    schema: "{}",
    workspace,
    sandbox: "read-only",
    model: null,
    isolatedConfig: true,
    mcpConfigPath: "C:\\fixture\\mcp.json",
    settingsPath,
    sourceMutationAllowed: false,
  });
  assert.ok(readOnly.includes("--disallowedTools"));
  assert.ok(readOnly.includes("Write"));
  assert.ok(readOnly.includes("--strict-mcp-config"));
  assert.ok(readOnly.includes("--safe-mode"));
  assert.ok(readOnly.includes("--no-session-persistence"));
  assert.deepEqual(readOnly.slice(readOnly.indexOf("--settings"), readOnly.indexOf("--settings") + 2), [
    "--settings",
    settingsPath,
  ]);
  assert.deepEqual(readOnly.slice(readOnly.indexOf("--permission-mode"), readOnly.indexOf("--permission-mode") + 2), [
    "--permission-mode",
    "plan",
  ]);
  // Every node needs the shell to run its own verification commands without an
  // interactive approver.
  assert.ok(readOnly.includes("--allowed-tools"));
  assert.ok(readOnly.includes("PowerShell") || readOnly.includes("Bash"));

  assert.deepEqual(claudeSandboxSettings({ workspace, sandbox: "read-only" }), {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      filesystem: {
        allowWrite: [],
        denyWrite: [workspace],
      },
    },
  });

  const writer = claudeAgentArgs({
    schema: "{}",
    workspace,
    sandbox: "workspace-write",
    model: "fixture-model",
    reasoningEffort: "xhigh",
    isolatedConfig: true,
    mcpConfigPath: "C:\\fixture\\mcp.json",
    settingsPath,
    sourceMutationAllowed: true,
  });
  assert.equal(writer.includes("--disallowedTools"), false);
  assert.ok(writer.includes("Edit"));
  assert.ok(writer.includes("--model"));
  assert.ok(writer.includes("fixture-model"));
  assert.deepEqual(writer.slice(writer.indexOf("--effort"), writer.indexOf("--effort") + 2), ["--effort", "xhigh"]);
  assert.deepEqual(claudeSandboxSettings({ workspace, sandbox: "workspace-write" }).sandbox.filesystem, {
    allowWrite: [workspace],
    denyWrite: [],
  });

  const verifier = claudeAgentArgs({
    schema: "{}",
    workspace,
    sandbox: "workspace-write",
    model: null,
    isolatedConfig: true,
    mcpConfigPath: "C:\\fixture\\mcp.json",
    settingsPath,
    sourceMutationAllowed: false,
  });
  assert.ok(verifier.includes("--disallowedTools"));
  assert.ok(verifier.includes("Write"));
  assert.ok(verifier.includes("PowerShell") || verifier.includes("Bash"));

  const ultra = claudeAgentArgs({
    schema: "{}",
    workspace: "C:\\fixture\\workspace",
    sandbox: "read-only",
    model: null,
    reasoningEffort: "ultra",
    isolatedConfig: false,
    mcpConfigPath: "C:\\fixture\\mcp.json",
    settingsPath,
    sourceMutationAllowed: false,
  });
  assert.deepEqual(ultra.slice(ultra.indexOf("--effort"), ultra.indexOf("--effort") + 2), ["--effort", "max"]);
});

test("validation nodes may write ignored test artifacts while ordinary reviewers remain sandbox read-only", () => {
  assert.equal(nodeSandboxMode({ kind: "review", write_access: false }), "read-only");
  assert.equal(nodeSandboxMode({ kind: "supervision", write_access: false }), "read-only");
  assert.equal(nodeSandboxMode({ kind: "implementation", write_access: true }), "workspace-write");
  assert.equal(nodeSandboxMode({ kind: "verification", write_access: false }), "workspace-write");
  assert.equal(nodeSandboxMode({ kind: "independent_review", write_access: false }), "workspace-write");
});

test("every non-writer node rejects tracked or unignored source mutation", () => {
  for (const kind of ["discovery", "review", "synthesis", "supervision", "verification", "independent_review"]) {
    const result = ensureNodeResultConsistency(
      {
        status: "completed",
        gate: "pass",
        summary: "read-only work completed",
        skills_applied: [],
        evidence: [],
        findings: [],
        blockers: [],
        commands: [],
        checks: [],
        next_actions: [],
      },
      { kind, write_access: false },
      { commands: [], tool_calls: [], machine_failures: [] },
      ["unexpected.txt"],
      [],
      [],
    );
    assert.equal(result.status, "blocked", kind);
    assert.ok(
      result.blockers.some((blocker) => ["READ_ONLY_SOURCE_MUTATION", "VALIDATION_SOURCE_MUTATION"].includes(blocker.type)),
      kind,
    );
  }
});

test("validation may write the three runner-owned audit artifacts but not source files", () => {
  const base = {
    status: "completed",
    gate: "pass",
    summary: "validation completed",
    skills_applied: [],
    evidence: [],
    findings: [],
    commands: [{ command: "node --version", exit_code: 0, summary: "runtime available" }],
    checks: [],
    files_changed: [],
    blockers: [],
    next_actions: [],
  };
  const proof = {
    commands: [{ command: "node --version", exit_code: 0, status: "completed" }],
    tool_calls: [],
    machine_failures: [],
  };
  const allowed = ensureNodeResultConsistency(
    base,
    { kind: "verification" },
    proof,
    ["completion.json", "finding-lineage.json", "report.md"],
    [],
  );
  assert.equal(allowed.status, "completed");
  assert.equal(allowed.gate, "pass");
  assert.deepEqual(allowed.files_changed, []);

  const sourceMutation = ensureNodeResultConsistency(
    base,
    { kind: "verification" },
    proof,
    ["completion.json", "src/fixture.ts", "report.md"],
    [],
  );
  assert.equal(sourceMutation.status, "blocked");
  assert.deepEqual(sourceMutation.files_changed, ["src/fixture.ts"]);
  assert.ok(sourceMutation.blockers.some((blocker) => blocker.type === "VALIDATION_SOURCE_MUTATION"));
});

test("planner source mutation is blocked before a graph is compiled", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const execution = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--workspace-mode",
      "copy",
      "--state-root",
      stateRoot,
      "--goal",
      "Prove that the planner cannot mutate project source",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_EXECUTION_ROOT: path.join(root, "isolated"),
        AEG_FAKE_SCENARIO: "planner-source-mutation",
      },
    },
  );
  assert.equal(execution.status, 2, execution.stderr || execution.stdout);
  const summary = JSON.parse(execution.stdout.trim());
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  const proof = JSON.parse(await readFile(path.join(summary.run_dir, "nodes", "planner", "proof.json"), "utf8"));
  assert.equal(summary.status, "blocked");
  assert.equal(run.blocker.type, "READ_ONLY_SOURCE_MUTATION");
  assert.deepEqual(run.blocker.changed_files, ["planner-mutation.txt"]);
  assert.equal(proof.read_only_mutation, true);
  assert.deepEqual(proof.observed_files_changed, ["planner-mutation.txt"]);
  assert.equal(await readFile(path.join(workspace, "planner-mutation.txt"), "utf8").catch(() => null), null);
});

test("file permission changes are part of manifest differences", () => {
  const before = { files: { "script.sh": { kind: "file", sha256: "same", mode: 0o644 } } };
  const after = { files: { "script.sh": { kind: "file", sha256: "same", mode: 0o755 } } };
  assert.deepEqual(diffManifests(before, after), ["script.sh"]);
});

test("Git state comparison fails closed when a snapshot identity field is missing", () => {
  const complete = {
    git: true,
    head: "0123456789abcdef",
    refs_sha256: "refs-hash",
    git_config_sha256: "config-hash",
  };
  assert.equal(gitStateChanged(complete, { ...complete }), false);
  for (const field of ["head", "refs_sha256", "git_config_sha256"]) {
    assert.equal(gitStateChanged({ ...complete, [field]: null }, { ...complete, [field]: null }), true);
    assert.equal(gitStateChanged(complete, { ...complete, [field]: "" }), true);
  }
  assert.equal(gitStateChanged({ git: false }, { git: false }), false);
});

test("a validation node is blocked when it changes tracked or unignored workspace files", () => {
  const result = ensureNodeResultConsistency(
    {
      status: "completed",
      gate: "pass",
      summary: "tests passed after changing a fixture",
      skills_applied: [],
      evidence: [],
      findings: [],
      commands: [{ command: "npm test", exit_code: 0, summary: "passed" }],
      checks: [{ id: "unit-tests", status: "pass", evidence: "passed", command: "npm test", finding_ids: [] }],
      files_changed: [],
      blockers: [],
      next_actions: [],
    },
    { kind: "verification" },
    { commands: [{ command: "npm test", exit_code: 0 }], tool_calls: [{ type: "command_execution", name: "shell", status: "completed" }] },
    ["src/fixture.ts"],
    [],
    [{ id: "unit-tests", description: "Run tests", command: "npm test", evidence_tool: null, source: "package.json" }],
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.gate, "blocked");
  assert.ok(result.blockers.some((blocker) => blocker.type === "VALIDATION_SOURCE_MUTATION"));
  assert.ok(result.findings.some((finding) => finding.id === "RUNNER-VALIDATION-SOURCE-MUTATION"));
});

test("writer capability blockers require current-node machine evidence", () => {
  const base = {
    status: "blocked",
    gate: "blocked",
    summary: "writer claims it is read-only",
    skills_applied: [],
    evidence: [],
    findings: [],
    commands: [],
    checks: [],
    files_changed: [],
    blockers: [
      { type: "SCOPE", reason: "The current file system is read-only.", unblock_condition: "Use workspace-write." },
      { type: "TOOLING", reason: "pnpm is unavailable.", unblock_condition: "Run pnpm elsewhere." },
    ],
    next_actions: [],
  };
  const withoutEvidence = ensureNodeResultConsistency(
    base,
    { kind: "implementation" },
    { sandbox: "workspace-write", commands: [], tool_calls: [], machine_failures: [] },
    [],
    [],
  );
  assert.equal(withoutEvidence.status, "needs_retry");
  assert.equal(withoutEvidence.gate, "fail");
  assert.deepEqual(withoutEvidence.blockers.map((blocker) => blocker.type), ["CAPABILITY_EVIDENCE_REQUIRED"]);

  const withEvidence = ensureNodeResultConsistency(
    {
      ...base,
      commands: [{ command: "pnpm test", exit_code: 1, summary: "command could not start" }],
      blockers: [
        { type: "EXECUTION_CAPABILITY", reason: "The current sandbox denied a file write.", unblock_condition: "Restore workspace-write." },
        { type: "TOOLING", reason: "pnpm failed in this node.", unblock_condition: "Install or repair pnpm." },
      ],
    },
    { kind: "implementation" },
    {
      sandbox: "workspace-write",
      commands: [{ command: "pnpm test", exit_code: 1, status: "failed" }],
      tool_calls: [{ type: "file_change", name: "file_change", status: "failed" }],
      errors: ["file change rejected: read-only file system"],
      machine_failures: [
        { type: "sandbox_write_denied", operation: "file_change", status: "failed" },
        { type: "command_failed", command: "pnpm test", exit_code: 1, status: "failed" },
      ],
    },
    [],
    [],
  );
  assert.equal(withEvidence.status, "blocked");
  assert.deepEqual(withEvidence.blockers.map((blocker) => blocker.type), ["EXECUTION_CAPABILITY", "TOOLING"]);
});

test("ordinary task-scope blockers are not mistaken for sandbox failures", () => {
  const result = ensureNodeResultConsistency(
    {
      status: "blocked",
      gate: "blocked",
      summary: "requested work is outside the approved goal",
      skills_applied: [],
      evidence: [],
      findings: [],
      commands: [],
      checks: [],
      files_changed: [],
      blockers: [{ type: "SCOPE", reason: "The requested deployment is outside this repository audit.", unblock_condition: "Approve a separate deployment task." }],
      next_actions: [],
    },
    { kind: "implementation" },
    { sandbox: "workspace-write", commands: [], tool_calls: [], machine_failures: [] },
    [],
    [],
  );
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.blockers.map((blocker) => blocker.type), ["SCOPE"]);
});

test("planner supervision receives only the planner artifact rather than all prior run history", async (t) => {
  const runDir = await temporaryDirectory(t);
  const plannerDir = path.join(runDir, "nodes", "planner");
  const discoveryDir = path.join(runDir, "nodes", "discovery");
  await mkdir(plannerDir, { recursive: true });
  await mkdir(discoveryDir, { recursive: true });
  await atomicWriteJson(path.join(plannerDir, "result.json"), {
    task_summary: "Audit the fixture",
    mode: "audit",
    scope: ["workspace"],
    risk_level: "high",
    owner_gate: { required: false, reason: "", unblock_condition: "" },
    completion_criteria: ["verified"],
    required_checks: [{ id: "tests", description: "Run tests", command: "npm test", evidence_tool: null, source: "package.json" }],
    discovery_skills: ["fixture-review"],
    review_nodes: [{ id: "review-engineering", title: "Engineering", focus: "correctness", skills: [] }],
    excluded_surfaces: [],
  });
  await atomicWriteJson(path.join(plannerDir, "proof.json"), {
    process_exit_code: 0,
    timed_out: false,
    commands: [{ command: "Get-Content package.json", exit_code: 0, status: "completed", output_excerpt: "large output that should be removed" }],
    tool_calls: [{ type: "command_execution", name: "shell", status: "completed" }],
    errors: [],
    supplied_skills: [],
    observed_files_changed: [],
  });
  await atomicWriteJson(path.join(discoveryDir, "result.json"), { summary: "must not be included" });
  await atomicWriteJson(path.join(discoveryDir, "proof.json"), { commands: [] });
  const run = {
    node_order: ["planner", "discovery"],
    supervision_state: {},
  };
  const context = JSON.parse(await dependencyContext(
    { kind: "supervision", stage: "planner", depends_on: ["planner"] },
    runDir,
    run,
  ));

  assert.deepEqual(context.map((entry) => entry.node), ["planner"]);
  assert.equal(context[0].result.owner_gate.required, false);
  assert.deepEqual(context[0].result.discovery_skills, ["fixture-review"]);
  assert.ok(context[0].result.controller_managed_graph.compiled_nodes.some((node) => node.id === "discovery" && node.kind === "discovery"));
  assert.ok(context[0].result.controller_managed_graph.dynamic_stages.some((node) => node.id === "verification-r0"));
  assert.equal(context[0].proof.commands[0].output_excerpt, undefined);
  assert.equal(JSON.stringify(context).includes("must not be included"), false);
});

test("implementation supervision rechecks retain the original implementation artifact after correction", async (t) => {
  const runDir = await temporaryDirectory(t);
  for (const [id, summary] of [
    ["implementation", "original implementation scope"],
    ["correction-r1", "bounded correction scope"],
  ]) {
    const nodeDir = path.join(runDir, "nodes", id);
    await mkdir(nodeDir, { recursive: true });
    await atomicWriteJson(path.join(nodeDir, "result.json"), {
      status: "completed",
      gate: "not_applicable",
      summary,
      evidence: [],
      findings: [],
      blockers: [],
      next_actions: [],
      files_changed: id === "implementation" ? ["apps/server/src/fix.ts"] : ["completion.json"],
    });
    await atomicWriteJson(path.join(nodeDir, "proof.json"), {
      process_exit_code: 0,
      timed_out: false,
      commands: [],
      tool_calls: [],
      errors: [],
      supplied_skills: [],
      observed_files_changed: id === "implementation" ? ["apps/server/src/fix.ts"] : ["completion.json"],
    });
  }
  const context = JSON.parse(await dependencyContext(
    {
      kind: "supervision",
      stage: "implementation",
      depends_on: ["correction-r1", "implementation-supervision"],
    },
    runDir,
    {
      plan: { required_checks: [] },
      nodes: {
        implementation: { kind: "implementation" },
        "implementation-supervision": { kind: "supervision" },
        "correction-r1": { kind: "correction" },
      },
      supervision_state: {},
    },
  ));

  assert.deepEqual(context.map((entry) => entry.node), ["correction-r1", "implementation"]);
  assert.equal(context.find((entry) => entry.node === "implementation").result.files_changed[0], "apps/server/src/fix.ts");
});

test("claude event streams yield command evidence and the structured result", () => {
  const events = [
    { type: "system", subtype: "init", session_id: "fixture-session" },
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "call-1", name: "PowerShell", input: { command: "node --test" } }] },
    },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-1", is_error: false, content: "pass 2" }] } },
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "call-2", name: "Edit", input: { file_path: "math.mjs" } }] },
    },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-2", is_error: false, content: "ok" }] } },
    { type: "result", subtype: "success", is_error: false, structured_output: { status: "completed" } },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");

  const proof = proofFromClaudeEvents(events);
  assert.equal(proof.thread_id, "fixture-session");
  assert.equal(proof.commands.length, 1);
  assert.equal(proof.commands[0].command, "node --test");
  assert.equal(proof.commands[0].exit_code, 0);
  assert.ok(proof.tool_calls.some((call) => call.type === "file_change"));
  assert.equal(proof.errors.length, 0);
  assert.equal(claudeLastMessageFromEvents(events), JSON.stringify({ status: "completed" }));

  const failing = [
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "call-3", name: "Bash", input: { command: "npm test" } }] },
    },
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "call-3", is_error: true, content: "1 failing" }] },
    },
    { type: "result", subtype: "error_during_execution", is_error: true, result: "command refused" },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  const failingProof = proofFromClaudeEvents(failing);
  assert.equal(failingProof.commands[0].exit_code, 1);
  assert.equal(failingProof.commands[0].status, "failed");
  assert.ok(failingProof.errors.length >= 1);
});

test("agent backend and fallback survive a resume without being re-specified", () => {
  const base = parseArgs(["start", "--agent-backend", "claude", "--workspace", "."]);
  assert.equal(base.options["agent-backend"], "claude");
  const resumed = optionsForResume(
    { agentBackend: "codex", agentFallback: true },
    {},
    { options: { agent_backend: "claude", agent_fallback: false } },
  );
  assert.equal(resumed.agentBackend, "claude");
  assert.equal(resumed.agentFallback, false);
  const overridden = optionsForResume(
    { agentBackend: "codex", agentFallback: true },
    { "agent-backend": "codex" },
    { options: { agent_backend: "claude", agent_fallback: true } },
  );
  assert.equal(overridden.agentBackend, "codex");
});

test("isolated child configuration preserves an explicit model without user plugins", () => {
  const args = isolatedCodexConfigArgs({ model: "fixture-model", reasoningEffort: "high" });
  assert.ok(args.includes("--ignore-user-config"));
  assert.deepEqual(args.slice(0, 3), ["--ignore-user-config", "--model", "fixture-model"]);
  assert.equal(args.some((value) => /plugins\.|mcp_servers\./.test(value)), false);
  assert.ok(args.includes('model_reasoning_effort="high"'));
});

test("isolated Codex configuration preserves the Windows sandbox implementation", () => {
  const args = isolatedCodexConfigArgs({
    platform: "win32",
    settings: {
      model: "fixture-model",
      model_provider: null,
      model_reasoning_effort: "medium",
      windows_sandbox: "elevated",
    },
  });
  assert.ok(args.includes('windows.sandbox="elevated"'));
  assert.equal(
    isolatedCodexConfigArgs({ platform: "linux", settings: { windows_sandbox: "elevated" } }).includes(
      'windows.sandbox="elevated"',
    ),
    false,
  );
});

test("credential-bearing Codex provider URLs never enter isolated child argv", () => {
  const settings = {
    model_provider: "custom",
    provider_name: "custom",
    provider_wire_api: "responses",
    provider_requires_openai_auth: true,
    provider_base_url: "https://routing-user:routing-secret@example.invalid/v1?api_key=query-secret",
  };
  assert.throws(
    () => isolatedCodexConfigArgs({ settings, sourceEnvironment: {} }),
    /move the endpoint to OPENAI_BASE_URL.*AEG_CHILD_ENV_KEYS/,
  );
  const args = isolatedCodexConfigArgs({
    settings,
    sourceEnvironment: {
      OPENAI_BASE_URL: "https://routing-user:routing-secret@example.invalid/v1?api_key=query-secret",
      AEG_CHILD_ENV_KEYS: "OPENAI_BASE_URL",
    },
  });
  assert.equal(args.some((value) => value.includes("routing-secret") || value.includes("query-secret")), false);
  assert.equal(args.some((value) => value.includes("model_providers.custom.base_url")), false);
});

test("every queried Codex provider URL requires explicit environment projection", () => {
  for (const queryKey of ["client_secret", "key", "private_token", "jwt", "routing_hint"]) {
    const secret = `review-${queryKey}-value`;
    const providerBaseUrl = `https://example.invalid/v1?${queryKey}=${secret}`;
    const settings = {
      model_provider: "custom",
      provider_name: "custom",
      provider_wire_api: "responses",
      provider_requires_openai_auth: true,
      provider_base_url: providerBaseUrl,
    };
    assert.throws(
      () => isolatedCodexConfigArgs({ settings, sourceEnvironment: {} }),
      /move the endpoint to OPENAI_BASE_URL.*AEG_CHILD_ENV_KEYS/,
    );
    const args = isolatedCodexConfigArgs({
      settings,
      sourceEnvironment: {
        OPENAI_BASE_URL: providerBaseUrl,
        AEG_CHILD_ENV_KEYS: "OPENAI_BASE_URL",
      },
    });
    assert.equal(args.some((value) => value.includes(secret)), false);
    assert.equal(args.some((value) => value.includes("model_providers.custom.base_url")), false);
  }
});

test("Codex invocation selection prefers the newest compatible CLI", () => {
  const candidates = [
    { command: "old-codex", prefix: [] },
    { command: "broken-codex", prefix: [] },
    { command: "desktop-codex", prefix: [] },
  ];
  const versions = new Map([
    ["old-codex", { status: 0, stdout: "codex-cli 0.145.0", stderr: "" }],
    ["broken-codex", { status: 1, stdout: "", stderr: "access denied" }],
    ["desktop-codex", { status: 0, stdout: "codex-cli 0.147.0-alpha.6.6", stderr: "" }],
  ]);
  const selected = newestWorkingCodexInvocation(candidates, (candidate, args) => {
    if (args.includes("--version")) return versions.get(candidate.command);
    return { status: candidate.command === "broken-codex" ? 1 : 0, stdout: "", stderr: "" };
  });
  assert.equal(selected.command, "desktop-codex");
});

test("Codex invocation selection skips a newer CLI that rejects unattended arguments", () => {
  const candidates = [
    { command: "codex-145", prefix: [] },
    { command: "codex-147", prefix: [] },
  ];
  const selected = newestWorkingCodexInvocation(candidates, (candidate, args) => {
    if (args.includes("--version")) {
      return {
        status: 0,
        stdout: candidate.command === "codex-145" ? "codex-cli 0.145.0" : "codex-cli 0.147.0-alpha.6.6",
        stderr: "",
      };
    }
    if (candidate.command === "codex-147") {
      return { status: 2, stdout: "", stderr: "unexpected argument '--ask-for-approval'" };
    }
    return { status: 0, stdout: "", stderr: "" };
  });
  assert.equal(selected.command, "codex-145");
});

test("Codex unattended arguments stay explicit for every supported version and sandbox", () => {
  const versions = [
    { core: [0, 145, 0], prerelease: null },
    { core: [0, 147, 0], prerelease: ["alpha", 6, 6] },
  ];
  for (const version of versions) {
    assert.deepEqual(codexExecArgs({ version, sandbox: "read-only" }), ["--ask-for-approval", "never"]);
    assert.deepEqual(codexExecArgs({ version, sandbox: "workspace-write" }), ["--ask-for-approval", "never"]);
  }
});

test("runtime documentation assigns concrete owner gates only to synthesis", async () => {
  const contract = await readFile(GRAPH_CONTRACT, "utf8");
  const skill = await readFile(AUTONOMOUS_SKILL, "utf8");
  const lifecycleController = await readFile(LIFECYCLE_CONTROLLER, "utf8");
  const nodeRuntimeContract = await readFile(NODE_RUNTIME_CONTRACT, "utf8");
  assert.doesNotMatch(contract, /planner records an owner gate/i);
  assert.doesNotMatch(contract, /planning may open a gate/i);
  assert.match(contract, /synthesis may open .* gate/i);
  assert.doesNotMatch(skill, /structured planning decision or synthesis blocker/i);
  assert.match(skill, /only synthesis may create .* owner gate/i);
  assert.doesNotMatch(lifecycleController, /names genuine owner gates/i);
  assert.match(lifecycleController, /does not create an owner gate/i);
  assert.match(nodeRuntimeContract, /planner cannot create an owner gate/i);
  assert.match(nodeRuntimeContract, /copy the complete literal command submitted in the\s+successful tool call/i);
});

test("Windows isolated config keeps the shared sandbox home", () => {
  assert.equal(separateCodexHomeRequired("win32"), false);
  assert.equal(separateCodexHomeRequired("linux"), true);
  assert.equal(separateCodexHomeRequired("darwin"), true);
});

test("output schemas are compatible with Structured Outputs", async () => {
  const unsupported = new Set([
    "allOf",
    "dependentRequired",
    "dependentSchemas",
    "else",
    "if",
    "not",
    "oneOf",
    "then",
    "uniqueItems",
  ]);
  const schemaDirectory = path.resolve(TEST_DIR, "..", "schemas");

  for (const name of ["planner-result.schema.json", "node-result.schema.json"]) {
    const schema = JSON.parse(await readFile(path.join(schemaDirectory, name), "utf8"));
    const found = [];
    const incompleteObjects = [];
    const visit = (value, location = "$") => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${location}[${index}]`));
        return;
      }
      if (!value || typeof value !== "object") return;
      if (value.properties) {
        const propertyNames = Object.keys(value.properties).sort();
        const required = Array.isArray(value.required) ? [...value.required].sort() : [];
        if (
          value.type !== "object" ||
          value.additionalProperties !== false ||
          JSON.stringify(propertyNames) !== JSON.stringify(required)
        ) {
          incompleteObjects.push(location);
        }
      }
      for (const [key, item] of Object.entries(value)) {
        if (unsupported.has(key)) found.push(`${location}.${key}`);
        visit(item, `${location}.${key}`);
      }
    };
    visit(schema);
    assert.deepEqual(found, [], `${name} contains unsupported Structured Outputs keywords`);
    assert.deepEqual(incompleteObjects, [], `${name} contains incomplete object declarations`);
  }
});

test("workspace run buckets follow the host filesystem case rules", () => {
  const upper = workspaceBucket("state", path.join("root", "Repo"));
  const lower = workspaceBucket("state", path.join("root", "repo"));
  if (process.platform === "win32") assert.equal(upper, lower);
  else assert.notEqual(upper, lower);
});

test("resume requires an exact run id when several incomplete runs exist", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  const bucket = workspaceBucket(stateRoot, workspace);

  for (const [runId, createdAt] of [
    ["run-older", "2026-08-10T00:00:00.000Z"],
    ["run-newer", "2026-08-10T01:00:00.000Z"],
  ]) {
    const directory = path.join(bucket, runId);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "run.json"),
      `${JSON.stringify({ run_id: runId, workspace, status: "blocked", created_at: createdAt })}\n`,
      "utf8",
    );
  }

  const resumed = spawnSync(
    process.execPath,
    [RUNNER, "resume", "--workspace", workspace, "--state-root", stateRoot, "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(resumed.status, 1);
  assert.match(resumed.stderr, /multiple incomplete runs/i);
  assert.match(resumed.stderr, /--run/);
});

test("run lookup rejects records owned by another workspace", async (t) => {
  const root = await temporaryDirectory(t);
  const stateRoot = path.join(root, "state");
  const workspaceA = path.join(root, "workspace-a");
  const workspaceB = path.join(root, "workspace-b");
  await mkdir(workspaceA, { recursive: true });
  await mkdir(workspaceB, { recursive: true });
  const forgedRunDir = path.join(workspaceBucket(stateRoot, workspaceB), "forged-run");
  await mkdir(forgedRunDir, { recursive: true });
  await writeFile(
    path.join(forgedRunDir, "run.json"),
    `${JSON.stringify({ run_id: "forged-run", workspace: workspaceA, created_at: new Date().toISOString() })}\n`,
    "utf8",
  );
  assert.deepEqual(await listRuns(stateRoot, workspaceB), []);
});

test("discoverSkills prefers project instructions over global duplicates", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const codexHome = path.join(root, "codex-home");
  await writeSkill(path.join(workspace, ".codex"), "same-skill", "project version");
  await writeSkill(codexHome, "same-skill", "global version");
  await writeSkill(codexHome, "global-only", "global only");
  const catalog = await discoverSkills(workspace, codexHome);
  assert.equal(catalog.find((skill) => skill.name === "same-skill")?.origin, "project");
  assert.equal(catalog.find((skill) => skill.name === "same-skill")?.description, "project version");
  assert.ok(catalog.some((skill) => skill.name === "global-only"));
});

test("an empty user home still discovers every bundled graph specialist", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const codexHome = path.join(root, "empty-codex-home");
  await mkdir(workspace, { recursive: true });
  const catalog = await discoverSkills(workspace, codexHome);
  assert.deepEqual(
    catalog.filter((skill) => skill.origin === "bundled").map((skill) => skill.name),
    [
      "graph-engineering-quality",
      "graph-experience-quality",
      "graph-incident-analysis",
      "graph-product-quality",
      "graph-release-assurance",
      "graph-requirements-design",
      "graph-security-privacy",
    ],
  );
  assert.equal(catalog.some((skill) => skill.name === "autonomous-engineering-graph"), false);
});

test("bundled graph specialist names cannot be shadowed by project or global skills", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const codexHome = path.join(root, "codex-home");
  await writeSkill(path.join(workspace, ".codex"), "graph-security-privacy", "untrusted project shadow");
  await writeSkill(path.join(workspace, ".codex"), "graph-release-assurance-override", "untrusted graph namespace");
  await writeSkill(codexHome, "graph-security-privacy", "trusted global specialist");
  const catalog = await discoverSkills(workspace, codexHome);
  const specialist = catalog.find((skill) => skill.name === "graph-security-privacy");
  assert.equal(specialist?.origin, "bundled");
  assert.notEqual(specialist?.description, "untrusted project shadow");
  assert.notEqual(specialist?.description, "trusted global specialist");
  assert.equal(catalog.some((skill) => skill.name === "graph-release-assurance-override"), false);
});

test("planner normalization and graph compilation preserve mandatory stages", () => {
  const catalog = [{ name: "reviewer", description: "review", path: "x", origin: "global", sha256: "a", bytes: 1 }];
  const plan = normalizePlannerResult(
    {
      task_summary: "fixture",
      mode: "task",
      scope: ["."],
      risk_level: "low",
      owner_gate: { required: false, reason: "", unblock_condition: "" },
      completion_criteria: ["done"],
      discovery_skills: ["missing"],
      review_nodes: [{ id: "behavior", title: "Behavior", focus: "behavior", skills: ["reviewer", "missing"] }],
      implementation_skills: ["reviewer"],
      verification_skills: ["reviewer"],
      excluded_surfaces: [],
    },
    catalog,
  );
  const graph = compileGraph(plan);
  assert.deepEqual(plan.discovery_skills, []);
  assert.deepEqual(plan.review_nodes[0].skills, ["reviewer"]);
  assert.deepEqual(graph.nodes.map((node) => node.id), [
    "planner-supervision",
    "discovery",
    "review-behavior",
    "synthesis",
    "synthesis-supervision",
    "implementation",
    "implementation-supervision",
  ]);
  assert.deepEqual(graph.mandatory_gates, [
    "planner-supervision",
    "synthesis-supervision",
    "implementation-supervision",
    "verification",
    "independent-review",
    "local-report",
  ]);
});

test("review_nodes remains the first wave when additional review_waves are supplied", () => {
  const catalog = [{ name: "reviewer", description: "review", path: "x", origin: "global", sha256: "a", bytes: 1 }];
  const plan = normalizePlannerResult(
    {
      task_summary: "multi-wave review",
      mode: "task",
      scope: ["."],
      risk_level: "medium",
      completion_criteria: ["done"],
      review_nodes: [{ id: "first", title: "First", focus: "first", skills: ["reviewer"] }],
      review_waves: [
        [{ id: "second", title: "Second", focus: "second", skills: ["reviewer"] }],
        [{ id: "third", title: "Third", focus: "third", skills: ["reviewer"] }],
      ],
      discovery_skills: [],
      implementation_skills: [],
      verification_skills: [],
      excluded_surfaces: [],
    },
    catalog,
  );
  assert.deepEqual(plan.review_nodes.map((review) => review.id), ["review-first"]);
  assert.deepEqual(plan.review_waves.map((wave) => wave.map((review) => review.id)), [["review-second"], ["review-third"]]);
  const graph = compileGraph(plan);
  assert.deepEqual(graph.nodes.filter((node) => node.kind === "review").map((node) => node.id), [
    "review-first",
    "review-second",
    "review-third",
  ]);
});

test("planner drops review routes that have no compatible review Skill", () => {
  const catalog = [
    { name: "graph-engineering-quality", description: "engineering", origin: "global", path: "engineering", sha256: "engineering", bytes: 1 },
    { name: "graph-release-assurance", description: "release", origin: "global", path: "release", sha256: "release", bytes: 1 },
  ];
  const plan = normalizePlannerResult(
    {
      task_summary: "Audit fixture",
      mode: "task",
      scope: ["workspace"],
      risk_level: "medium",
      completion_criteria: ["verified"],
      discovery_skills: [],
      review_nodes: [
        { id: "release", title: "Release review", focus: "release", skills: ["graph-release-assurance"] },
        { id: "engineering", title: "Engineering review", focus: "engineering", skills: ["graph-engineering-quality"] },
      ],
      implementation_skills: [],
      verification_skills: [],
      excluded_surfaces: [],
    },
    catalog,
  );
  assert.deepEqual(plan.review_nodes.map((review) => review.id), ["review-engineering"]);
  assert.deepEqual(plan.review_nodes[0].skills, ["graph-engineering-quality"]);
});

test("evidence-only corrections do not fan out implementation Skills", () => {
  const plan = { implementation_skills: ["graph-engineering-quality", "graph-product-quality"] };
  assert.deepEqual(
    correctionSkillsForResult(plan, {
      files_changed: [],
      findings: [
        { id: "RUNNER-EVIDENCE-GAP", disposition: "fixed" },
        { id: "DISC-001", disposition: "fixed" },
      ],
    }),
    [],
  );
  assert.deepEqual(
    correctionSkillsForResult(plan, {
      files_changed: ["src/example.mjs"],
      findings: [{ id: "DISC-001", disposition: "unresolved" }],
    }),
    ["graph-engineering-quality", "graph-product-quality"],
  );
});

test("dependency gates accept recorded blockers but keep unsafe state changes terminal", () => {
  assert.equal(
    dependencyGateSatisfied({
      status: "blocked",
      blockers: [{ type: "EVIDENCE_GAP", reason: "missing evidence", unblock_condition: "inspect later" }],
    }),
    true,
  );
  assert.equal(dependencyGateSatisfied({ status: "blocked", blockers: [] }), false);
  assert.equal(
    dependencyGateSatisfied({
      status: "needs_retry",
      blockers: [],
      findings: [{ id: "F-1", severity: "high", title: "recorded finding" }],
    }),
    true,
  );
  assert.equal(dependencyGateSatisfied({ status: "needs_retry", blockers: [], findings: [] }), false);
  assert.equal(
    dependencyGateSatisfied({
      status: "blocked",
      blockers: [{ type: "PROHIBITED_EXTERNAL_ACTION", reason: "push", unblock_condition: "start a new run" }],
    }),
    false,
  );
  assert.equal(
    dependencyGateSatisfied({
      status: "blocked",
      blockers: [{ type: "PROHIBITED_GIT_STATE_CHANGE", reason: "ref moved", unblock_condition: "start a new run" }],
    }),
    false,
  );
});

test("broad audit normalization fills all four mandatory review dimensions", () => {
  const names = [
    "graph-engineering-quality",
    "graph-product-quality",
    "graph-experience-quality",
    "graph-security-privacy",
  ];
  const catalog = names.map((name) => ({ name, description: name, origin: "global", path: name, sha256: name, bytes: 1 }));
  const plan = normalizePlannerResult(
    {
      task_summary: "Broad audit",
      mode: "audit",
      scope: ["workspace"],
      risk_level: "low",
      owner_gate: { required: false, reason: "", unblock_condition: "" },
      completion_criteria: ["audited"],
      discovery_skills: [],
      review_nodes: [{ id: "engineering", title: "Engineering", focus: "engineering", skills: [names[0]] }],
      implementation_skills: [],
      verification_skills: [],
      excluded_surfaces: [],
    },
    catalog,
  );
  for (const name of names) assert.ok(plan.review_nodes.some((review) => review.skills.includes(name)));
});

test("scope prose cannot override a structured planner no-gate decision", () => {
  const plan = normalizePlannerResult(
    {
      task_summary: "Change login behavior",
      mode: "task",
      scope: ["auth"],
      risk_level: "low",
      owner_gate: { required: false, reason: "", unblock_condition: "" },
      completion_criteria: ["done"],
      discovery_skills: [],
      review_nodes: [],
      implementation_skills: [],
      verification_skills: [],
      excluded_surfaces: [],
    },
    [],
    "Change authentication behavior",
  );
  assert.equal(plan.owner_gate.required, false);
  assert.equal(plan.owner_gate.authorization_scope, null);
});

test("Chinese protected actions no longer create a planner owner gate and stay non-blocking", () => {
  const plan = normalizePlannerResult(
    {
      task_summary: "修改生产环境",
      mode: "task",
      scope: ["生产数据库"],
      risk_level: "low",
      owner_gate: {
        required: true,
        reason: "删除生产数据库并发布。",
        unblock_condition: "批准这一项生产数据删除操作。",
      },
      completion_criteria: ["完成修改"],
      required_checks: [],
      discovery_skills: [],
      review_nodes: [],
      implementation_skills: [],
      verification_skills: [],
      excluded_surfaces: [],
    },
    [],
    "删除生产数据库并发布",
  );
  // P2: the planner cannot open a current blocking gate. The declared
  // protected surface is preserved as a non-blocking finding path so the
  // synthesis evidence round can decide whether a gate is truly required.
  assert.equal(plan.owner_gate.required, false);
  assert.equal(plan.owner_gate.authorization_scope, null);
  assert.deepEqual(plan.required_checks.map((check) => check.id), ["runner-missing-required-check"]);
  const reverseOrder = normalizePlannerResult(
    {
      task_summary: "轮换 API 密钥",
      mode: "task",
      scope: ["服务配置"],
      risk_level: "low",
      owner_gate: {
        required: true,
        reason: "轮换 API 密钥。",
        unblock_condition: "批准这一项密钥轮换。",
      },
      completion_criteria: ["完成轮换"],
      required_checks: [],
      discovery_skills: [],
      review_nodes: [],
      implementation_skills: [],
      verification_skills: [],
      excluded_surfaces: [],
    },
    [],
    "轮换 API 密钥",
  );
  assert.equal(reverseOrder.owner_gate.required, false);
});

test("planner catalog always retains installed graph specialists", () => {
  const specialists = [
    "graph-engineering-quality",
    "graph-product-quality",
    "graph-experience-quality",
    "graph-requirements-design",
    "graph-security-privacy",
    "graph-incident-analysis",
    "graph-release-assurance",
  ].map((name) => ({ name, description: "lifecycle specialist", origin: "global", path: name, sha256: name, bytes: 1 }));
  const ordinary = Array.from({ length: 100 }, (_, index) => ({
    name: `project-skill-${index}`,
    description: "review test verify security debug exploration impact UI data release harness",
    origin: "project",
    path: String(index),
    sha256: String(index),
    bytes: 1,
  }));
  const selected = catalogForPlanner("targeted engineering task", [...ordinary, ...specialists], 10);
  for (const specialist of specialists) assert.ok(selected.some((skill) => skill.name === specialist.name));
});

test("workspace manifests identify additions, edits, and removals", async (t) => {
  const workspace = await temporaryDirectory(t);
  await writeFile(path.join(workspace, "kept.txt"), "before", "utf8");
  await writeFile(path.join(workspace, "removed.txt"), "remove", "utf8");
  const before = await captureWorkspaceManifest(workspace);
  await writeFile(path.join(workspace, "kept.txt"), "after", "utf8");
  await writeFile(path.join(workspace, "added.txt"), "add", "utf8");
  await rm(path.join(workspace, "removed.txt"));
  const after = await captureWorkspaceManifest(workspace);
  assert.deepEqual(diffManifests(before, after), ["added.txt", "kept.txt", "removed.txt"]);
});

test("copy isolation refuses a source snapshot that changed before materialization", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const runDir = path.join(root, "run");
  const executionRoot = path.join(root, "isolated");
  await mkdir(workspace, { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "launch state\n", "utf8");
  const manifest = await captureWorkspaceManifest(workspace);
  await writeFile(path.join(workspace, "fixture.txt"), "changed during copy\n", "utf8");
  await assert.rejects(
    createFrozenWorkspace(workspace, runDir, "copy", manifest, { executionRoot }),
    /WORKSPACE_SNAPSHOT_DRIFT|launch snapshot|changed after the launch manifest/i,
  );
});

test("Git gitlinks are recorded and isolated startup refuses unsupported submodules", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const runDir = path.join(root, "run");
  const executionRoot = path.join(root, "isolated");
  await mkdir(workspace, { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  for (const args of [
    ["init"],
    ["add", "fixture.txt"],
    ["-c", "user.name=Graph Test", "-c", "user.email=graph@example.invalid", "commit", "-m", "fixture"],
  ]) {
    const git = spawnSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true });
    assert.equal(git.status, 0, git.stderr || git.stdout);
  }
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8", windowsHide: true }).stdout.trim();
  const indexed = spawnSync("git", ["update-index", "--add", "--cacheinfo", `160000,${head},vendor/sub`], {
    cwd: workspace,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(indexed.status, 0, indexed.stderr || indexed.stdout);
  const manifest = await captureWorkspaceManifest(workspace);
  assert.equal(manifest.files["vendor/sub"].kind, "gitlink");
  assert.equal(manifest.files["vendor/sub"].mode, 0o160000);
  await assert.rejects(
    createFrozenWorkspace(workspace, runDir, "copy", manifest, { executionRoot }),
    /WORKSPACE_GITLINK_UNSUPPORTED|submodule|gitlink/i,
  );
});

test("unverified terminal state is not application- or release-ready", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const runDir = path.join(root, "run");
  await mkdir(workspace, { recursive: true });
  await mkdir(runDir, { recursive: true });
  await mkdir(path.join(runDir, "recovery"), { recursive: true });
  await writeFile(path.join(runDir, "recovery", "restore.mjs"), "// fixture restore\n", "utf8");
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await atomicWriteJson(path.join(runDir, "workspace-before.json"), await captureWorkspaceManifest(workspace));
  const run = {
    run_id: "unverified-terminal-fixture",
    goal: "report an honest terminal state",
    workspace,
    execution_workspace: workspace,
    status: "blocked",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    nodes: {},
    node_order: [],
    plan: null,
    options: {},
    authorizations: [],
    blocker: { type: "PLANNER_PROCESS_FAILURE", reason: "planner failed", unblock_condition: "retry" },
    report: null,
  };
  await generateReport(runDir, run, { nodes: [] });
  const completion = JSON.parse(await readFile(path.join(runDir, "completion.json"), "utf8"));
  assert.equal(completion.application_ready, false);
  assert.equal(completion.release_ready, false);
  assert.equal(completion.release_readiness.ready, false);
});

test("reports and blocks workspace drift that no Graph writer observed", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const runDir = path.join(root, "run");
  await mkdir(workspace, { recursive: true });
  await mkdir(runDir, { recursive: true });
  await mkdir(path.join(runDir, "recovery"), { recursive: true });
  await writeFile(path.join(runDir, "recovery", "restore.mjs"), "// fixture restore\n", "utf8");
  await writeFile(path.join(workspace, "fixture.txt"), "before\n", "utf8");
  const before = await captureWorkspaceManifest(workspace);
  await atomicWriteJson(path.join(runDir, "workspace-before.json"), before);
  await writeFile(path.join(workspace, "external.txt"), "changed outside Graph\n", "utf8");
  const run = {
    run_id: "drift-fixture",
    goal: "detect drift",
    workspace,
    status: "completed",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    nodes: {},
    node_order: [],
    plan: null,
    options: {},
    authorizations: [],
    blocker: null,
    report: null,
  };
  const reportPath = await generateReport(runDir, run, { nodes: [] });
  assert.equal(run.status, "blocked");
  assert.equal(run.blocker.type, "UNATTRIBUTED_WORKSPACE_DRIFT");
  const report = await readFile(reportPath, "utf8");
  assert.match(report, /Unattributed Workspace Drift/);
  assert.match(report, /external\.txt/);
  assert.match(report, /Recovery Suppressed/);
  assert.throws(() => assertRunCanResume(run), /workspace drift was not attributable/i);
});

test("reports same-path edits that happened after a Graph writer", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const runDir = path.join(root, "run");
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(runDir, "recovery"), { recursive: true });
  await writeFile(path.join(runDir, "recovery", "restore.mjs"), "// fixture restore\n", "utf8");
  await writeFile(path.join(workspace, "fixture.txt"), "before\n", "utf8");
  const before = await captureWorkspaceManifest(workspace);
  await atomicWriteJson(path.join(runDir, "workspace-before.json"), before);

  await writeFile(path.join(workspace, "fixture.txt"), "written by Graph\n", "utf8");
  const nodeAfter = await captureWorkspaceManifest(workspace);
  const nodeDir = path.join(runDir, "nodes", "implementation");
  await mkdir(nodeDir, { recursive: true });
  await atomicWriteJson(path.join(nodeDir, "workspace-after.json"), nodeAfter);
  await atomicWriteJson(path.join(nodeDir, "proof.json"), { observed_files_changed: ["fixture.txt"], commands: [], tool_calls: [] });
  await atomicWriteJson(path.join(nodeDir, "result.json"), {
    status: "completed",
    gate: "not_applicable",
    summary: "fixture writer",
    skills_applied: [],
    evidence: [],
    findings: [],
    commands: [],
    checks: [],
    files_changed: ["fixture.txt"],
    blockers: [],
    next_actions: [],
  });

  await writeFile(path.join(workspace, "fixture.txt"), "changed by another process\n", "utf8");
  const run = {
    run_id: "same-path-drift-fixture",
    goal: "detect same-path drift",
    workspace,
    status: "completed",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    nodes: { implementation: { id: "implementation", kind: "implementation", status: "completed", gate: "not_applicable" } },
    node_order: ["implementation"],
    plan: null,
    options: {},
    authorizations: [],
    blocker: null,
    report: null,
  };
  const reportPath = await generateReport(runDir, run, { nodes: [] });
  assert.equal(run.status, "blocked");
  assert.equal(run.blocker.type, "UNATTRIBUTED_WORKSPACE_DRIFT");
  const report = await readFile(reportPath, "utf8");
  assert.match(report, /fixture\.txt/);
  assert.match(report, /final hashes no longer match/);
  assert.match(report, /Recovery Suppressed/);
});

test("never attributes verification-node file changes to Graph writers", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const runDir = path.join(root, "run");
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(runDir, "recovery"), { recursive: true });
  await writeFile(path.join(runDir, "recovery", "restore.mjs"), "// fixture restore\n", "utf8");
  await writeFile(path.join(workspace, "fixture.txt"), "before\n", "utf8");
  await atomicWriteJson(path.join(runDir, "workspace-before.json"), await captureWorkspaceManifest(workspace));
  await writeFile(path.join(workspace, "fixture.txt"), "changed during verification\n", "utf8");
  const nodeDir = path.join(runDir, "nodes", "verification-r0");
  await mkdir(nodeDir, { recursive: true });
  await atomicWriteJson(path.join(nodeDir, "workspace-after.json"), await captureWorkspaceManifest(workspace));
  await atomicWriteJson(path.join(nodeDir, "proof.json"), { observed_files_changed: ["fixture.txt"], commands: [], tool_calls: [] });
  await atomicWriteJson(path.join(nodeDir, "result.json"), {
    status: "completed",
    gate: "pass",
    summary: "fixture verification",
    skills_applied: [],
    evidence: [],
    findings: [],
    commands: [],
    checks: [],
    files_changed: ["fixture.txt"],
    blockers: [],
    next_actions: [],
  });
  const run = {
    run_id: "verification-drift-fixture",
    goal: "detect verification drift",
    workspace,
    status: "completed",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    nodes: { "verification-r0": { id: "verification-r0", kind: "verification", status: "completed", gate: "pass" } },
    node_order: ["verification-r0"],
    plan: null,
    options: {},
    authorizations: [],
    blocker: null,
    report: null,
  };
  const reportPath = await generateReport(runDir, run, { nodes: [] });
  assert.equal(run.status, "blocked");
  assert.equal(run.attributed_files_changed.length, 0);
  assert.match(await readFile(reportPath, "utf8"), /Unattributed Workspace Drift/);
});

test("runner-owned audit artifacts do not create workspace drift at report time", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const runDir = path.join(root, "run");
  await mkdir(workspace, { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(workspace, "report.md"), "before\n", "utf8");
  await writeFile(path.join(workspace, "completion.json"), "{}\n", "utf8");
  await writeFile(path.join(workspace, "finding-lineage.json"), "{}\n", "utf8");
  await atomicWriteJson(path.join(runDir, "workspace-before.json"), await captureWorkspaceManifest(workspace));
  await writeFile(path.join(workspace, "report.md"), "after\n", "utf8");
  await writeFile(path.join(workspace, "completion.json"), "{\"status\":\"completed\"}\n", "utf8");
  await writeFile(path.join(workspace, "finding-lineage.json"), "{\"findings\":[]}\n", "utf8");
  const after = await captureWorkspaceManifest(workspace);
  const nodeDir = path.join(runDir, "nodes", "verification-r0");
  await mkdir(nodeDir, { recursive: true });
  await atomicWriteJson(path.join(nodeDir, "workspace-after.json"), after);
  await atomicWriteJson(path.join(nodeDir, "proof.json"), {
    observed_files_changed: ["completion.json", "finding-lineage.json", "report.md"],
    commands: [],
    tool_calls: [],
  });
  await atomicWriteJson(path.join(nodeDir, "result.json"), {
    status: "completed",
    gate: "pass",
    summary: "audit artifacts written",
    skills_applied: [],
    evidence: [],
    findings: [],
    commands: [],
    checks: [],
    files_changed: [],
    blockers: [],
    next_actions: [],
  });
  const run = {
    run_id: "audit-artifact-drift-fixture",
    goal: "write runner-owned audit artifacts",
    workspace,
    execution_workspace: workspace,
    status: "completed",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    nodes: { "verification-r0": { id: "verification-r0", kind: "verification", status: "completed", gate: "pass" } },
    node_order: ["verification-r0"],
    plan: null,
    options: {},
    authorizations: [],
    blocker: null,
    report: null,
  };
  const reportPath = await generateReport(runDir, run, { nodes: [] });
  assert.equal(run.status, "completed_with_gaps");
  assert.deepEqual(run.files_changed, []);
  assert.deepEqual(run.attributed_files_changed, []);
  assert.match(await readFile(reportPath, "utf8"), /## Unattributed Workspace Drift\r?\n\r?\n- None\./);
});

test("configuredGitAliases reads repository and user Git aliases", async (t) => {
  const workspace = await temporaryDirectory(t);
  const initialized = spawnSync("git", ["init", workspace], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  const configured = spawnSync("git", ["-C", workspace, "config", "alias.publish", "push"], { encoding: "utf8" });
  assert.equal(configured.status, 0, configured.stderr);
  assert.equal(configuredGitAliases(workspace).publish, "push");
});

test("workspace manifests record links without reading linked content", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "outside.txt"), "outside fixture\n", "utf8");
  await symlink(outside, path.join(workspace, "linked-dir"), process.platform === "win32" ? "junction" : "dir");
  const manifest = await captureWorkspaceManifest(workspace);
  assert.equal(manifest.files["linked-dir"].kind, "symlink");
  assert.equal(manifest.files["linked-dir/outside.txt"], undefined);
});

test("isolated workspace rejects linked entries before they can escape the snapshot", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  const executionRoot = path.join(root, "managed");
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "secret.txt"), "outside secret\n", "utf8");
  await symlink(outside, path.join(workspace, "linked-dir"), process.platform === "win32" ? "junction" : "dir");

  const manifest = await captureWorkspaceManifest(workspace);
  await assert.rejects(
    createFrozenWorkspace(workspace, path.join(root, "run"), "copy", manifest, { executionRoot }),
    (error) => error?.code === "WORKSPACE_LINK_UNSAFE" && /linked-dir/.test(error.message),
  );
  assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), "outside secret\n");
  assert.equal(await readFile(path.join(executionRoot, "workspace", "linked-dir", "secret.txt"), "utf8").catch(() => null), null);
});

test("managed execution roots reject linked path components before snapshot creation", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const linkedExecutionRoot = path.join(root, "linked-execution-root");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "source fixture\n", "utf8");
  await symlink(workspace, linkedExecutionRoot, process.platform === "win32" ? "junction" : "dir");

  const manifest = await captureWorkspaceManifest(workspace);
  await assert.rejects(
    createFrozenWorkspace(workspace, path.join(root, "run"), "copy", manifest, { executionRoot: linkedExecutionRoot }),
    (error) => error?.code === "WORKSPACE_ROOT_UNSAFE" && /linked-execution-root/.test(error.message),
  );
  assert.equal(await readFile(path.join(workspace, "fixture.txt"), "utf8"), "source fixture\n");
  assert.deepEqual((await readdir(workspace)).sort(), ["fixture.txt"]);
});

test("managed workspace cleanup refuses a replaced junction target", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const managedRoot = path.join(root, "managed");
  const outside = path.join(root, "outside");
  const executionWorkspace = path.join(managedRoot, "run-key");
  await mkdir(workspace, { recursive: true });
  await mkdir(managedRoot, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "keep.txt"), "outside fixture\n", "utf8");
  await symlink(outside, executionWorkspace, process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    removeFrozenWorkspace({
      sourceWorkspace: workspace,
      executionWorkspace,
      mode: "copy",
      managedRoot,
      managedKey: "run-key",
    }),
    (error) => error?.code === "WORKSPACE_ROOT_UNSAFE" && /run-key/.test(error.message),
  );
  assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "outside fixture\n");
});

test("proofFromEvents extracts commands, tools, errors, and invalid input", () => {
  const raw = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "npm test", exit_code: 0, status: "completed", aggregated_output: "ok" } }),
    JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "code", tool: "impact", status: "completed" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Found a durable intermediate fact." } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 40, output_tokens: 30 } }),
    JSON.stringify({ type: "error", message: "sample" }),
    "not-json",
  ].join("\n");
  const proof = proofFromEvents(raw);
  assert.equal(proof.thread_id, "thread-1");
  assert.equal(proof.commands[0].command, "npm test");
  assert.equal(proof.commands[0].exit_code, 0);
  assert.equal(proof.tool_calls.length, 2);
  assert.equal(proof.errors[0], "sample");
  assert.equal(proof.usage.input_tokens, 120);
  assert.equal(proof.usage.cached_input_tokens, 40);
  assert.equal(proof.usage.output_tokens, 30);
  assert.deepEqual(proof.messages, ["Found a durable intermediate fact."]);
  assert.equal(proof.invalid_event_lines, 1);
});

test("default planner catalog remains bounded while retaining project and graph skills", () => {
  const specialists = [
    "graph-engineering-quality",
    "graph-product-quality",
    "graph-experience-quality",
    "graph-requirements-design",
    "graph-security-privacy",
    "graph-incident-analysis",
    "graph-release-assurance",
  ].map((name) => ({ name, description: "lifecycle specialist", origin: "global", path: name, sha256: name, bytes: 1 }));
  const projects = Array.from({ length: 12 }, (_, index) => ({
    name: `project-skill-${index}`,
    description: "project-specific review",
    origin: "project",
    path: String(index),
    sha256: String(index),
    bytes: 1,
  }));
  const ordinary = Array.from({ length: 100 }, (_, index) => ({
    name: `ordinary-skill-${index}`,
    description: "ordinary optional helper",
    origin: "global",
    path: String(index),
    sha256: String(index),
    bytes: 1,
  }));
  const selected = catalogForPlanner("audit the project", [...ordinary, ...projects, ...specialists]);
  assert.ok(selected.length <= 32, `planner received ${selected.length} skills`);
  for (const skill of specialists) assert.ok(selected.some((item) => item.name === skill.name));
  for (const skill of projects) assert.ok(selected.some((item) => item.name === skill.name));
});

test("redaction preserves split UTF-8 and removes streamed secrets", async () => {
  const transform = new RedactingLineTransform();
  let output = "";
  transform.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  const source = Buffer.from('中文 api_key: secretvalue\n-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----\n', "utf8");
  transform.write(source.subarray(0, 2));
  transform.write(source.subarray(2, 7));
  transform.end(source.subarray(7));
  await finished(transform);
  assert.match(output, /中文/);
  assert.doesNotMatch(output, /secretvalue|private-material|BEGIN PRIVATE KEY/);
  assert.match(output, /REDACTED/);
});

test("redaction removes credentials embedded in routing URLs", async () => {
  const transform = new RedactingLineTransform();
  let output = "";
  transform.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  transform.end("endpoint=https://routing-user:routing-pass@gateway.example.invalid/v1?token=query-secret&mode=test\n");
  await finished(transform);
  assert.match(output, /gateway\.example\.invalid/);
  assert.match(output, /mode=test/);
  assert.doesNotMatch(output, /routing-user|routing-pass|query-secret/);
  assert.match(output, /REDACTED_URL_CREDENTIAL/);
});

test("redaction preserves ordinary authorization prose and private-key search commands", async () => {
  const transform = new RedactingLineTransform();
  let output = "";
  transform.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  transform.end([
    "An authorization applies only to its written scope.\n",
    'rg -n "BEGIN PRIVATE KEY|api_key" .\n',
    "authorization: actual-secret-value\n",
    "final event remains visible\n",
  ].join(""));
  await finished(transform);
  assert.match(output, /authorization applies only to its written scope/i);
  assert.match(output, /rg -n "BEGIN PRIVATE KEY\|api_key"/);
  assert.doesNotMatch(output, /actual-secret-value/);
  assert.match(output, /final event remains visible/);
});

test("child environment excludes ambient secret variables", () => {
  const previous = process.env.GRAPH_TEST_SECRET_TOKEN;
  const previousGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  const previousExecutionRoot = process.env.AEG_EXECUTION_ROOT;
  process.env.GRAPH_TEST_SECRET_TOKEN = "must-not-cross-boundary";
  process.env.GIT_CONFIG_GLOBAL = path.join(os.tmpdir(), "graph-test-global.gitconfig");
  process.env.AEG_EXECUTION_ROOT = path.join(os.tmpdir(), "graph-test-execution-root");
  try {
    const environment = childEnvironment();
    assert.equal(environment.GRAPH_TEST_SECRET_TOKEN, undefined);
    assert.equal(environment.AUTONOMOUS_GRAPH_NODE, "1");
    assert.notEqual(environment.GIT_CONFIG_GLOBAL, process.env.GIT_CONFIG_GLOBAL);
    assert.equal(environment.GIT_CONFIG_GLOBAL, process.platform === "win32" ? "NUL" : "/dev/null");
    assert.equal(environment.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(environment.AEG_EXECUTION_ROOT, process.env.AEG_EXECUTION_ROOT);
    assert.ok(environment.PATH || environment.Path);
  } finally {
    if (previous === undefined) delete process.env.GRAPH_TEST_SECRET_TOKEN;
    else process.env.GRAPH_TEST_SECRET_TOKEN = previous;
    if (previousGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGitConfigGlobal;
    if (previousExecutionRoot === undefined) delete process.env.AEG_EXECUTION_ROOT;
    else process.env.AEG_EXECUTION_ROOT = previousExecutionRoot;
  }
});

test("runtime control root is stable and does not follow a mutable runtime override", () => {
  const expected = path.resolve(os.homedir(), ".graph-engineering", "runtime-control");
  assert.equal(
    runtimeControlRoot({ environment: { AEG_RUNTIME_CONTROL_ROOT: path.join(os.tmpdir(), "wrong-root") } }),
    expected,
  );
});

test("child environment projects provider credentials only through explicit named opt-in", () => {
  const sourceEnvironment = {
    PATH: process.env.PATH || "fixture-path",
    ANTHROPIC_BASE_URL: "https://gateway.example.invalid",
    ANTHROPIC_API_KEY: "anthropic-fixture-secret",
    OPENAI_API_KEY: "openai-fixture-secret",
    GRAPH_TEST_SECRET_TOKEN: "ambient-fixture-secret",
    AEG_CHILD_ENV_KEYS: "ANTHROPIC_API_KEY, OPENAI_API_KEY",
  };
  const environment = childEnvironment({ sourceEnvironment });
  assert.equal(environment.ANTHROPIC_BASE_URL, sourceEnvironment.ANTHROPIC_BASE_URL);
  assert.equal(environment.ANTHROPIC_API_KEY, sourceEnvironment.ANTHROPIC_API_KEY);
  assert.equal(environment.OPENAI_API_KEY, sourceEnvironment.OPENAI_API_KEY);
  assert.equal(environment.GRAPH_TEST_SECRET_TOKEN, undefined);
  assert.throws(
    () => childEnvironment({
      sourceEnvironment: { ...sourceEnvironment, AEG_CHILD_ENV_KEYS: "ANTHROPIC_API_KEY,NODE_OPTIONS" },
    }),
    /cannot project execution-control variable: NODE_OPTIONS/,
  );
  assert.throws(
    () => childEnvironment({
      sourceEnvironment: {
        PATH: sourceEnvironment.PATH,
        ANTHROPIC_BASE_URL: "https://routing-user:routing-pass@gateway.example.invalid/v1",
      },
    }),
    /ANTHROPIC_BASE_URL contains embedded credentials.*AEG_CHILD_ENV_KEYS/,
  );
  assert.throws(
    () => childEnvironment({
      sourceEnvironment: {
        PATH: sourceEnvironment.PATH,
        OPENAI_BASE_URL: "https://gateway.example.invalid/v1?access_token=query-secret",
      },
    }),
    /OPENAI_BASE_URL contains embedded credentials.*AEG_CHILD_ENV_KEYS/,
  );
  for (const queryKey of ["client_secret", "key", "private_token", "jwt", "routing_hint"]) {
    assert.throws(
      () => childEnvironment({
        sourceEnvironment: {
          PATH: sourceEnvironment.PATH,
          OPENAI_BASE_URL: `https://gateway.example.invalid/v1?${queryKey}=review-secret`,
        },
      }),
      /OPENAI_BASE_URL contains embedded credentials.*AEG_CHILD_ENV_KEYS/,
    );
  }
  const explicitEndpoint = childEnvironment({
    sourceEnvironment: {
      PATH: sourceEnvironment.PATH,
      ANTHROPIC_BASE_URL: "https://routing-user:routing-pass@gateway.example.invalid/v1",
      AEG_CHILD_ENV_KEYS: "ANTHROPIC_BASE_URL",
    },
  });
  assert.equal(explicitEndpoint.ANTHROPIC_BASE_URL, "https://routing-user:routing-pass@gateway.example.invalid/v1");
});

test("child environment projects only safe.directory Git config entries", () => {
  const environment = safeGitConfigEnvironment({
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "!leak-me",
    GIT_CONFIG_KEY_1: "safe.directory",
    GIT_CONFIG_VALUE_1: "C:\\work\\fixture",
    GIT_CONFIG_KEY_2: "core.hooksPath",
    GIT_CONFIG_VALUE_2: "C:\\hooks",
    GIT_CONFIG_KEY_3: "SAFE.DIRECTORY",
    GIT_CONFIG_VALUE_3: "D:\\other\\fixture",
  });
  assert.deepEqual(environment, {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "C:\\work\\fixture",
    GIT_CONFIG_KEY_1: "safe.directory",
    GIT_CONFIG_VALUE_1: "D:\\other\\fixture",
  });
});

test("isolated child environment overrides the user Codex home", () => {
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = "C:\\Users\\fixture\\.codex";
  try {
    const isolated = childEnvironment({ codexHome: "C:\\Temp\\graph-attempt\\codex-home" });
    assert.equal(isolated.CODEX_HOME, "C:\\Temp\\graph-attempt\\codex-home");
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test("child environment uses a safe Git config projection for workspace snapshots", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const gitConfigGlobal = path.join(root, "global.gitconfig");
  await mkdir(workspace, { recursive: true });
  await writeFile(
    gitConfigGlobal,
    "[alias]\n  graph-secret = status\n[credential]\n  helper = !echo LEAKED_HELPER\n",
    "utf8",
  );
  const previousGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  const previousGitConfigCount = process.env.GIT_CONFIG_COUNT;
  const previousGitConfigKey = process.env.GIT_CONFIG_KEY_0;
  const previousGitConfigValue = process.env.GIT_CONFIG_VALUE_0;
  process.env.GIT_CONFIG_GLOBAL = gitConfigGlobal;
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "safe.directory";
  process.env.GIT_CONFIG_VALUE_0 = workspace;
  try {
    const initialized = spawnSync("git", ["init", workspace], {
      encoding: "utf8",
      env: process.env,
    });
    assert.equal(initialized.status, 0, initialized.stderr);
    const parentManifest = await captureWorkspaceManifest(workspace);
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { captureWorkspaceManifest } from ${JSON.stringify(pathToFileURL(RUNNER).href)}; console.log(JSON.stringify(await captureWorkspaceManifest(process.argv[1])));`,
        workspace,
      ],
      { encoding: "utf8", env: childEnvironment() },
    );
    assert.equal(probe.status, 0, probe.stderr);
    const childManifest = JSON.parse(probe.stdout.trim());
    assert.equal(childManifest.head, parentManifest.head);
    assert.equal(childManifest.refs_sha256, parentManifest.refs_sha256);
    assert.equal(childManifest.git_config_sha256, parentManifest.git_config_sha256);
    const configProbe = spawnSync(
      "git",
      ["-C", workspace, "config", "--get-regexp", "^(alias\\.graph-secret|credential\\.helper)$"],
      { encoding: "utf8", env: childEnvironment() },
    );
    assert.notEqual(configProbe.status, 0);
    assert.equal(configProbe.stdout.trim(), "");
    const credentialProbe = spawnSync(
      "git",
      ["-C", workspace, "credential", "fill"],
      {
        encoding: "utf8",
        env: { ...childEnvironment(), GIT_TERMINAL_PROMPT: "0" },
        input: "protocol=https\nhost=example.invalid\n\n",
      },
    );
    assert.doesNotMatch(`${credentialProbe.stdout}\n${credentialProbe.stderr}`, /LEAKED_HELPER/);
    const safeProbe = spawnSync(
      "git",
      ["-C", workspace, "config", "--get-all", "safe.directory"],
      { encoding: "utf8", env: childEnvironment() },
    );
    assert.equal(safeProbe.status, 0, safeProbe.stderr);
    assert.match(safeProbe.stdout, /workspace/i);
  } finally {
    if (previousGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGitConfigGlobal;
    if (previousGitConfigCount === undefined) delete process.env.GIT_CONFIG_COUNT;
    else process.env.GIT_CONFIG_COUNT = previousGitConfigCount;
    if (previousGitConfigKey === undefined) delete process.env.GIT_CONFIG_KEY_0;
    else process.env.GIT_CONFIG_KEY_0 = previousGitConfigKey;
    if (previousGitConfigValue === undefined) delete process.env.GIT_CONFIG_VALUE_0;
    else process.env.GIT_CONFIG_VALUE_0 = previousGitConfigValue;
  }
});

test("Git snapshot inspection fails closed when the index command fails", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "tracked.txt"), "tracked\n", "utf8");
  for (const args of [
    ["init"],
    ["add", "tracked.txt"],
    ["-c", "user.name=Graph Test", "-c", "user.email=graph@example.invalid", "commit", "-m", "fixture"],
  ]) {
    const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  await writeFile(path.join(workspace, ".git", "index"), "corrupt index\n", "utf8");
  await assert.rejects(
    captureWorkspaceManifest(workspace),
    (error) => error?.code === "GIT_WORKSPACE_INSPECTION_FAILED" && /ls-files/.test(error.message),
  );
});

test("Git snapshot inspection rejects a dangling HEAD after repository history exists", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "tracked.txt"), "tracked\n", "utf8");
  for (const args of [
    ["init"],
    ["add", "tracked.txt"],
    ["-c", "user.name=Graph Test", "-c", "user.email=graph@example.invalid", "commit", "-m", "fixture"],
  ]) {
    const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  const branch = spawnSync("git", ["symbolic-ref", "--short", "HEAD"], {
    cwd: workspace,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(branch.status, 0, branch.stderr || branch.stdout);
  await writeFile(path.join(workspace, ".git", "HEAD"), "ref: refs/heads/missing\n", "utf8");
  await assert.rejects(
    captureWorkspaceManifest(workspace),
    (error) => error?.code === "GIT_WORKSPACE_INSPECTION_FAILED" && /rev-parse HEAD/.test(error.message),
  );
  const branchPath = branch.stdout.trim().split("/");
  await rm(path.join(workspace, ".git", "refs", "heads", ...branchPath), { force: true });
  await rm(path.join(workspace, ".git", "logs", "HEAD"), { force: true });
  await rm(path.join(workspace, ".git", "logs", "refs", "heads", ...branchPath), { force: true });
  await assert.rejects(
    captureWorkspaceManifest(workspace),
    (error) => error?.code === "GIT_WORKSPACE_INSPECTION_FAILED" && /rev-parse HEAD/.test(error.message),
  );
});

test("internal Git ignores ambient repository and index redirects", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const otherWorkspace = path.join(root, "other-repository");
  const runDir = path.join(root, "state", "run");
  const executionRoot = path.join(root, "isolated");
  const outsideIndex = path.join(root, "outside-index");
  await mkdir(workspace, { recursive: true });
  await mkdir(otherWorkspace, { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "workspace fixture\n", "utf8");
  await writeFile(path.join(otherWorkspace, "evil.txt"), "wrong repository\n", "utf8");
  for (const [directory, files] of [
    [workspace, ["fixture.txt"]],
    [otherWorkspace, ["evil.txt"]],
  ]) {
    for (const args of [
      ["init"],
      ["add", ...files],
      ["-c", "user.name=Graph Test", "-c", "user.email=graph@example.invalid", "commit", "-m", "fixture"],
    ]) {
      const git = spawnSync("git", args, { cwd: directory, encoding: "utf8", windowsHide: true });
      assert.equal(git.status, 0, git.stderr || git.stdout);
    }
  }
  const expectedHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).stdout.trim();
  const previous = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
  };
  process.env.GIT_DIR = path.join(otherWorkspace, ".git");
  process.env.GIT_WORK_TREE = otherWorkspace;
  process.env.GIT_INDEX_FILE = outsideIndex;
  let isolation = null;
  try {
    const manifest = await captureWorkspaceManifest(workspace);
    assert.equal(manifest.head, expectedHead);
    assert.ok(manifest.files["fixture.txt"]);
    assert.equal(manifest.files["evil.txt"], undefined);
    isolation = await createFrozenWorkspace(workspace, runDir, "worktree", manifest, { executionRoot });
    assert.equal(await readFile(outsideIndex, "utf8").catch(() => null), null);
    assert.equal(
      await readFile(path.join(isolation.execution_workspace, "fixture.txt"), "utf8"),
      "workspace fixture\n",
    );
  } finally {
    if (isolation) {
      await removeFrozenWorkspace({
        sourceWorkspace: workspace,
        executionWorkspace: isolation.execution_workspace,
        mode: isolation.mode,
        managedRoot: isolation.managed_root,
        managedKey: isolation.managed_key,
      });
    }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Codex resolution ignores workspace-local command shims", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const hostBin = path.join(root, "host-bin");
  await mkdir(workspace, { recursive: true });
  await mkdir(hostBin, { recursive: true });
  for (const name of ["codex", "codex.cmd", "codex.exe", "codex.ps1"]) {
    await writeFile(path.join(workspace, name), "workspace-local shim\n", "utf8");
    await writeFile(path.join(hostBin, name), "host Codex fixture\n", "utf8");
  }
  const configuredPath = [workspace, hostBin].join(path.delimiter);
  const invocation = resolveCodexInvocation(workspace, {
    environment: { PATH: configuredPath, Path: configuredPath },
    probe: (_candidate, args) => args.includes("--version")
      ? { status: 0, stdout: "codex-cli 0.147.0", stderr: "" }
      : { status: 0, stdout: "", stderr: "" },
  });
  const candidates = [invocation.command, ...invocation.prefix].filter((value) => path.isAbsolute(value));
  assert.ok(candidates.length > 0);
  for (const candidate of candidates) {
    const relation = path.relative(workspace, candidate);
    assert.ok(relation.startsWith("..") || path.isAbsolute(relation));
  }
});

test(
  "Windows Codex resolution uses an absolute executable and never a workspace shim",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await temporaryDirectory(t);
    const workspace = path.join(root, "workspace");
    const bin = path.join(root, "bin");
    await mkdir(workspace, { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "codex.ps1"), "Write-Output fixture\n", "utf8");
    const previousPath = process.env.PATH;
    const previousCommand = process.env.AEG_CODEX_COMMAND_JSON;
    process.env.PATH = bin;
    delete process.env.AEG_CODEX_COMMAND_JSON;
    try {
      const invocation = resolveCodexInvocation(workspace);
      assert.equal(path.isAbsolute(invocation.command), true);
      assert.equal(path.isAbsolute(invocation.command), true);
      const resolved = [invocation.command, ...invocation.prefix]
        .filter((value) => path.isAbsolute(value))
        .map((value) => path.normalize(value).toLowerCase());
      assert.ok(resolved.every((value) => !value.startsWith(path.normalize(workspace).toLowerCase())));
    } finally {
      process.env.PATH = previousPath;
      if (previousCommand === undefined) delete process.env.AEG_CODEX_COMMAND_JSON;
      else process.env.AEG_CODEX_COMMAND_JSON = previousCommand;
    }
  },
);

test("passing gates require matching successful command evidence", () => {
  const result = ensureNodeResultConsistency(
    {
      status: "completed",
      gate: "pass",
      summary: "claimed pass",
      skills_applied: [],
      evidence: [],
      findings: [],
      commands: [{ command: "npm test", exit_code: 1, summary: "failed" }],
      files_changed: [],
      blockers: [],
      next_actions: [],
    },
    { kind: "verification" },
    { commands: [{ command: "npm test", exit_code: 1 }], tool_calls: [{ type: "command_execution" }] },
    [],
    [],
  );
  assert.equal(result.status, "needs_retry");
  assert.equal(result.gate, "fail");
  assert.ok(result.findings.some((finding) => finding.id === "RUNNER-EVIDENCE-GAP"));
});

test("a required command counts only inside a single known shell wrapper", () => {
  // A verifier may use one known shell wrapper, but the wrapper cannot contain
  // additional commands, pipelines, redirections, or shell state capture.
  const wrapper = 'powershell -Command "node --test"';
  const passing = ensureNodeResultConsistency(
    {
      status: "completed",
      gate: "pass",
      summary: "verified through a wrapper",
      skills_applied: [],
      evidence: [],
      findings: [],
      commands: [{ command: wrapper, exit_code: 0, summary: "passed" }],
      checks: [{ id: "full-test-suite", status: "pass", command: wrapper, evidence: "tests 2 / pass 2 / fail 0" }],
      files_changed: [],
      blockers: [],
      next_actions: [],
    },
    { kind: "verification" },
    { commands: [{ command: wrapper, exit_code: 0 }], tool_calls: [{ type: "command_execution", status: "completed" }] },
    [],
    [],
    [{ id: "full-test-suite", description: "Run the test suite", command: "node --test", source: "planner" }],
  );
  assert.equal(passing.status, "completed");
  assert.equal(passing.gate, "pass");
  assert.equal(passing.findings.some((finding) => String(finding.id).startsWith("RUNNER-")), false);

  const unsafeWrapper = 'powershell -Command "node --test; Write-Output done"';
  const rejected = ensureNodeResultConsistency(
    {
      status: "completed",
      gate: "pass",
      summary: "claimed pass through a compound wrapper",
      skills_applied: [],
      evidence: [],
      findings: [],
      commands: [{ command: unsafeWrapper, exit_code: 0, summary: "passed" }],
      checks: [{ id: "full-test-suite", status: "pass", command: unsafeWrapper, evidence: "tests passed" }],
      files_changed: [],
      blockers: [],
      next_actions: [],
    },
    { kind: "verification" },
    { commands: [{ command: unsafeWrapper, exit_code: 0 }], tool_calls: [{ type: "command_execution", status: "completed" }] },
    [],
    [],
    [{ id: "full-test-suite", description: "Run the test suite", command: "node --test", source: "planner" }],
  );
  assert.equal(rejected.status, "needs_retry");
  assert.equal(rejected.gate, "fail");
  assert.ok(rejected.findings.some((finding) => finding.id === "RUNNER-REQUIRED-CHECK-full-test-suite"));

  // An unrelated successful command must still not vouch for the check.
  const unrelated = ensureNodeResultConsistency(
    {
      status: "completed",
      gate: "pass",
      summary: "claimed pass from an unrelated command",
      skills_applied: [],
      evidence: [],
      findings: [],
      commands: [{ command: "git status", exit_code: 0, summary: "clean" }],
      checks: [{ id: "full-test-suite", status: "pass", command: "git status", evidence: "looks fine" }],
      files_changed: [],
      blockers: [],
      next_actions: [],
    },
    { kind: "verification" },
    { commands: [{ command: "git status", exit_code: 0 }], tool_calls: [{ type: "command_execution", status: "completed" }] },
    [],
    [],
    [{ id: "full-test-suite", description: "Run the test suite", command: "node --test", source: "planner" }],
  );
  assert.equal(unrelated.gate, "fail");
  assert.ok(unrelated.findings.some((finding) => finding.id === "RUNNER-REQUIRED-CHECK-full-test-suite"));
});

test("review mode compiles a fully read-only graph without implementation or verification", () => {
  const catalog = [{ name: "reviewer", description: "review", path: "x", origin: "global", sha256: "a", bytes: 1 }];
  const plan = normalizePlannerResult(
    {
      task_summary: "read-only review",
      mode: "review",
      scope: ["."],
      risk_level: "medium",
      completion_criteria: ["review evidence is recorded"],
      required_checks: [{ id: "unit", description: "Run unit tests", command: "npm test" }],
      discovery_skills: [],
      review_nodes: [{ id: "behavior", title: "Behavior", focus: "behavior", skills: ["reviewer"] }],
      implementation_skills: ["reviewer"],
      verification_skills: ["reviewer"],
      excluded_surfaces: [],
    },
    catalog,
  );
  const graph = compileGraph(plan);

  assert.equal(graph.review_only, true);
  assert.deepEqual(graph.nodes.map((node) => node.id), [
    "planner-supervision",
    "discovery",
    "review-behavior",
    "synthesis",
    "synthesis-supervision",
    "independent-review",
  ]);
  assert.equal(graph.nodes.some((node) => ["implementation", "verification", "correction"].includes(node.kind)), false);
  assert.deepEqual(graph.mandatory_gates, [
    "planner-supervision",
    "synthesis-supervision",
    "independent-review",
    "local-report",
  ]);
  assert.equal(nodeSandboxMode(graph.nodes.at(-1)), "read-only");
  assert.equal(graph.nodes.at(-1).read_only, true);
  assert.equal(graph.nodes.every((node) => node.read_only !== false && node.review_only === true), true);
});

test("copy-mode Git provenance is reduced to safe source evidence", () => {
  const provenance = sourceGitProvenance({
    workspace: "/path/to/project/example",
    generated_at: "2026-08-27T00:00:00.000Z",
    git: true,
    head: "abc123",
    refs_sha256: "refs-hash",
    git_config_sha256: "config-hash",
    status: " M src/example.ts\n?? notes.md\n",
  });
  assert.deepEqual(provenance, {
    available: true,
    workspace: "/path/to/project/example",
    observed_at: "2026-08-27T00:00:00.000Z",
    head: "abc123",
    refs_sha256: "refs-hash",
    git_config_sha256: "config-hash",
    status: " M src/example.ts\n?? notes.md\n",
  });
});

test("macOS zsh command events satisfy required command evidence", () => {
  const result = ensureNodeResultConsistency(
    {
      status: "completed",
      gate: "pass",
      summary: "verified through macOS zsh",
      skills_applied: [],
      evidence: [],
      findings: [],
      commands: [{ command: "npm test", exit_code: 0, summary: "passed" }],
      checks: [{ id: "tests", status: "pass", command: "npm test", evidence: "3 tests passed" }],
      files_changed: [],
      blockers: [],
      next_actions: [],
    },
    { kind: "verification" },
    {
      commands: [{ command: "/bin/zsh -lc 'npm test'", exit_code: 0 }],
      tool_calls: [{ type: "command_execution", name: "shell", status: "completed" }],
    },
    [],
    [],
    [{ id: "tests", description: "Run the repository test suite", command: "npm test", source: "package.json" }],
  );
  assert.equal(result.status, "completed");
  assert.equal(result.gate, "pass");
  assert.equal(result.machine_check_evaluation.checks[0].status, "pass");
});

test("source Git snapshot can be the only verification evidence in copy mode", () => {
  const result = ensureNodeResultConsistency(
    {
      status: "completed",
      gate: "pass",
      summary: "verified from the source launch snapshot",
      skills_applied: [],
      evidence: [],
      findings: [],
      commands: [],
      checks: [],
      files_changed: [],
      blockers: [],
      next_actions: [],
    },
    { kind: "verification" },
    { commands: [], tool_calls: [] },
    [],
    [],
    [{
      id: "git-state",
      description: "Confirm the source repository Git state",
      command: null,
      source_evidence: "source_git_snapshot",
      blocking_scope: "both",
    }],
    { sourceGit: { available: true, observed_at: "launch" } },
  );
  assert.equal(result.status, "completed");
  assert.equal(result.gate, "pass");
  assert.equal(result.machine_check_evaluation.checks[0].observed_source, "source_git_snapshot");
  assert.equal(result.findings.some((finding) => finding.id === "RUNNER-EVIDENCE-GAP"), false);
});

test("review-only environment gaps remain deferred instead of failing the static gate", () => {
  const result = ensureNodeResultConsistency(
    {
      status: "blocked",
      gate: "blocked",
      summary: "A browser environment is not running",
      skills_applied: [],
      evidence: [],
      findings: [],
      commands: [],
      files_changed: [],
      blockers: [{
        type: "ENVIRONMENT_REQUIRED",
        reason: "Browser environment unavailable",
        unblock_condition: "Start the browser environment later",
      }],
      next_actions: [],
    },
    { kind: "independent_review", review_only: true },
    { commands: [], tool_calls: [] },
    [],
    [],
  );
  assert.equal(result.status, "completed");
  assert.equal(result.gate, "pass");
  assert.equal(result.deferred_environment_gaps.length, 1);
  assert.match(result.next_actions.join("\n"), /review-only mode/i);
});

test("exact command claims reject paraphrases while explicit equivalents remain available", () => {
  const observed = [
    { command: "git diff -- math.test.mjs", exit_code: 0 },
    { command: 'powershell -Command "node --test"', exit_code: 0 },
  ];
  const exact = ensureNodeResultConsistency(
    {
      status: "completed",
      gate: "pass",
      summary: "verified with exact evidence",
      skills_applied: [],
      evidence: [],
      findings: [],
      commands: observed,
      checks: [{ id: "suite", status: "pass", command: observed[1].command, evidence: "pass 2 / fail 0" }],
      files_changed: [],
      blockers: [],
      next_actions: [],
    },
    { kind: "verification" },
    { commands: observed, tool_calls: [{ type: "command_execution", status: "completed" }] },
    [],
    [],
    [{
      id: "suite",
      description: "Run the suite",
      command: "node --test",
      equivalent_commands: [observed[1].command],
      source: "planner",
    }],
  );
  assert.equal(exact.gate, "pass");
  assert.equal(exact.findings.some((f) => String(f.id).startsWith("RUNNER-")), false);

  // A summary line that changes the command sequence is not equivalent, even
  // when it mentions the same executable names.
  const unsafeObserved = [
    { command: 'Write-Output "=== CHECK oracle ==="; git diff -- math.test.mjs; Write-Output "END"', exit_code: 0 },
    { command: 'Write-Output "=== CHECK suite ==="; node --test; Write-Output "EXIT=$LASTEXITCODE"', exit_code: 0 },
  ];
  const paraphrased = ensureNodeResultConsistency(
    {
      status: "completed",
      gate: "pass",
      summary: "verified",
      skills_applied: [],
      evidence: [],
      findings: [],
      commands: [
        { command: "git diff -- math.test.mjs; git log --oneline -1; git status --porcelain", exit_code: 0 },
        { command: 'node --test; Write-Output "EXIT=$LASTEXITCODE"', exit_code: 0 },
      ],
      checks: [{ id: "suite", status: "pass", command: "node --test", evidence: "pass 2 / fail 0" }],
      files_changed: [],
      blockers: [],
      next_actions: [],
    },
    { kind: "verification" },
    { commands: unsafeObserved, tool_calls: [{ type: "command_execution", status: "completed" }] },
    [],
    [],
    [{ id: "suite", description: "Run the suite", command: "node --test", source: "planner" }],
  );
  assert.equal(paraphrased.gate, "fail");
  assert.ok(paraphrased.findings.some((f) => f.id === "RUNNER-REQUIRED-CHECK-suite"));

  // A claim naming an executable that never ran successfully is still rejected.
  const fabricated = ensureNodeResultConsistency(
    {
      status: "completed",
      gate: "pass",
      summary: "claims a tool that never ran",
      skills_applied: [],
      evidence: [],
      findings: [],
      commands: [{ command: "gradle testDebugUnitTest", exit_code: 0 }],
      checks: [{ id: "suite", status: "pass", command: "node --test", evidence: "pass" }],
      files_changed: [],
      blockers: [],
      next_actions: [],
    },
    { kind: "verification" },
    { commands: unsafeObserved, tool_calls: [{ type: "command_execution", status: "completed" }] },
    [],
    [],
    [{ id: "suite", description: "Run the suite", command: "node --test", source: "planner" }],
  );
  assert.equal(fabricated.gate, "fail");
  assert.ok(fabricated.findings.some((f) => f.id === "RUNNER-EVIDENCE-GAP"));

  // Shell built-ins are ignored so the real program names survive.
  assert.ok(commandExecutables('Write-Output "x"; git diff -- a.txt').includes("git"));
  assert.equal(commandExecutables('Write-Output "x"; git diff -- a.txt').includes("write-output"), false);
  assert.deepEqual(commandExecutables("node --test"), ["node"]);
  assert.deepEqual(commandExecutables(""), []);
});

test("Windows PowerShell command evidence matches the unwrapped agent claim", () => {
  const skillPath = "D:\\path\\to\\skills\\codex-skills\\autonomous-engineering-graph\\SKILL.md";
  const claimedCommand = `Get-Content -Raw '${skillPath}'`;
  const observedCommand =
    '"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "Get-Content -Raw \'D:\\\\ai-data\\\\skills\\\\codex-skills\\\\autonomous-engineering-graph\\\\SKILL.md\'"';
  const result = ensureNodeResultConsistency(
    {
      status: "completed",
      gate: "pass",
      summary: "plan supervision passed",
      skills_applied: [],
      evidence: [],
      findings: [],
      commands: [{ command: claimedCommand, exit_code: 0, summary: "read the supplied skill" }],
      checks: [],
      files_changed: [],
      blockers: [],
      next_actions: [],
    },
    { kind: "supervision" },
    {
      commands: [{ command: observedCommand, exit_code: 0 }],
      tool_calls: [{ type: "command_execution", name: "shell", status: "completed" }],
    },
    [],
    [],
  );
  assert.equal(result.status, "completed");
  assert.equal(result.gate, "pass");
  assert.equal(result.findings.some((finding) => finding.id === "RUNNER-EVIDENCE-GAP"), false);
  assert.ok(commandExecutables(observedCommand).includes("get-content"));
});

test("PowerShell here-string summaries with an ellipsis still require ordered host evidence", () => {
  const result = ensureNodeResultConsistency(
    {
      status: "completed",
      gate: "pass",
      summary: "focused probe passed",
      skills_applied: [],
      evidence: [],
      findings: [],
      commands: [{ command: "@' ... '@ | node --input-type=module", exit_code: 0 }],
      checks: [],
      files_changed: [],
      blockers: [],
      next_actions: [],
    },
    { kind: "review" },
    {
      commands: [
        {
          command: `"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "@'\nconsole.log('probe passed')\n'@ | node --input-type=module -"`,
          exit_code: 0,
        },
      ],
      tool_calls: [{ type: "command_execution", name: "shell", status: "completed" }],
    },
    [],
    [],
  );
  assert.equal(result.status, "completed");
  assert.equal(result.gate, "pass");
  assert.equal(result.findings.some((finding) => finding.id === "RUNNER-EVIDENCE-GAP"), false);
});

test("independent review tolerates a failed ancillary command when its successful probe is evidenced", () => {
  const result = ensureNodeResultConsistency(
    {
      status: "completed",
      gate: "pass",
      summary: "targeted review passed",
      skills_applied: [],
      evidence: [],
      findings: [],
      commands: [
        { command: "git status --short", exit_code: 1, summary: "not a git repository" },
        { command: "node --input-type=module -", exit_code: 0, summary: "probe passed" },
      ],
      checks: [{ id: "probe", status: "pass", command: "node --input-type=module -", evidence: "probe passed" }],
      files_changed: [],
      blockers: [],
      next_actions: [],
    },
    { kind: "independent_review" },
    {
      commands: [
        { command: '"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "git status --short"', exit_code: 1 },
        { command: '"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "@\'\nconsole.log(\'probe passed\')\n\'@ | node --input-type=module -"', exit_code: 0 },
      ],
      tool_calls: [{ type: "command_execution", name: "shell", status: "completed" }],
    },
    [],
    [],
  );
  assert.equal(result.status, "completed");
  assert.equal(result.gate, "pass");
  assert.equal(result.findings.some((finding) => finding.id === "RUNNER-EVIDENCE-GAP"), false);
});

test("verification tolerates a failed ancillary scope probe when required checks pass", () => {
  const result = ensureNodeResultConsistency(
    {
      status: "completed",
      gate: "pass",
      summary: "verification passed; Git scope probe is unavailable in the copy",
      skills_applied: [],
      evidence: [],
      findings: [],
      commands: [
        { command: "npm test", exit_code: 0, summary: "tests passed" },
        { command: "git status --short", exit_code: 128, summary: "not a git repository" },
      ],
      checks: [{ id: "tests", status: "pass", command: "npm test", evidence: "3 tests passed" }],
      files_changed: [],
      blockers: [],
      next_actions: [],
    },
    { kind: "verification" },
    {
      commands: [
        { command: "/bin/zsh -lc 'npm test'", exit_code: 0 },
        { command: "/bin/zsh -lc 'git status --short'", exit_code: 128 },
      ],
      tool_calls: [{ type: "command_execution", name: "shell", status: "completed" }],
    },
    [],
    [],
    [{ id: "tests", description: "Run the repository test suite", command: "npm test", source: "package.json" }],
  );
  assert.equal(result.status, "completed");
  assert.equal(result.gate, "pass");
  assert.equal(result.machine_check_evaluation.checks[0].status, "pass");
  assert.equal(result.findings.some((finding) => finding.id === "RUNNER-EVIDENCE-GAP"), false);
});

test("reports do not call an explicitly failed ancillary command a successful-evidence gap", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const runDir = path.join(root, "run");
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(runDir, "recovery"), { recursive: true });
  await writeFile(path.join(runDir, "recovery", "restore.mjs"), "// fixture restore\n", "utf8");
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await atomicWriteJson(path.join(runDir, "workspace-before.json"), await captureWorkspaceManifest(workspace));
  const nodeDir = path.join(runDir, "nodes", "review-fixture");
  await mkdir(nodeDir, { recursive: true });
  await atomicWriteJson(path.join(nodeDir, "proof.json"), {
    commands: [{ command: '"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "git status --short"', exit_code: 1 }],
    tool_calls: [{ type: "command_execution", name: "shell", status: "completed" }],
    supplied_skills: [],
    observed_files_changed: [],
  });
  await atomicWriteJson(path.join(nodeDir, "result.json"), {
    status: "completed",
    gate: "pass",
    summary: "review completed; git status is ancillary and unavailable in this copy",
    skills_applied: [],
    evidence: [],
    findings: [],
    commands: [{ command: "git status --short", exit_code: 1, summary: "not a git repository" }],
    checks: [],
    files_changed: [],
    blockers: [],
    next_actions: [],
  });
  const run = {
    run_id: "failed-ancillary-report-fixture",
    goal: "report failed ancillary evidence correctly",
    workspace,
    status: "completed",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    nodes: { "review-fixture": { id: "review-fixture", kind: "review", status: "completed", gate: "pass" } },
    node_order: ["review-fixture"],
    plan: null,
    options: {},
    authorizations: [],
    blocker: null,
    report: null,
  };
  const reportPath = await generateReport(runDir, run, { nodes: [] });
  const report = await readFile(reportPath, "utf8");
  assert.doesNotMatch(report, /agent-reported successful command lacked matching successful host evidence/);
});

test("metadata-only correction does not require implementation Skill evidence", () => {
  const result = ensureNodeResultConsistency(
    {
      status: "completed",
      gate: "pass",
      summary: "Evidence formatting corrected; no source changes needed.",
      skills_applied: [],
      evidence: [],
      findings: [{ id: "RUNNER-EVIDENCE-GAP", disposition: "fixed", validation: "test_confirmed" }],
      commands: [{ command: "node --input-type=module -", exit_code: 0, summary: "probe passed" }],
      checks: [{ id: "probe", status: "pass", command: "node --input-type=module -", evidence: "probe passed" }],
      files_changed: [],
      blockers: [],
      next_actions: [],
    },
    { kind: "correction" },
    { commands: [{ command: "node --input-type=module -", exit_code: 0 }], tool_calls: [{ type: "command_execution", status: "completed" }] },
    [],
    [{ name: "graph-engineering-quality", sha256: "quality", references: [{ target: "references/execution-rubric.md" }] }],
    [],
  );
  assert.equal(result.status, "completed");
  assert.equal(result.gate, "pass");
  assert.equal(result.findings.some((finding) => finding.id === "RUNNER-SKILL-APPLICATION-GAP"), false);
});

test("synthesis normalization removes controller-only metadata findings without hiding unresolved evidence gaps", () => {
  const ready = normalizeSynthesisArtifact(
    {
      status: "needs_retry",
      gate: "fail",
      summary: "Six evidenced findings are ready for implementation.",
      skills_applied: [],
      findings: [
        {
          id: "RUNNER-SKILL-APPLICATION-GAP",
          fingerprint: "runner-skill-application-gap",
          disposition: "rejected",
        },
        {
          id: "F-1",
          disposition: "confirmed",
          evidence: "reproduced in the fixture",
          recommended_action: "Add the regression test",
        },
      ],
      blockers: [],
      next_actions: ["Implement F-1"],
    },
    [{ name: "autonomous-engineering-graph", controller_enforced: true }],
  );
  assert.equal(ready.status, "completed");
  assert.equal(ready.gate, "pass");
  assert.deepEqual(ready.findings.map((finding) => finding.id), ["F-1"]);

  const unresolved = normalizeSynthesisArtifact(
    {
      status: "needs_retry",
      gate: "fail",
      summary: "Evidence remains incomplete.",
      findings: [
        {
          id: "RUNNER-SKILL-APPLICATION-GAP",
          disposition: "rejected",
        },
        {
          id: "F-2",
          disposition: "unresolved",
          evidence: "The root cause is not reproduced",
          recommended_action: "Collect evidence",
        },
      ],
      blockers: [],
      next_actions: ["Collect evidence"],
    },
    [{ name: "autonomous-engineering-graph", controller_enforced: true }],
  );
  assert.equal(unresolved.status, "needs_retry");
  assert.equal(unresolved.gate, "fail");
  assert.deepEqual(unresolved.findings.map((finding) => finding.id), ["F-2"]);
});

test("synthesis evidence enrichment merges matching upstream claims by finding identity", () => {
  const enriched = enrichSynthesisEvidence(
    {
      findings: [
        {
          id: "F-TENANT",
          fingerprint: "tenant-filter",
          evidence: "Cross-tenant access was reproduced.",
          evidence_anchors: ["src/appointments.mjs"],
        },
        { id: "F-OTHER", evidence: "Unrelated finding." },
      ],
      evidence: [],
    },
    [
      {
        evidence: [
          {
            claim: "The README also requires deleted records to be excluded.",
            finding_ids: ["F-TENANT"],
            kind: "document",
            source: "README.md Appointment Lists",
          },
        ],
        findings: [],
      },
    ],
  );
  assert.match(enriched.findings[0].evidence, /Cross-tenant access/);
  assert.match(enriched.findings[0].evidence, /deleted records/);
  assert.ok(enriched.findings[0].evidence_anchors.includes("README.md Appointment Lists"));
  assert.equal(enriched.findings[1].evidence, "Unrelated finding.");
  assert.equal(enriched.evidence.length, 1);
});

test("skill application evidence accepts an explicit human-readable reference name", () => {
  const result = ensureNodeResultConsistency(
    {
      status: "completed",
      gate: "not_applicable",
      summary: "Applied the selected skill.",
      skills_applied: [
        {
          name: "fixture-domain-skill",
          sha256: "domain-hash",
          requirements_applied: ["Applied execution rubric for the bounded change and rollback."],
        },
      ],
      evidence: [],
      findings: [],
      commands: [],
      checks: [],
      files_changed: [],
      blockers: [],
      next_actions: [],
    },
    { kind: "review" },
    { commands: [], tool_calls: [] },
    [],
    [{ name: "fixture-domain-skill", sha256: "domain-hash", references: [{ target: "references/execution-rubric.md" }] }],
  );
  assert.equal(result.findings.some((finding) => finding.id === "RUNNER-SKILL-APPLICATION-GAP"), false);
});

test("completed specialist reviews are not failed merely because they found defects", () => {
  const skill = {
    name: "fixture-review",
    sha256: "fixture-sha",
    references: [],
  };
  const result = ensureNodeResultConsistency(
    {
      status: "needs_retry",
      gate: "fail",
      summary: "The bounded review completed and reproduced one defect.",
      skills_applied: [{ name: skill.name, sha256: skill.sha256, requirements_applied: ["Applied the fixture review contract"] }],
      evidence: [],
      findings: [{ id: "FIXTURE-DEFECT", title: "Validated fixture defect" }],
      commands: [],
      checks: [],
      files_changed: [],
      blockers: [],
      next_actions: ["Send the defect to synthesis"],
    },
    { id: "review-fixture", kind: "review" },
    { commands: [], tool_calls: [] },
    [],
    [skill],
  );
  assert.equal(result.status, "completed");
  assert.equal(result.gate, "pass");
  assert.equal(result.findings[0].id, "FIXTURE-DEFECT");
});

test("verification cannot omit a planner-required check", () => {
  const result = ensureNodeResultConsistency(
    {
      status: "completed",
      gate: "pass",
      summary: "partial verification",
      skills_applied: [],
      evidence: [],
      findings: [],
      commands: [{ command: "npm test", exit_code: 0, summary: "passed" }],
      checks: [],
      files_changed: [],
      blockers: [],
      next_actions: [],
    },
    { kind: "verification" },
    { commands: [{ command: "npm test", exit_code: 0 }], tool_calls: [{ type: "command_execution" }] },
    [],
    [],
    [{ id: "required-build", description: "Build the app", command: "npm run build", source: "project rules" }],
  );
  assert.equal(result.gate, "fail");
  assert.ok(result.findings.some((finding) => finding.id === "RUNNER-REQUIRED-CHECK-required-build"));
});

test("manual verification requires its exact successful evidence tool", () => {
  const result = ensureNodeResultConsistency(
    {
      status: "completed",
      gate: "pass",
      summary: "claimed visual pass",
      skills_applied: [],
      evidence: [],
      findings: [],
      commands: [{ command: "echo unrelated", exit_code: 0, summary: "passed" }],
      checks: [{ id: "visual-inspection", status: "pass", evidence: "claimed screenshot inspection", command: null }],
      files_changed: [],
      blockers: [],
      next_actions: [],
    },
    { kind: "verification" },
    {
      commands: [{ command: "echo unrelated", exit_code: 0 }],
      tool_calls: [{ type: "command_execution", name: "shell", status: "completed" }],
    },
    [],
    [],
    [
      {
        id: "visual-inspection",
        description: "Inspect checkout screenshot",
        command: null,
        evidence_tool: "mcp.screenshot",
        source: "screenshots/checkout.png",
      },
    ],
  );
  assert.equal(result.status, "needs_retry");
  assert.equal(result.gate, "fail");
  assert.ok(result.findings.some((finding) => finding.id === "RUNNER-REQUIRED-CHECK-visual-inspection"));
});

test("prohibited external commands block common direct and wrapped forms", () => {
  const commands = [
    "git commit -m unauthorized",
    "git -C . commit -m unauthorized",
    "cmd /c git commit -m unauthorized",
    "git.exe commit -m unauthorized",
    "powershell -Command git commit -m unauthorized",
    'powershell -Command "git commit -m unauthorized"',
    'bash -lc "git commit -m unauthorized"',
    "git -c alias.ci=commit ci -m unauthorized",
    "FOO=bar git commit -m unauthorized",
    "sudo git commit -m unauthorized",
    "doas -u root git commit -m unauthorized",
  ];
  for (const command of commands) {
    const result = ensureNodeResultConsistency(
    {
      status: "completed",
      gate: "not_applicable",
      summary: "committed",
      skills_applied: [],
      evidence: [],
      findings: [],
      commands: [{ command, exit_code: 0, summary: "committed" }],
      checks: [],
      files_changed: [],
      blockers: [],
      next_actions: [],
    },
    { kind: "implementation" },
    {
      commands: [{ command, exit_code: 0, status: "completed" }],
      tool_calls: [{ type: "command_execution", name: "shell", status: "completed" }],
    },
    [],
    [],
    [],
    );
    assert.equal(result.status, "blocked", command);
    assert.equal(result.gate, "blocked", command);
    assert.ok(result.findings.some((finding) => finding.id === "RUNNER-PROHIBITED-ACTION"), command);
    assert.throws(
      () =>
        assertRunCanResume({
          run_id: "prohibited-action-run",
          status: "blocked",
          blocker: result.blockers.find((blocker) => blocker.type === "PROHIBITED_EXTERNAL_ACTION"),
        }),
      /cannot resume/i,
      command,
    );
  }
});

test("quoted search text inside a shell wrapper is not treated as a prohibited action", () => {
  const command = String.raw`"powershell.exe" -Command "rg -n \"git push|git commit|docker push\" report.md completion.json finding-lineage.json"`;
  const result = ensureNodeResultConsistency(
    {
      status: "completed",
      gate: "pass",
      summary: "audit artifacts inspected",
      skills_applied: [],
      evidence: [],
      findings: [],
      commands: [{ command, exit_code: 0, summary: "search completed" }],
      checks: [],
      files_changed: [],
      blockers: [],
      next_actions: [],
    },
    { kind: "verification" },
    { commands: [{ command, exit_code: 0, status: "completed" }], tool_calls: [] },
    [],
    [],
  );
  assert.equal(result.status, "completed");
  assert.equal(result.blockers.some((blocker) => blocker.type === "PROHIBITED_EXTERNAL_ACTION"), false);
});

test("prohibited actions remain blocked when skill application evidence is also missing", () => {
  const command = "git push https://example.invalid/repo HEAD:main";
  const result = ensureNodeResultConsistency(
    {
      status: "completed",
      gate: "not_applicable",
      summary: "finished",
      skills_applied: [],
      evidence: [],
      findings: [],
      commands: [{ command, exit_code: 0, summary: "finished" }],
      checks: [],
      files_changed: [],
      blockers: [],
      next_actions: [],
    },
    { kind: "implementation" },
    { commands: [{ command, exit_code: 0, status: "completed" }], tool_calls: [] },
    [],
    [{ name: "fixture-skill", sha256: "fixture-hash", references: [] }],
    [],
  );
  assert.equal(result.status, "blocked");
  assert.equal(result.gate, "blocked");
  assert.ok(result.findings.some((finding) => finding.id === "RUNNER-SKILL-APPLICATION-GAP"));
  assert.throws(
    () =>
      assertRunCanResume({
        run_id: "combined-evidence-run",
        status: result.status,
        blocker: result.blockers.find((blocker) => blocker.type === "PROHIBITED_EXTERNAL_ACTION"),
        prohibited_external_action: { node_id: "implementation" },
      }),
    /cannot resume/i,
  );
});

test("controller policy is machine enforced while domain Skill application evidence remains required", () => {
  const baseResult = {
    status: "completed",
    gate: "not_applicable",
    summary: "reviewed",
    skills_applied: [],
    evidence: [],
    findings: [],
    commands: [],
    checks: [],
    files_changed: [],
    blockers: [],
    next_actions: [],
  };
  const controller = {
    name: "autonomous-engineering-graph",
    sha256: "controller-hash",
    controller_enforced: true,
    references: [],
  };
  const withoutControllerSelfReport = ensureNodeResultConsistency(
    baseResult,
    { kind: "synthesis" },
    { commands: [], tool_calls: [] },
    [],
    [controller],
  );
  assert.equal(withoutControllerSelfReport.status, "completed");
  assert.equal(withoutControllerSelfReport.findings.some((finding) => finding.id === "RUNNER-SKILL-APPLICATION-GAP"), false);

  const domain = {
    name: "fixture-domain-skill",
    sha256: "domain-hash",
    references: [{ target: "references/review-rubric.md", sha256: "reference-hash" }],
  };
  const missingDomainEvidence = ensureNodeResultConsistency(
    baseResult,
    { kind: "review" },
    { commands: [], tool_calls: [] },
    [],
    [controller, domain],
  );
  assert.equal(missingDomainEvidence.status, "needs_retry");
  assert.ok(missingDomainEvidence.findings.some((finding) => finding.id === "RUNNER-SKILL-APPLICATION-GAP"));
});

test("node input budgets stop oversized prompts before a model call", () => {
  assert.equal(nodeInputBudget("supervision"), 64_000);
  assert.equal(nodeInputBudget("review"), 128_000);
  assert.equal(nodeInputBudget("synthesis"), 192_000);
  assert.equal(nodeInputBudget("verification"), 256_000);
  assert.equal(nodeInputBudget("independent_review"), 256_000);
  const compactionAttempts = [{ level: "minimal", input_bytes: 200_000, budget_bytes: 192_000 }];
  const error = nodeInputBudgetError({ id: "synthesis", kind: "synthesis" }, 200_000, 192_000, compactionAttempts);
  assert.equal(error.code, "NODE_INPUT_BUDGET_EXCEEDED");
  assert.equal(error.input_bytes, 200_000);
  assert.equal(error.budget_bytes, 192_000);
  assert.deepEqual(error.compaction_attempts, compactionAttempts);
  assert.match(error.message, /before contacting a model/);
});

test("budget blockers are cleared when the exact run is resumed", () => {
  assert.equal(RESUME_CLEARABLE_BLOCKERS.has("NODE_INPUT_BUDGET_EXCEEDED"), true);
  assert.equal(RESUME_CLEARABLE_BLOCKERS.has("PROHIBITED_EXTERNAL_ACTION"), false);
});

test("supervision rechecks bypass stale recorded evidence only for the active recheck node", () => {
  const node = { id: "implementation-supervision-r1", kind: "supervision", stage: "implementation" };
  assert.equal(
    shouldRetrySupervisionRecheck(node, {
      supervision_state: {
        implementation: { phase: "rechecking", node_id: "implementation-supervision" },
      },
    }),
    true,
  );
  assert.equal(
    shouldRetrySupervisionRecheck(node, {
      supervision_state: {
        implementation: { phase: "passed", node_id: "implementation-supervision-r1" },
      },
    }),
    false,
  );
  assert.equal(
    shouldRetrySupervisionRecheck({ ...node, id: "implementation-supervision-r2" }, {
      supervision_state: {
        implementation: { phase: "rechecking", node_id: "implementation-supervision" },
      },
    }),
    false,
  );
});

test("oversized real-world dependency artifacts are compacted below the supervision budget", async (t) => {
  const runDir = await temporaryDirectory(t);
  const nodeDir = path.join(runDir, "nodes", "implementation");
  await mkdir(nodeDir, { recursive: true });
  const findings = Array.from({ length: 50 }, (_, index) => ({
    id: `FINDING-${index}`,
    severity: index === 0 ? "critical" : "medium",
    title: `Large implementation finding ${index}`,
    evidence: `evidence-${index}-${"x".repeat(5_000)}`,
    recommended_action: `action-${index}-${"y".repeat(3_000)}`,
    fingerprint: `fixture-fingerprint-${index}`,
    related_finding_ids: [],
    evidence_anchors: [`fixture-${index}.mjs:1`],
    validation: "unverified",
    disposition: "implemented",
  }));
  await writeFile(path.join(nodeDir, "result.json"), `${JSON.stringify({
    status: "completed",
    gate: "not_applicable",
    summary: "z".repeat(10_000),
    evidence: findings.map((finding) => ({ claim: finding.evidence, source: finding.evidence_anchors[0], kind: "code", finding_ids: [finding.id] })),
    findings,
    blockers: [],
    next_actions: Array.from({ length: 50 }, (_, index) => `next-${index}-${"n".repeat(2_000)}`),
    files_changed: Array.from({ length: 300 }, (_, index) => `src/file-${index}.mjs`),
    checks: [],
  })}\n`, "utf8");
  await writeFile(path.join(nodeDir, "proof.json"), `${JSON.stringify({
    process_exit_code: 0,
    timed_out: false,
    commands: [],
    tool_calls: [],
    errors: [],
    supplied_skills: [],
    observed_files_changed: Array.from({ length: 300 }, (_, index) => `src/file-${index}.mjs`),
  })}\n`, "utf8");
  const context = await dependencyContext(
    { id: "implementation-supervision", kind: "supervision", stage: "implementation", depends_on: ["implementation"] },
    runDir,
    {
      plan: {
        task_summary: "Large artifact fixture",
        mode: "audit",
        scope: ["fixture"],
        risk_level: "medium",
        completion_criteria: ["bounded supervision input"],
        required_checks: [],
        discovery_skills: [],
        review_nodes: [],
        implementation_skills: [],
        verification_skills: [],
        excluded_surfaces: [],
        owner_gate: { required: false },
      },
      nodes: { implementation: { kind: "implementation" } },
      supervision_state: {},
    },
  );
  assert.ok(Buffer.byteLength(context) < nodeInputBudget("supervision"), `context remained ${Buffer.byteLength(context)} bytes`);
  const artifact = JSON.parse(context).find((item) => item.node === "implementation");
  assert.equal(artifact.result.findings.length, 8);
  assert.equal(artifact.result.compaction.findings_omitted, 42);
  assert.match(artifact.result.findings[0].evidence, /truncated/);
});

test("implementation supervision emergency compaction fits a full acceptance audit prompt", async (t) => {
  const runDir = await temporaryDirectory(t);
  const requiredChecks = Array.from({ length: 25 }, (_, index) => ({
    id: `check-acceptance-${String(index + 1).padStart(2, "0")}`,
    description: `Verify acceptance surface ${index + 1} with machine evidence and preserve an explicit environment gap when the required runtime is unavailable.`,
    command: `pnpm --filter fixture-${index + 1} test -- --runInBand acceptance-${index + 1}.spec.ts`,
    evidence_tool: null,
    source: `acceptance ledger ACC-${String((index % 15) + 1).padStart(2, "0")} and repository test policy`,
    equivalent_commands: [`pnpm fixture:${index + 1}`, `npm run fixture:${index + 1}`],
    environment_required: index % 3 === 0,
    gap_policy: index % 3 === 0 ? "waiting_environment" : "fail",
    ...(index % 3 === 0 ? { environment_kind: "external_service" } : {}),
    blocking_scope: "both",
  }));
  const findings = Array.from({ length: 14 }, (_, index) => ({
    id: `F-AUDIT-${String(index + 1).padStart(2, "0")}`,
    severity: index < 5 ? "high" : "medium",
    title: `Acceptance audit finding ${index + 1}`,
    evidence: `Repository evidence for finding ${index + 1}: ${"observed behavior ".repeat(30)}`,
    recommended_action: `Apply the bounded reversible repair for finding ${index + 1} and retain machine validation.`,
    fingerprint: `acceptance-audit-fingerprint-${index + 1}`,
    related_finding_ids: [],
    evidence_anchors: [`apps/fixture-${index + 1}.ts:10`],
    validation: "unverified",
    disposition: index < 9 ? "implemented" : "unresolved",
  }));
  const filesChanged = [
    ...Array.from({ length: 90 }, (_, index) => `apps/fixture/src/surface-${index + 1}.ts`),
    "report.md",
    "completion.json",
    "finding-lineage.json",
  ];
  const proof = {
    process_exit_code: 1,
    timed_out: false,
    sandbox: "workspace-write",
    commands: Array.from({ length: 30 }, (_, index) => ({
      command: `pnpm --filter fixture test -- acceptance-${index + 1}`,
      exit_code: index === 29 ? 1 : 0,
      status: index === 29 ? "failed" : "completed",
      output_sha256: `sha-${index + 1}`,
    })),
    tool_calls: Array.from({ length: 36 }, (_, index) => ({ type: "command_execution", name: `tool-${index + 1}`, status: "completed" })),
    errors: ["Generated database client is unavailable until the runner-owned preparation check executes."],
    supplied_skills: Array.from({ length: 5 }, (_, index) => ({
      name: `graph-domain-${index + 1}`,
      sha256: `skill-sha-${index + 1}`,
      references: [{ target: `references/rubric-${index + 1}.md`, sha256: `reference-sha-${index + 1}` }],
    })),
    observed_files_changed: filesChanged,
  };
  for (const [node, result] of Object.entries({
    implementation: {
      status: "needs_retry",
      gate: "blocked",
      summary: "Implemented nine findings and retained five unresolved findings for verification or owner follow-up.",
      evidence: findings.slice(0, 5).map((finding) => ({ claim: finding.evidence, source: finding.evidence_anchors[0], kind: "code", finding_ids: [finding.id] })),
      findings,
      blockers: [{ type: "EXTERNAL_DEPENDENCY", reason: "Generated database client is unavailable.", unblock_condition: "Run the runner-owned generation check." }],
      next_actions: ["Generate the database client", "Run build and lint", "Run environment-backed journeys", "Complete independent review"],
      files_changed: filesChanged,
      checks: [{ id: "targeted-test", status: "fail", evidence: "Database client missing", command: "pnpm test", finding_ids: [findings[0].id] }],
    },
    synthesis: {
      status: "completed",
      gate: "pass",
      summary: "Fourteen repository-grounded findings map one-to-one to the acceptance ledger and verification obligations.",
      evidence: findings.map((finding) => ({ claim: finding.evidence, source: finding.evidence_anchors[0], kind: "finding", finding_ids: [finding.id] })),
      findings,
      blockers: [],
      next_actions: findings.map((finding) => finding.recommended_action),
      files_changed: [],
      checks: [],
    },
  })) {
    const nodeDir = path.join(runDir, "nodes", node);
    await mkdir(nodeDir, { recursive: true });
    await atomicWriteJson(path.join(nodeDir, "result.json"), result);
    await atomicWriteJson(path.join(nodeDir, "proof.json"), node === "implementation" ? proof : { ...proof, sandbox: "read-only", observed_files_changed: [] });
  }
  const plan = {
    task_summary: "Audit exactly 15 acceptance items without merging, splitting, adding, or omitting records.",
    mode: "audit",
    scope: Array.from({ length: 15 }, (_, index) => `ACC-${String(index + 1).padStart(2, "0")}`),
    risk_level: "high",
    owner_gate: { required: false, reason: "", unblock_condition: "" },
    completion_criteria: Array.from({ length: 15 }, (_, index) => `ACC-${String(index + 1).padStart(2, "0")} has an independent status, evidence mapping, finding lineage, and next action.`),
    required_checks: requiredChecks,
    discovery_skills: [],
    review_nodes: Array.from({ length: 5 }, (_, index) => ({
      id: `review-${index + 1}`,
      title: `Review ${index + 1}`,
      focus: `Review acceptance dimension ${index + 1}`,
      skills: [],
    })),
    implementation_skills: [],
    verification_skills: [],
    excluded_surfaces: [],
  };
  const built = await buildNodePrompt({
    node: {
      id: "implementation-supervision",
      kind: "supervision",
      stage: "implementation",
      title: "Implementation supervision",
      focus: "Check implementation coverage and readiness for formal verification.",
      depends_on: ["implementation"],
      skills: [],
    },
    run: {
      run_id: "fixture-full-acceptance-audit",
      goal: "Complete a 15-item acceptance audit in an isolated worktree and preserve every environment gap.",
      plan,
      authorizations: [],
      workspace_preflight: { status: "prepared", package_manager: "pnpm", preparation: { status: "deferred" } },
      nodes: { implementation: { kind: "implementation" }, synthesis: { kind: "synthesis" } },
      supervision_state: { synthesis: { artifact_node_id: "synthesis" } },
    },
    runDir,
    catalog: [],
    compactionLevel: "emergency",
  });

  assert.ok(Buffer.byteLength(built.prompt) <= nodeInputBudget("supervision"), `prompt remained ${Buffer.byteLength(built.prompt)} bytes`);
  assert.equal((built.prompt.match(/"verification_obligations"/g) || []).length, 0);
  assert.equal((built.prompt.match(/"controller_managed_graph"/g) || []).length, 1);
  assert.match(built.prompt, /check-acceptance-25/);
  assert.match(built.prompt, /ACC-15/);
  assert.doesNotMatch(built.prompt, /equivalent_commands/);
});

test("dependency preparation fails before planner model usage", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "package.json"), `${JSON.stringify({
    name: "invalid-lock-fixture",
    version: "1.0.0",
    private: true,
    dependencies: { "fixture-package-that-must-not-resolve": "1.0.0" },
  })}\n`, "utf8");
  await writeFile(path.join(workspace, "package-lock.json"), "{}\n", "utf8");
  const result = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--goal",
      "Audit the fixture without wasting a model call when dependencies are unavailable",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: SLOW_INTEGRATION_TIMEOUT,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_ALLOW_HOST_DEPENDENCY_PREPARE: "1",
      },
    },
  );
  assert.equal(result.status, 2, spawnResultDetails(result));
  const summary = JSON.parse(result.stdout.trim());
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  const preflight = JSON.parse(await readFile(path.join(summary.run_dir, "workspace-preflight.json"), "utf8"));
  assert.equal(run.blocker.type, "WORKSPACE_PREPARATION_FAILED");
  assert.equal(preflight.status, "fail");
  assert.equal(await readFile(path.join(summary.run_dir, "nodes", "planner", "attempts.json"), "utf8").catch(() => null), null);
});

test("an ecosystem readiness gap stops before planner model usage", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(workspace, "pyproject.toml"),
    "[project]\nname = 'missing-lock-fixture'\nversion = '1.0.0'\ndependencies = ['requests==2.32.3']\n",
    "utf8",
  );

  const result = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--goal",
      "Repair the fixture without wasting a model call when its Python environment is not reproducible",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: SLOW_INTEGRATION_TIMEOUT,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_FAKE_SCENARIO: "happy",
      },
    },
  );

  assert.equal(result.status, 2, spawnResultDetails(result));
  const summary = JSON.parse(result.stdout.trim());
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  const preflight = JSON.parse(await readFile(path.join(summary.run_dir, "workspace-preflight.json"), "utf8"));
  assert.equal(run.status, "blocked");
  assert.equal(run.blocker.type, "WORKSPACE_ENVIRONMENT_GAP");
  assert.match(run.blocker.unblock_condition, /correct.*source workspace.*start a new Graph run/i);
  assert.ok(
    !run.nodes.planner ||
      (run.nodes.planner.status === "blocked" && (run.nodes.planner.attempts || 0) === 0),
    "planner must be absent or explicitly blocked before any attempt",
  );
  assert.equal(preflight.status, "pass");
  assert.equal(preflight.readiness, "environment_gap");
  assert.equal(preflight.ready, false);
  assert.ok(preflight.environment_gaps.some((gap) => gap.ecosystem === "python" && gap.status === "missing-lock"));
  assert.equal(await readFile(path.join(summary.run_dir, "nodes", "planner", "attempts.json"), "utf8").catch(() => null), null);
});

test("an oversized selected Skill is rejected before the node model process starts", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  const skillDir = path.join(workspace, ".codex", "skills", "fixture-review");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: fixture-review\ndescription: Review the graph fixture\n---\n\n${"bounded fixture rule\n".repeat(9_000)}`,
    "utf8",
  );
  const execution = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--workspace-mode",
      "live",
      "--state-root",
      stateRoot,
      "--goal",
      "Audit the fixture and prove oversized node input is bounded",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_FAKE_SCENARIO: "happy",
      },
    },
  );
  assert.equal(execution.status, 2, execution.stderr || execution.stdout);
  const summary = JSON.parse(execution.stdout.trim());
  assert.equal(summary.status, "completed_with_gaps");
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  assert.equal(run.blocker.type, "NODE_INPUT_BUDGET_EXCEEDED");
  assert.match(run.blocker.reason, /NODE_INPUT_BUDGET_EXCEEDED|exceeding the .* budget/);
  assert.equal(run.blocker.node_id, "discovery");
  assert.equal(run.blocker.input_bytes > run.blocker.budget_bytes, true);
  assert.deepEqual(run.blocker.compaction_attempts.map((attempt) => attempt.level), ["standard", "tight", "minimal", "emergency"]);
  assert.match(run.blocker.unblock_condition, /resume this exact run/i);
  const node = run.nodes.discovery;
  assert.equal(node.attempts, 1);
  const attempts = JSON.parse(await readFile(path.join(summary.run_dir, "nodes", "discovery", "attempts.json"), "utf8"));
  assert.equal(attempts.length, 1);
  assert.match(attempts[0].runner_error, /exceeding the .* budget/);
  assert.equal(attempts[0].retry_scheduled, false);
  assert.equal(await readFile(path.join(summary.run_dir, "nodes", "discovery", "events.jsonl"), "utf8").catch(() => ""), "");
});

test("a protected action explicitly deferred from the current goal does not block progress", () => {
  const result = ensureNodeResultConsistency(
    {
      status: "blocked",
      gate: "blocked",
      summary: "repository work can continue while deployment remains deferred",
      skills_applied: [],
      evidence: [],
      findings: [],
      commands: [],
      checks: [],
      files_changed: [],
      blockers: [{
        type: "AUTHORIZATION",
        reason: "Production TLS deployment requires owner approval.",
        unblock_condition: "Approve production deployment separately.",
        required_for_current_goal: false,
        protected_action: "Deploy production TLS configuration.",
      }],
      next_actions: [],
    },
    { kind: "synthesis" },
    { commands: [], tool_calls: [] },
    [],
    [],
  );
  assert.equal(result.status, "completed");
  assert.equal(result.blockers.length, 0);
  assert.equal(result.deferred_protected_actions.length, 1);
  assert.match(result.next_actions[0], /Deferred protected action/);
});

test("an authorization blocker without an explicit current-goal decision cannot open a gate", () => {
  const result = ensureNodeResultConsistency(
    {
      status: "blocked",
      gate: "blocked",
      summary: "authorization decision omitted",
      skills_applied: [],
      evidence: [],
      findings: [],
      commands: [],
      checks: [],
      files_changed: [],
      blockers: [{
        type: "AUTHORIZATION",
        reason: "A protected change was discussed.",
        unblock_condition: "Clarify whether it is required.",
      }],
      next_actions: [],
    },
    { kind: "synthesis" },
    { commands: [], tool_calls: [] },
    [],
    [],
  );
  assert.equal(result.status, "needs_retry");
  assert.equal(result.gate, "fail");
  assert.equal(result.blockers.length, 0);
  assert.ok(result.findings.some((finding) => finding.id === "RUNNER-AUTHORIZATION-DECISION-GAP"));
});

test("command evidence does not block harmless mentions of prohibited words", () => {
  for (const command of ["echo git commit", "rg -n git commit README.md", 'bash -lc "echo git commit"']) {
    const result = ensureNodeResultConsistency(
      {
        status: "completed",
        gate: "not_applicable",
        summary: "inspected text",
        skills_applied: [],
        evidence: [],
        findings: [],
        commands: [{ command, exit_code: 0, summary: "inspected text" }],
        checks: [],
        files_changed: [],
        blockers: [],
        next_actions: [],
      },
      { kind: "implementation" },
      {
        commands: [{ command, exit_code: 0, status: "completed" }],
        tool_calls: [{ type: "command_execution", name: "shell", status: "completed" }],
      },
      [],
      [],
      [],
    );
    assert.equal(result.status, "completed", command);
    assert.equal(result.gate, "not_applicable", command);
  }
});

test("configured Git aliases are resolved before classifying an observed command", () => {
  for (const [command, alias] of [
    ["git publish", { publish: "push" }],
    ["git save", { save: "commit -am saved" }],
    ["git ship", { ship: "!git push origin HEAD" }],
  ]) {
    const result = ensureNodeResultConsistency(
      {
        status: "completed",
        gate: "not_applicable",
        summary: "finished",
        skills_applied: [],
        evidence: [],
        findings: [],
        commands: [{ command, exit_code: 0, summary: "finished" }],
        checks: [],
        files_changed: [],
        blockers: [],
        next_actions: [],
      },
      { kind: "implementation" },
      { commands: [{ command, exit_code: 0, status: "completed" }], tool_calls: [] },
      [],
      [],
      [],
      { gitAliases: alias },
    );
    assert.equal(result.status, "blocked", command);
  }
});

test("git HEAD or ref changes block node completion even without a matched command", () => {
  const result = ensureNodeResultConsistency(
    {
      status: "completed",
      gate: "not_applicable",
      summary: "finished",
      skills_applied: [],
      evidence: [],
      findings: [],
      commands: [],
      checks: [],
      files_changed: [],
      blockers: [],
      next_actions: [],
    },
    { kind: "implementation" },
    { commands: [], tool_calls: [] },
    [],
    [],
    [],
    {
      before: { git: true, head: "before", refs_sha256: "refs-before" },
      after: { git: true, head: "after", refs_sha256: "refs-after" },
    },
  );
  assert.equal(result.status, "blocked");
  assert.equal(result.gate, "blocked");
  assert.ok(result.findings.some((finding) => finding.id === "RUNNER-GIT-STATE-CHANGE"));
});

test("missing Git refs or config fingerprints fail closed as control-state changes", () => {
  for (const [before, after] of [
    [
      { git: true, head: "same", refs_sha256: null, git_config_sha256: "config" },
      { git: true, head: "same", refs_sha256: "refs", git_config_sha256: "config" },
    ],
    [
      { git: true, head: "same", refs_sha256: "refs", git_config_sha256: undefined },
      { git: true, head: "same", refs_sha256: "refs", git_config_sha256: "config" },
    ],
  ]) {
    const result = ensureNodeResultConsistency(
      {
        status: "completed",
        gate: "not_applicable",
        summary: "finished",
        skills_applied: [],
        evidence: [],
        findings: [],
        commands: [],
        checks: [],
        files_changed: [],
        blockers: [],
        next_actions: [],
      },
      { kind: "implementation" },
      { commands: [], tool_calls: [] },
      [],
      [],
      [],
      { before, after },
    );
    assert.equal(result.status, "blocked");
    assert.ok(result.findings.some((finding) => finding.id === "RUNNER-GIT-STATE-CHANGE"));
  }
});

test("runs blocked by a Git state change cannot adopt that state as a resume baseline", () => {
  assert.throws(
    () =>
      assertRunCanResume({
        run_id: "unsafe-run",
        status: "blocked",
        blocker: { type: "PROHIBITED_GIT_STATE_CHANGE" },
      }),
    /cannot resume.*Git control state/i,
  );
});

test("review mode runs a read-only graph and never exports an applicable result", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const execution = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--workspace-mode",
      "copy",
      "--state-root",
      stateRoot,
      "--goal",
      "Review the fixture without changing it",
      "--mode",
      "review",
      "--minimal",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_FAKE_SCENARIO: "happy",
      },
    },
  );
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const summary = JSON.parse(execution.stdout.trim());
  assert.equal(summary.status, "completed");
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  const graph = JSON.parse(await readFile(path.join(summary.run_dir, "graph.json"), "utf8"));
  const completion = JSON.parse(await readFile(path.join(summary.run_dir, "completion.json"), "utf8"));
  const metadata = JSON.parse(await readFile(path.join(summary.run_dir, "results", "metadata.json"), "utf8"));
  assert.equal(run.plan.mode, "review");
  assert.equal(graph.review_only, true);
  assert.equal(graph.nodes.some((node) => ["implementation", "verification", "correction"].includes(node.kind)), false);
  assert.equal(graph.nodes.every((node) => node.review_only === true && node.read_only !== false), true);
  assert.equal(run.workspace_preflight.status, "not_applicable");
  assert.equal(completion.review_only, true);
  assert.equal(completion.review_completed, true);
  assert.equal(completion.application_ready, false);
  assert.equal(completion.release_ready, false);
  assert.equal(run.results.review_only, true);
  assert.equal(run.results.eligible_to_apply, false);
  assert.match(run.results.rejection_reason, /review-only/);
  assert.equal(metadata.review_only, true);
  assert.equal(metadata.eligible_to_apply, false);
  assert.equal(await readFile(path.join(summary.run_dir, "results", "apply.mjs"), "utf8").catch(() => null), null);
  assert.deepEqual((await readdir(workspace)).sort(), [".codex", "fixture.txt"]);
});

test("copy-mode verification uses the source Git snapshot without probing the copy", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  for (const args of [
    ["init"],
    ["add", "."],
    ["-c", "user.name=Graph Test", "-c", "user.email=graph@example.invalid", "commit", "-m", "fixture"],
  ]) {
    const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  const execution = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--workspace-mode",
      "copy",
      "--state-root",
      stateRoot,
      "--goal",
      "Repair the fixture while preserving source Git evidence",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_FAKE_SCENARIO: "source-git-check",
      },
    },
  );
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const summary = JSON.parse(execution.stdout.trim());
  assert.equal(summary.status, "completed");
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  const completion = JSON.parse(await readFile(path.join(summary.run_dir, "completion.json"), "utf8"));
  const gitCheck = completion.machine_check_evaluation.checks.find((check) => check.id === "git-state");
  assert.equal(run.source_git.available, true);
  assert.equal(run.plan.required_checks.find((check) => check.id === "git-state").source_evidence, "source_git_snapshot");
  assert.equal(gitCheck.status, "pass");
  assert.equal(gitCheck.observed_source, "source_git_snapshot");
  assert.equal(run.results.eligible_to_apply, true);
  assert.equal(await readFile(path.join(workspace, "graph-output.txt"), "utf8").catch(() => null), null);
});

test("submit returns immediately and a detached runner completes the same saved run", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  const queueRoot = path.join(root, "queue");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const environment = {
    ...process.env,
    AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
    AEG_FAKE_SCENARIO: "happy",
    AEG_MODEL_QUEUE_ROOT: queueRoot,
  };
  const submitted = spawnSync(
    process.execPath,
    [
      RUNNER,
      "submit",
      "--user-approved",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--goal",
      "Audit and repair the detached fixture",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    { encoding: "utf8", timeout: 10_000, env: environment },
  );
  assert.equal(submitted.status, 0, submitted.stderr || submitted.stdout);
  const output = JSON.parse(submitted.stdout.trim());
  assert.equal(output.status, "submitted");
  assert.equal(output.handoff, "confirmed");
  assert.match(output.watch_command, /graph-engineering watch .*--run/);
  assert.match(output.watch_command, new RegExp(output.run_id));
  assert.ok(Number.isInteger(output.runner_pid) && output.runner_pid > 0);
  assert.ok(output.log.endsWith("runner.log"));
  const completed = await waitFor(async () => {
    const saved = JSON.parse(await readFile(path.join(output.run_dir, "run.json"), "utf8"));
    if (["blocked", "failed", "interrupted", "waiting_owner", "waiting_service"].includes(saved.status)) {
      throw new Error(`Detached Graph entered ${saved.status}: ${saved.blocker?.reason || saved.runner_error || "no reason"}`);
    }
    return saved.status === "completed" ? saved : null;
  }, { timeout: INTEGRATION_TIMEOUT, poll: 50, message: "detached Graph completion" });
  assert.equal(completed.run_id, output.run_id);
  assert.ok(await readFile(path.join(output.run_dir, "report.md"), "utf8"));
  await waitFor(
    async () => ((await readFile(path.join(output.run_dir, ".lock"), "utf8").catch(() => null)) === null),
    { timeout: 5_000, poll: 50, message: "detached runner lock release" },
  );
  await waitFor(
    async () => !processIsAlive(output.runner_pid),
    { timeout: 5_000, poll: 50, message: "detached runner process exit" },
  );
});

test("submit follow streams a confirmed handoff and the same run's terminal progress", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  const queueRoot = path.join(root, "queue");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const followed = spawnSync(
    process.execPath,
    [
      RUNNER,
      "submit",
      "--user-approved",
      "--follow",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--goal",
      "Audit and repair the followed fixture",
      "--timeout-minutes",
      "1",
      "--interval-seconds",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_FAKE_SCENARIO: "happy",
        AEG_MODEL_QUEUE_ROOT: queueRoot,
        AEG_DISABLE_NOTIFICATIONS: "1",
      },
    },
  );
  assert.equal(followed.status, 0, followed.stderr || followed.stdout);
  const events = followed.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(events.length >= 2, followed.stdout);
  const handoff = events[0];
  const terminal = events.at(-1);
  assert.equal(handoff.handoff, "confirmed");
  assert.equal(handoff.follow, true);
  assert.equal(terminal.run_id, handoff.run_id);
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.progress.status, "completed");
  assert.ok(await readFile(path.join(handoff.run_dir, "report.md"), "utf8"));
});

test("background handoff reports a child startup failure instead of false submission", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  const ackPath = path.join(root, ".background-handoff-fixture.json");
  const logPath = path.join(root, "runner.log");
  await mkdir(workspace, { recursive: true });
  const child = spawn(
    process.execPath,
    [RUNNER, "resume", "--workspace", workspace, "--state-root", stateRoot, "--run", "missing-run", "--json"],
    {
      cwd: workspace,
      env: { ...process.env, AEG_BACKGROUND_HANDOFF_PATH: ackPath },
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  const childClosed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  await assert.rejects(
    waitForBackgroundHandoff({ ackPath, runnerPid: child.pid, logPath, timeoutMs: 5_000 }),
    /failed before handoff:.*Run not found: missing-run/i,
  );
  await childClosed;
});

test("a combined prohibited command and Git state change remains non-resumable", () => {
  const command = "git commit -m unauthorized";
  const result = ensureNodeResultConsistency(
    {
      status: "completed",
      gate: "not_applicable",
      summary: "finished",
      skills_applied: [],
      evidence: [],
      findings: [],
      commands: [{ command, exit_code: 0, summary: "finished" }],
      checks: [],
      files_changed: [],
      blockers: [],
      next_actions: [],
    },
    { kind: "implementation" },
    { commands: [{ command, exit_code: 0, status: "completed" }], tool_calls: [] },
    [],
    [],
    [],
    {
      before: { git: true, head: "before", refs_sha256: "refs-before", git_config_sha256: "config-before" },
      after: { git: true, head: "after", refs_sha256: "refs-after", git_config_sha256: "config-after" },
    },
  );
  assert.deepEqual(
    new Set(result.blockers.map((blocker) => blocker.type)),
    new Set(["PROHIBITED_EXTERNAL_ACTION", "PROHIBITED_GIT_STATE_CHANGE"]),
  );
  assert.throws(
    () =>
      assertRunCanResume({
        run_id: "combined-unsafe-run",
        status: "blocked",
        blocker: result.blockers[0],
        prohibited_git_state_change: { node_id: "implementation" },
      }),
    /cannot resume/i,
  );
});

test("runPool waits for all started work and drains the queue before rejecting", async () => {
  const completed = [];
  await assert.rejects(
    runPool([0, 1, 2], 2, async (item) => {
      await new Promise((resolve) => setTimeout(resolve, item === 1 ? 25 : 5));
      completed.push(item);
      if (item === 0) throw new Error("fixture failure");
      return item;
    }),
    /fixture failure/,
  );
  assert.deepEqual(completed.sort(), [0, 1, 2]);
});

test("runPool cancels an unfinished wave after a budget exhaustion", async () => {
  const started = [];
  const cancelled = [];
  const budgetError = Object.assign(new Error("fixture budget exhausted"), {
    code: "RUN_BUDGET_EXHAUSTED",
  });
  await assert.rejects(
    runPool([0, 1, 2], 2, async (item, _index, { signal }) => {
      started.push(item);
      if (item === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw budgetError;
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 250);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          cancelled.push(item);
          reject(signal.reason || new Error("wave cancelled"));
        }, { once: true });
      });
      return item;
    }, { cancelOnError: true, cancelOn: (error) => error?.code === "RUN_BUDGET_EXHAUSTED" }),
    /fixture budget exhausted/,
  );
  assert.deepEqual(started.sort(), [0, 1]);
  assert.deepEqual(cancelled, [1]);
});

test("stale run locks are reclaimed while active locks are rejected", async (t) => {
  const runDir = await temporaryDirectory(t);
  await writeFile(path.join(runDir, ".lock"), "99999999\n2000-01-01T00:00:00Z\n", "utf8");
  const release = await acquireLock(runDir);
  await assert.rejects(acquireLock(runDir), /already active/);
  await release();
  assert.equal(await readFile(path.join(runDir, ".lock"), "utf8").catch(() => null), null);
});

test("new-run startup acquires admission before taking any workspace snapshot", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  const controlRoot = path.join(root, "control");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  const release = await acquireRuntimeAdmission(controlRoot, { purpose: "test_owner" });
  try {
    const result = spawnSync(
      process.execPath,
      [
        RUNNER,
        "start",
        "--user-approved",
        "--workspace",
        workspace,
        "--state-root",
        stateRoot,
        "--workspace-mode",
        "copy",
        "--goal",
        "Admission startup fixture",
        "--json",
      ],
      {
        encoding: "utf8",
        timeout: INTEGRATION_TIMEOUT,
        env: {
          ...process.env,
          AEG_TEST_MODE: "1",
          AEG_TEST_RUNTIME_CONTROL_ROOT: controlRoot,
          AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        },
      },
    );
    assert.equal(result.status, 1);
    assert.match(`${result.stderr}\n${result.stdout}`, /Runtime admission is busy/i);
    const bucket = workspaceBucket(stateRoot, workspace);
    const runDirs = (await readdir(bucket)).filter((entry) => !entry.startsWith("."));
    assert.equal(runDirs.length, 1);
    const runDir = path.join(bucket, runDirs[0]);
    assert.ok(await readFile(path.join(runDir, "startup-failure.json"), "utf8"));
    assert.equal(await readFile(path.join(runDir, "source-workspace-before.json"), "utf8").catch(() => null), null);
    assert.equal(await readFile(path.join(runDir, "workspace-before.json"), "utf8").catch(() => null), null);
  } finally {
    await release();
  }
});

test("lock acquisition fails closed when a live owner identity is unknown", async (t) => {
  const runDir = await temporaryDirectory(t);
  await writeFile(
    path.join(runDir, ".runner-owner.json"),
    `${JSON.stringify({
      pid: process.pid,
      process_started_at_ms: null,
      runner_path: "graph-runner.mjs",
      acquired_at: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
  await assert.rejects(
    acquireLock(runDir, { identityState: () => "unknown" }),
    /alive but its identity could not be verified/i,
  );
  assert.ok(await readFile(path.join(runDir, ".runner-owner.json"), "utf8"));
});

test("reconcile marks only ownerless running records interrupted and preserves evidence", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  const bucket = workspaceBucket(stateRoot, workspace);

  const writeRun = async (runId) => {
    const directory = path.join(bucket, runId);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "evidence.txt"), `${runId} evidence\n`, "utf8");
    await writeFile(
      path.join(directory, "run.json"),
      `${JSON.stringify({
        run_id: runId,
        workspace,
        goal: "Fixture run",
        created_at: "2026-08-10T00:00:00.000Z",
        updated_at: "2026-08-10T00:00:00.000Z",
        status: "running",
        nodes: { review: { id: "review", status: "running", gate: null } },
        node_order: ["review"],
        options: {},
      })}\n`,
      "utf8",
    );
    return directory;
  };

  const staleDir = await writeRun("stale-run");
  const activeDir = await writeRun("active-run");
  await writeFile(
    path.join(activeDir, ".lock"),
    `${JSON.stringify({
      version: 2,
      pid: process.pid,
      process_started_at_ms: Math.round(Date.now() - process.uptime() * 1_000),
      runner_path: path.resolve(process.argv[1]),
      acquired_at: new Date().toISOString(),
    })}\n`,
    "utf8",
  );

  const reconciled = spawnSync(
    process.execPath,
    [RUNNER, "reconcile", "--workspace", workspace, "--state-root", stateRoot, "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(reconciled.status, 0, reconciled.stderr || reconciled.stdout);
  const output = JSON.parse(reconciled.stdout.trim());
  assert.deepEqual(output.interrupted_runs, ["stale-run"]);
  assert.deepEqual(output.active_runs, ["active-run"]);

  const stale = JSON.parse(await readFile(path.join(staleDir, "run.json"), "utf8"));
  const active = JSON.parse(await readFile(path.join(activeDir, "run.json"), "utf8"));
  assert.equal(stale.status, "interrupted");
  assert.equal(stale.nodes.review.status, "interrupted");
  assert.equal(stale.blocker.type, "HOST_PROCESS_INTERRUPTED");
  assert.equal(active.status, "running");
  assert.equal(await readFile(path.join(staleDir, "evidence.txt"), "utf8"), "stale-run evidence\n");
});

test("resume options retain saved execution settings unless explicitly overridden", () => {
  const defaults = {
    model: null,
    codexModel: null,
    claudeModel: null,
    reasoningEffort: null,
    workspaceReadLanes: 2,
    maxParallel: 2,
    maxReviewNodes: 6,
    maxCorrections: 3,
    timeoutMinutes: 45,
    serviceRetryMinutes: 120,
    queueWaitMinutes: 240,
    isolatedCodexConfig: true,
    agentBackend: "codex",
    agentFallback: true,
    queueScope: "global",
  };
  const saved = {
    options: {
      model: "saved-model",
      codex_model: "saved-codex",
      claude_model: "saved-claude",
      reasoning_effort: "xhigh",
      workspace_read_lanes: 3,
      max_parallel: 6,
      max_review_nodes: 3,
      max_corrections: 8,
      timeout_minutes: 90,
      service_retry_minutes: 17,
      queue_wait_minutes: 33,
      isolated_codex_config: false,
      agent_backend: "claude",
      agent_fallback: false,
      queue_scope: "endpoint",
      user_approved: true,
      user_approved_at: "2026-08-10T00:00:00.000Z",
    },
  };
  const retained = optionsForResume(defaults, {}, saved);
  assert.equal(retained.model, "saved-model");
  assert.equal(retained.codexModel, "saved-codex");
  assert.equal(retained.claudeModel, "saved-claude");
  assert.equal(retained.reasoningEffort, "xhigh");
  assert.equal(retained.workspaceReadLanes, 3);
  assert.equal(retained.maxParallel, 6);
  assert.equal(retained.maxReviewNodes, 3);
  assert.equal(retained.maxCorrections, 8);
  assert.equal(retained.timeoutMinutes, 90);
  assert.equal(retained.serviceRetryMinutes, 17);
  assert.equal(retained.queueWaitMinutes, 33);
  assert.equal(retained.isolatedCodexConfig, false);
  assert.equal(retained.agentBackend, "claude");
  assert.equal(retained.agentFallback, false);
  assert.equal(retained.queueScope, "endpoint");
  const merged = mergeRunOptionsForResume(saved, retained);
  assert.equal(merged.agent_backend, "claude");
  assert.equal(merged.agent_fallback, false);
  assert.equal(merged.queue_scope, "endpoint");
  assert.equal(merged.codex_model, "saved-codex");
  assert.equal(merged.claude_model, "saved-claude");
  assert.equal(merged.reasoning_effort, "xhigh");
  assert.equal(merged.workspace_read_lanes, 3);
  assert.equal(merged.user_approved, true);
  assert.equal(merged.user_approved_at, "2026-08-10T00:00:00.000Z");
  const overridden = optionsForResume({ ...defaults, maxCorrections: 2 }, { "max-corrections": "2" }, saved);
  assert.equal(overridden.maxCorrections, 2);
  assert.equal(optionsForResume({ ...defaults, maxReviewNodes: 2 }, { "max-review-nodes": "2" }, saved).maxReviewNodes, 2);
  const modelOverride = optionsForResume(
    { ...defaults, codexModel: "new-codex", claudeModel: "new-claude", reasoningEffort: "max" },
    { "codex-model": "new-codex", "claude-model": "new-claude", "reasoning-effort": "max" },
    saved,
  );
  assert.equal(modelOverride.codexModel, "new-codex");
  assert.equal(modelOverride.claudeModel, "new-claude");
  assert.equal(modelOverride.reasoningEffort, "max");
});

test("atomic state replacement works repeatedly on Windows-compatible paths", async (t) => {
  const directory = await temporaryDirectory(t);
  const target = path.join(directory, "state.json");
  for (let index = 0; index < 200; index += 1) await atomicWriteJson(target, { index });
  assert.equal(JSON.parse(await readFile(target, "utf8")).index, 199);
});

test("atomic replacement retries only transient Windows sharing conflicts", async () => {
  const seen = [];
  await replaceFileWithRetry("temporary.json", "state.json", {
    attempts: 4,
    baseDelayMs: 1,
    renameFile: async (...paths) => {
      seen.push(paths);
      if (seen.length < 3) throw Object.assign(new Error("temporarily locked"), { code: "EPERM" });
    },
  });
  assert.equal(seen.length, 3);

  let permanentAttempts = 0;
  await assert.rejects(
    replaceFileWithRetry("temporary.json", "state.json", {
      attempts: 4,
      baseDelayMs: 1,
      renameFile: async () => {
        permanentAttempts += 1;
        throw Object.assign(new Error("invalid target"), { code: "EINVAL" });
      },
    }),
    /invalid target/,
  );
  assert.equal(permanentAttempts, 1);
});

test("parallel state saves retain every completed sibling", async (t) => {
  const runDir = await temporaryDirectory(t);
  const run = { updated_at: null, nodes: {}, node_order: [] };
  await Promise.all(
    Array.from({ length: 60 }, async (_, index) => {
      await new Promise((resolve) => setTimeout(resolve, index % 7));
      const id = `review-${index}`;
      run.nodes[id] = { id, status: "completed" };
      run.node_order = [...new Set([...run.node_order, id])];
      await saveRun(runDir, run);
    }),
  );
  const saved = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
  assert.equal(Object.keys(saved.nodes).length, 60);
  assert.equal(saved.node_order.length, 60);
});

test("resume dependency uses the newest completed correction", () => {
  const run = {
    nodes: {
      "correction-r1": { status: "completed" },
      "correction-r2": { status: "runner_error" },
      "correction-r3": { status: "skipped" },
    },
  };
  assert.equal(latestCompletedCorrection(run, 3), "correction-r3");
  assert.equal(latestCompletedCorrection(run, 2), "correction-r1");
  assert.equal(latestCompletedCorrection({ nodes: {} }, 4), "implementation");
});

test("complete graph runs through a fake Codex process and emits auditable evidence", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "broken fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const execution = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--goal",
      "Audit the fixture workspace and exercise every graph stage",
      "--workspace-mode",
      "live",
      "--model",
      "fixture-model",
      "--max-parallel",
      "2",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: { ...process.env, AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]) },
    },
  );
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const summary = JSON.parse(execution.stdout.trim());
  assert.equal(summary.status, "completed");
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  assert.ok(run.node_order.includes("review-behavior"));
  assert.ok(run.node_order.includes("review-risk"));
  assert.ok(run.node_order.includes("verification-r0"));
  assert.ok(run.node_order.includes("independent-review-r0"));
  assert.equal(await readFile(path.join(workspace, "graph-output.txt"), "utf8"), "implemented by fake Codex\n");
  const implementationProof = JSON.parse(
    await readFile(path.join(summary.run_dir, "nodes", "implementation", "proof.json"), "utf8"),
  );
  assert.equal(implementationProof.supplied_skills[0].name, "fixture-review");
  assert.equal(implementationProof.observed_files_changed.includes("graph-output.txt"), true);
  const report = await readFile(summary.report, "utf8");
  assert.match(report, /Status: \*\*completed\*\*/);
  assert.match(report, /fixture-review/);
  assert.match(report, /fake-check verification/);
});

test("stream budget exhaustion waits without retrying or leaving a reservation", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "budget fixture\n", "utf8");
  const execution = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--workspace-mode",
      "live",
      "--goal",
      "Exercise the run token budget guard",
      "--max-run-tokens",
      "100",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
      },
    },
  );
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const summary = JSON.parse(execution.stdout.trim());
  assert.equal(summary.status, "waiting_budget");
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  assert.equal(run.status, "waiting_budget");
  assert.equal(run.nodes.planner.status, "waiting_budget");
  assert.equal(run.budget.observed.reserved_tokens, 0);
  assert.ok(run.budget.observed.token_overrun > 0);
  const attempts = JSON.parse(await readFile(path.join(summary.run_dir, "nodes", "planner", "attempts.json"), "utf8"));
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].budget_exceeded, true);
  assert.equal(attempts[0].retry_scheduled, undefined);
  const runtimeState = JSON.parse(await readFile(path.join(summary.run_dir, "runtime-state.json"), "utf8"));
  assert.equal(runtimeState.status, "waiting_budget");
  const status = spawnSync(
    process.execPath,
    [RUNNER, "status", "--workspace", workspace, "--state-root", stateRoot, "--run", run.run_id, "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(status.status, 0, status.stderr || status.stdout);
  const statusOutput = JSON.parse(status.stdout.trim());
  assert.equal(statusOutput.status, "waiting_budget");
  assert.equal(statusOutput.progress.status, "waiting_budget");
  const watch = spawnSync(
    process.execPath,
    [RUNNER, "watch", "--workspace", workspace, "--state-root", stateRoot, "--run", run.run_id, "--once", "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(watch.status, 0, watch.stderr || watch.stdout);
  const watchOutput = JSON.parse(watch.stdout.trim());
  assert.equal(watchOutput.status, "waiting_budget");
  assert.equal(watchOutput.progress.status, "waiting_budget");
  const events = await readFile(path.join(summary.run_dir, "events", "events.jsonl"), "utf8");
  assert.match(events, /RunBudgetReserved/);
  assert.match(events, /RunBudgetReservationReleased/);
  assert.match(await readFile(summary.report, "utf8"), /waiting_budget|token budget/i);
});

test("a read-only specialist retries one missing Skill application record and then completes", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "broken fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const execution = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--goal",
      "Audit the fixture and prove every selected review Skill was applied",
      "--workspace-mode",
      "live",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_FAKE_SCENARIO: "missing-skill-evidence-once",
      },
    },
  );
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const summary = JSON.parse(execution.stdout.trim());
  assert.equal(summary.status, "completed");
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  assert.equal(run.nodes["review-behavior"].attempts, 2);
  assert.equal(run.skill_retry_state["review-behavior"].retries, 1);
  assert.equal(run.skill_retry_state["review-behavior"].phase, "resolved");
  const result = JSON.parse(
    await readFile(path.join(summary.run_dir, "nodes", "review-behavior", "result.json"), "utf8"),
  );
  assert.equal(result.findings.some((finding) => finding.id === "RUNNER-SKILL-APPLICATION-GAP"), false);
  assert.ok(result.skills_applied.some((skill) => skill.name === "fixture-review"));
});

test("an unproven writer capability blocker is rejected once and the graph continues after a real write", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "broken fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const execution = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--goal",
      "Audit and repair the fixture while proving current-node writer capability",
      "--workspace-mode",
      "live",
      "--model",
      "fixture-model",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_FAKE_SCENARIO: "unproven-capability-blocker",
      },
    },
  );
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const summary = JSON.parse(execution.stdout.trim());
  assert.equal(summary.status, "completed");
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  assert.equal(run.nodes.implementation.attempts, 2);
  assert.equal(run.capability_retry_state.implementation.retries, 1);
  assert.equal(run.capability_retry_state.implementation.phase, "resolved");
  const attempts = JSON.parse(await readFile(path.join(summary.run_dir, "nodes", "implementation", "attempts.json"), "utf8"));
  assert.equal(attempts.length, 2);
  assert.equal(await readFile(path.join(workspace, "graph-output.txt"), "utf8"), "implemented by fake Codex\n");
  const firstResult = JSON.parse(
    await readFile(path.join(summary.run_dir, "nodes", "implementation", "attempts", "attempt-1", "last-message.json"), "utf8"),
  );
  assert.ok(firstResult.blockers.some((blocker) => blocker.type === "SCOPE"));
  const proof = JSON.parse(await readFile(path.join(summary.run_dir, "nodes", "implementation", "proof.json"), "utf8"));
  assert.equal(proof.sandbox, "workspace-write");
  assert.ok(proof.tool_calls.some((call) => call.type === "file_change"));
});

test("finding lineage proves discovery, independent confirmation, repair, verification, review, and associated cost", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "broken fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const execution = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--workspace-mode",
      "live",
      "--state-root",
      stateRoot,
      "--goal",
      "Find, repair, and independently verify the fixture defect",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_FAKE_SCENARIO: "finding-lineage",
      },
    },
  );
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const summary = JSON.parse(execution.stdout.trim());
  assert.equal(summary.status, "completed");
  const lineage = JSON.parse(await readFile(path.join(summary.run_dir, "finding-lineage.json"), "utf8"));
  assert.equal(lineage.findings.length, 1);
  const finding = lineage.findings[0];
  assert.equal(finding.fingerprint, "fixture-shared-defect");
  assert.equal(finding.first_discovered_by, "review-behavior");
  assert.ok(finding.independently_confirmed_by.includes("review-risk"));
  assert.equal(finding.validation, "test_confirmed");
  assert.equal(finding.implementation, "fixed");
  assert.equal(finding.final_review, "fixed");
  assert.equal(finding.reopened_count, 0);
  assert.equal(finding.proven_fixed, true);
  assert.equal(finding.cost_attribution, "associated_node_cost_not_exclusive");
  assert.ok(finding.associated_cost.process_ms > 0);
  assert.ok(finding.associated_cost.usage.input_tokens > 0);

  const completion = JSON.parse(await readFile(path.join(summary.run_dir, "completion.json"), "utf8"));
  assert.equal(completion.finding_lineage, path.join(summary.run_dir, "finding-lineage.json"));
  assert.ok(completion.cost.usage.input_tokens >= finding.associated_cost.usage.input_tokens);
});

test("completed runs cannot reuse stale gates for later workspace changes", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const environment = {
    ...process.env,
    AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
  };
  const started = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--goal",
      "Audit the fixture workspace and exercise completed resume freshness",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: environment },
  );
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const summary = JSON.parse(started.stdout.trim());
  const originalSnapshot = await readFile(path.join(summary.run_dir, "workspace-after.json"), "utf8");
  await writeFile(path.join(workspace, "late-edit.txt"), "added after completion\n", "utf8");
  const resumed = spawnSync(
    process.execPath,
    [RUNNER, "resume", "--workspace", workspace, "--state-root", stateRoot, "--run", summary.run_id, "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: environment },
  );
  assert.equal(resumed.status, 1);
  assert.match(resumed.stderr, /already completed|start a new run/i);
  assert.equal(await readFile(path.join(summary.run_dir, "workspace-after.json"), "utf8"), originalSnapshot);
  assert.doesNotMatch(await readFile(summary.report, "utf8"), /late-edit\.txt/);
});

test("pre-run recovery restores original files and removes graph-created files", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "original user content\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const execution = spawnSync(
    process.execPath,
    [RUNNER, "start", "--user-approved", "--workspace", workspace, "--state-root", stateRoot, "--goal", "Exercise recovery", "--timeout-minutes", "1", "--json"],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_FAKE_SCENARIO: "recovery",
      },
    },
  );
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const summary = JSON.parse(execution.stdout.trim());
  assert.equal(await readFile(path.join(workspace, "fixture.txt"), "utf8"), "changed by fake Codex\n");
  await writeFile(path.join(summary.run_dir, ".lock"), `${process.pid}\n`, "utf8");
  const lockedRestore = spawnSync(
    process.execPath,
    [path.join(summary.run_dir, "recovery", "restore.mjs"), "--run-dir", summary.run_dir],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(lockedRestore.status, 1);
  assert.match(lockedRestore.stderr, /active/);
  await rm(path.join(summary.run_dir, ".lock"));
  const restore = spawnSync(
    process.execPath,
    [path.join(summary.run_dir, "recovery", "restore.mjs"), "--run-dir", summary.run_dir],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(restore.status, 0, restore.stderr || restore.stdout);
  assert.equal(await readFile(path.join(workspace, "fixture.txt"), "utf8"), "original user content\n");
  assert.equal(await readFile(path.join(workspace, "graph-output.txt"), "utf8").catch(() => null), null);
  const purged = spawnSync(
    process.execPath,
    [RUNNER, "purge", "--workspace", workspace, "--state-root", stateRoot, "--run", summary.run_id, "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(purged.status, 0, purged.stderr || purged.stdout);
  assert.equal(JSON.parse(purged.stdout.trim()).status, "purged");
  assert.equal(await readFile(summary.run_dir, "utf8").catch(() => null), null);
});

test("recovery refuses linked parents and never overwrites outside files", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  const runDir = path.join(root, "run");
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(path.join(runDir, "recovery", "pre-run-files", "linked-dir"), { recursive: true });
  await writeFile(path.join(outside, "file.txt"), "after-fixture", "utf8");
  await symlink(outside, path.join(workspace, "linked-dir"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(path.join(runDir, "recovery", "pre-run-files", "linked-dir", "file.txt"), "before-fixture", "utf8");
  const beforeRecord = { kind: "file", sha256: contentHash("before-fixture"), size: 14 };
  const afterRecord = { kind: "file", sha256: contentHash("after-fixture"), size: 13 };
  await writeFile(
    path.join(runDir, "workspace-before.json"),
    `${JSON.stringify({ workspace, files: { "linked-dir/file.txt": beforeRecord } })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(runDir, "workspace-after.json"),
    `${JSON.stringify({ workspace, files: { "linked-dir/file.txt": afterRecord } })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(runDir, "recovery", "metadata.json"),
    `${JSON.stringify({ workspace, git: false, head: null, backed_up_files: ["linked-dir/file.txt"] })}\n`,
    "utf8",
  );
  const restore = spawnSync(process.execPath, [RESTORE, "--run-dir", runDir], {
    encoding: "utf8",
    timeout: INTEGRATION_TIMEOUT,
  });
  assert.equal(restore.status, 1);
  assert.match(restore.stderr, /linked parent/);
  assert.equal(await readFile(path.join(outside, "file.txt"), "utf8"), "after-fixture");
});

test("failed verification is corrected, and resume reconnects to that correction", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "broken fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const baseArgs = [
    RUNNER,
      "start",
      "--user-approved",
      "--workspace",
    workspace,
    "--state-root",
    stateRoot,
    "--goal",
    "Audit the fixture workspace and exercise correction and resume",
    "--max-parallel",
    "2",
    "--timeout-minutes",
    "1",
    "--json",
  ];
  const environment = {
    ...process.env,
    AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
    AEG_FAKE_SCENARIO: "correction",
  };
  const first = spawnSync(process.execPath, baseArgs, { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: environment });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const summary = JSON.parse(first.stdout.trim());
  const runPath = path.join(summary.run_dir, "run.json");
  const run = JSON.parse(await readFile(runPath, "utf8"));
  assert.equal(run.status, "completed");
  assert.equal(run.nodes["verification-r0"].gate, "fail");
  assert.equal(run.nodes["correction-r1"].status, "completed");
  assert.equal(run.nodes["verification-r1"].gate, "pass");
  assert.equal(await readFile(path.join(workspace, "graph-output.txt"), "utf8"), "corrected by fake Codex\n");

  const firstVerificationInput = await readFile(path.join(summary.run_dir, "nodes", "verification-r0", "input.md"), "utf8");
  assert.doesNotMatch(firstVerificationInput, /Incremental re-verification/);
  const incrementalVerificationInput = await readFile(path.join(summary.run_dir, "nodes", "verification-r1", "input.md"), "utf8");
  assert.match(incrementalVerificationInput, /Incremental re-verification after correction round 1/);
  assert.match(incrementalVerificationInput, /incremental verification round only/);
  assert.match(incrementalVerificationInput, /fixture-verification/);
  const completion = JSON.parse(await readFile(path.join(summary.run_dir, "completion.json"), "utf8"));
  const mergedEvaluation = completion.machine_check_evaluation || run.machine_check_evaluation;
  assert.equal(
    mergedEvaluation.checks.find((check) => check.id === "fixture-verification")?.status,
    "pass",
  );

  delete run.nodes["verification-r1"];
  delete run.nodes["independent-review-r1"];
  run.node_order = run.node_order.filter((id) => !["verification-r1", "independent-review-r1"].includes(id));
  run.status = "running";
  run.loop_round = 1;
  run.loop_phase = "correction";
  run.completed_at = null;
  run.report = null;
  await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  await rm(path.join(summary.run_dir, "nodes", "verification-r1"), { recursive: true, force: true });
  await rm(path.join(summary.run_dir, "nodes", "independent-review-r1"), { recursive: true, force: true });

  const resumed = spawnSync(
    process.execPath,
    [
      RUNNER,
      "resume",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--run",
      run.run_id,
      "--timeout-minutes",
      "1",
      "--json",
    ],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: { ...environment, AEG_FAKE_SCENARIO: "happy" } },
  );
  assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
  assert.equal(JSON.parse(resumed.stdout.trim()).status, "completed");
  const resumedInput = await readFile(
    path.join(summary.run_dir, "nodes", "verification-r1", "input.md"),
    "utf8",
  );
  assert.match(resumedInput, /"node": "correction-r1"/);
});

test("planner service failure is reported with evidence and can resume", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const environment = {
    ...process.env,
    AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
    AEG_FAKE_SCENARIO: "planner-always-fails",
  };
  const first = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--goal",
      "Audit the fixture workspace and recover a failed planner",
      "--service-retry-minutes",
      "0",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: environment },
  );
  assert.equal(first.status, 2, first.stderr || first.stdout);
  const blocked = JSON.parse(first.stdout.trim());
  assert.equal(blocked.status, "blocked");
  const attemptsPath = path.join(blocked.run_dir, "nodes", "planner", "attempts.json");
  assert.equal(JSON.parse(await readFile(attemptsPath, "utf8")).length, 2);
  const blockedReport = await readFile(blocked.report, "utf8");
  assert.match(blockedReport, /PLANNER_PROCESS_FAILURE/);
  assert.match(blockedReport, /Planner Process Attempts/);
  assert.match(blockedReport, /attempt-2\/events\.jsonl/);
  await rm(path.join(blocked.run_dir, "graph.json"));

  const resumed = spawnSync(
    process.execPath,
    [
      RUNNER,
      "resume",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--run",
      blocked.run_id,
      "--timeout-minutes",
      "1",
      "--json",
    ],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: { ...environment, AEG_FAKE_SCENARIO: "happy" } },
  );
  assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
  assert.equal(JSON.parse(resumed.stdout.trim()).status, "completed");
  const attempts = JSON.parse(await readFile(attemptsPath, "utf8"));
  assert.equal(attempts.length, 3);
  assert.equal(attempts[2].succeeded, true);
  assert.equal(
    await readFile(path.join(blocked.run_dir, "nodes", "planner", "attempts", "attempt-1", "events.jsonl"), "utf8"),
    await readFile(path.join(blocked.run_dir, "nodes", "planner", "attempts", "attempt-2", "events.jsonl"), "utf8"),
  );
});

test("an early child stdin close is reported without crashing the runner", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const execution = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--goal",
      `Audit the fixture workspace and exercise early stdin closure ${"x".repeat(12_000)}`,
      "--service-retry-minutes",
      "0",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_FAKE_SCENARIO: "exit-before-input",
      },
    },
  );
  assert.equal(execution.status, 2, execution.stderr || execution.stdout);
  assert.doesNotMatch(execution.stderr, /Unhandled 'error' event|write EOF/);
  assert.equal(JSON.parse(execution.stdout.trim()).status, "blocked");
});

test("planner temporary service failures retry through the configured recovery window", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const environment = {
    ...process.env,
    AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
    AEG_FAKE_SCENARIO: "planner-transient-twice",
    AEG_SERVICE_RETRY_BASE_MS: "1",
  };
  const execution = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--goal",
      "Audit the fixture workspace and recover temporary planner service failures",
      "--service-retry-minutes",
      "1",
      "--queue-wait-minutes",
      "1",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: environment },
  );
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const summary = JSON.parse(execution.stdout.trim());
  const attempts = JSON.parse(await readFile(path.join(summary.run_dir, "nodes", "planner", "attempts.json"), "utf8"));
  assert.equal(attempts.length, 3);
  assert.equal(attempts[0].transient, true);
  assert.equal(attempts[1].transient, true);
  assert.equal(attempts[2].succeeded, true);
  assert.equal(attempts[0].retry_scheduled, true);
  assert.equal(attempts[0].model_queue.capacity_outcome, "overload");
  assert.equal(attempts[0].model_queue.capacity_reason, "http_502");
  assert.equal(attempts[2].model_queue.capacity_outcome, "success");
  assert.match(await readFile(summary.report, "utf8"), /Temporary-Failure Recovery/);
});

test("an exhausted shared-capacity wait blocks once without multiplying the wait", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  const queueRoot = path.join(root, "queue");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const slots = await Promise.all([
    acquireModelSlot({ backend: "codex", queueRoot, workspace: path.join(root, "holder-a"), waitMinutes: 1, pollMs: 10 }),
    acquireModelSlot({ backend: "codex", queueRoot, workspace: path.join(root, "holder-b"), waitMinutes: 1, pollMs: 10 }),
  ]);
  try {
    const execution = spawnSync(
      process.execPath,
      [
        RUNNER,
      "start",
      "--user-approved",
      "--workspace",
        workspace,
        "--state-root",
        stateRoot,
        "--goal",
        "Audit the fixture workspace and stop once when the global model queue is exhausted",
        "--service-retry-minutes",
        "1",
        "--queue-wait-minutes",
        "0",
        "--timeout-minutes",
        "1",
        "--json",
      ],
      {
        encoding: "utf8",
        timeout: INTEGRATION_TIMEOUT,
        env: {
          ...process.env,
          AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
          AEG_MODEL_QUEUE_ROOT: queueRoot,
        },
      },
    );
    assert.equal(execution.status, 2, execution.stderr || execution.stdout);
    const summary = JSON.parse(execution.stdout.trim());
    const attempts = JSON.parse(await readFile(path.join(summary.run_dir, "nodes", "planner", "attempts.json"), "utf8"));
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].queue_timeout, true);
    assert.equal(attempts[0].retry_scheduled, false);
    assert.match(await readFile(summary.report, "utf8"), /Shared model capacity wait expired/);
  } finally {
    await Promise.all(slots.map((slot) => slot.release()));
  }
});

test("ordinary nodes retry temporary service failures and preserve every attempt", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const environment = {
    ...process.env,
    AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
    AEG_FAKE_SCENARIO: "node-transient-twice",
    AEG_SERVICE_RETRY_BASE_MS: "1",
  };
  const execution = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--goal",
      "Audit the fixture workspace and recover temporary review service failures",
      "--service-retry-minutes",
      "1",
      "--queue-wait-minutes",
      "1",
      "--max-parallel",
      "1",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: environment },
  );
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const summary = JSON.parse(execution.stdout.trim());
  const attempts = JSON.parse(
    await readFile(path.join(summary.run_dir, "nodes", "review-risk", "attempts.json"), "utf8"),
  );
  assert.equal(attempts.length, 3);
  assert.equal(attempts[0].transient, true);
  assert.equal(attempts[1].transient, true);
  assert.equal(attempts[2].result_recorded, true);
  const report = await readFile(summary.report, "utf8");
  assert.match(report, /review-risk.*attempt 1/);
  assert.match(report, /scheduled retries: [1-9]/);
});

test("three consecutive service failures pause, retain a checkpoint, and resume the same run", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const environment = {
    ...process.env,
    AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
    AEG_FAKE_SCENARIO: "planner-transient-three-checkpoint",
    AEG_SERVICE_RETRY_BASE_MS: "1",
    AEG_FAKE_REQUIRE_HARDENED_ARGS: "1",
  };
  const first = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--goal",
      "Audit the fixture and pause when the model service stays unavailable",
      "--service-retry-minutes",
      "120",
      "--max-service-failures",
      "3",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: environment },
  );
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const paused = JSON.parse(first.stdout.trim());
  assert.equal(paused.status, "waiting_service");
  const run = JSON.parse(await readFile(path.join(paused.run_dir, "run.json"), "utf8"));
  assert.equal(run.run_id, paused.run_id);
  assert.equal(run.blocker.type, "MODEL_SERVICE_UNAVAILABLE");
  assert.equal(run.nodes.planner.status, "waiting_service");
  const attempts = JSON.parse(await readFile(path.join(paused.run_dir, "nodes", "planner", "attempts.json"), "utf8"));
  assert.equal(attempts.length, 3);
  assert.equal(attempts.filter((attempt) => attempt.retry_scheduled).length, 2);
  const checkpointPath = path.join(paused.run_dir, "nodes", "planner", "checkpoint.json");
  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  assert.equal(checkpoint.attempts_aggregated, 3);
  assert.ok(checkpoint.commands.some((command) => command.command === "fake-check partial-planning"));
  assert.ok(checkpoint.messages.some((message) => /project rules/.test(message)));
  const report = await readFile(paused.report, "utf8");
  assert.match(report, /waiting_service/);
  assert.match(report, /Service paused after 3 consecutive temporary failures/);
  assert.match(report, /Input tokens: unknown|input tokens unknown/i);
  const statusResult = spawnSync(
    process.execPath,
    [RUNNER, "status", "--workspace", workspace, "--state-root", stateRoot, "--run", paused.run_id, "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: environment },
  );
  assert.equal(statusResult.status, 0, statusResult.stderr || statusResult.stdout);
  const status = JSON.parse(statusResult.stdout.trim());
  assert.equal(status.runtime.phase, "waiting_service");
  assert.equal(status.runtime.current_node, "planner");
  assert.equal(status.runtime.attempt, 3);
  assert.equal(status.runtime.model_active, false);
  assert.equal(status.runtime.queue_position, null);

  const resumed = spawnSync(
    process.execPath,
    [
      RUNNER,
      "resume",
      "--background",
      "--follow",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--run",
      paused.run_id,
      "--timeout-minutes",
      "1",
      "--interval-seconds",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: { ...environment, AEG_FAKE_SCENARIO: "happy", AEG_DISABLE_NOTIFICATIONS: "1" },
    },
  );
  assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
  const resumeEvents = resumed.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const resumedHandoff = resumeEvents[0];
  const completed = resumeEvents.at(-1);
  assert.equal(resumedHandoff.handoff, "confirmed");
  assert.equal(resumedHandoff.follow, true);
  assert.equal(completed.run_id, paused.run_id);
  assert.equal(completed.status, "completed");
  const resumedPlannerInput = await readFile(path.join(paused.run_dir, "nodes", "planner", "input.md"), "utf8");
  assert.match(resumedPlannerInput, /Prior machine-visible checkpoint/);
  assert.match(resumedPlannerInput, /fake-check partial-planning/);
  const completedReport = await readFile(completed.report, "utf8");
  assert.match(completedReport, /Input tokens: [1-9][0-9]*/);
  assert.match(completedReport, /Output tokens: [1-9][0-9]*/);
});

test("ordinary node service failures pause with reusable machine evidence", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const environment = {
    ...process.env,
    AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
    AEG_FAKE_SCENARIO: "node-transient-three-checkpoint",
    AEG_SERVICE_RETRY_BASE_MS: "1",
  };
  const first = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--goal",
      "Audit the fixture and retain partial discovery evidence",
      "--max-service-failures",
      "3",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: environment },
  );
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const paused = JSON.parse(first.stdout.trim());
  assert.equal(paused.status, "waiting_service");
  const checkpoint = JSON.parse(
    await readFile(path.join(paused.run_dir, "nodes", "discovery", "checkpoint.json"), "utf8"),
  );
  assert.equal(checkpoint.attempts_aggregated, 3);
  assert.ok(checkpoint.commands.some((command) => command.command === "fake-check partial-discovery"));

  const resumed = spawnSync(
    process.execPath,
    [RUNNER, "resume", "--workspace", workspace, "--state-root", stateRoot, "--run", paused.run_id, "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: { ...environment, AEG_FAKE_SCENARIO: "happy" } },
  );
  assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
  assert.equal(JSON.parse(resumed.stdout.trim()).status, "completed");
  const input = await readFile(path.join(paused.run_dir, "nodes", "discovery", "input.md"), "utf8");
  assert.match(input, /Prior machine-visible checkpoint/);
  assert.match(input, /fake-check partial-discovery/);
});

test("concurrent Graph runs overlap across workspaces with fair shared admission", async (t) => {
  const root = await temporaryDirectory(t);
  const workspaceA = path.join(root, "workspace-a");
  const workspaceB = path.join(root, "workspace-b");
  const stateRoot = path.join(root, "state");
  const queueRoot = path.join(root, "queue");
  const guardPath = path.join(root, "active-model.guard");
  await Promise.all([
    mkdir(workspaceA, { recursive: true }),
    mkdir(workspaceB, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(workspaceA, "fixture.txt"), "fixture a\n", "utf8"),
    writeFile(path.join(workspaceB, "fixture.txt"), "fixture b\n", "utf8"),
    writeSkill(path.join(workspaceA, ".codex"), "fixture-review", "Review the graph fixture"),
    writeSkill(path.join(workspaceB, ".codex"), "fixture-review", "Review the graph fixture"),
  ]);
  const environment = {
    ...process.env,
    AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
    AEG_FAKE_SCENARIO: "happy",
    AEG_FAKE_ACTIVE_GUARD: guardPath,
    AEG_FAKE_EXPECT_OVERLAP: "1",
    AEG_FAKE_HOLD_MS: "500",
    AEG_MODEL_QUEUE_ROOT: queueRoot,
  };
  const argsFor = (workspace, goal) => [
      "start",
      "--user-approved",
      "--workspace",
    workspace,
    "--state-root",
    stateRoot,
    "--goal",
    goal,
    "--max-parallel",
    "2",
    "--service-retry-minutes",
    "0",
    "--queue-wait-minutes",
    "1",
    "--timeout-minutes",
    "1",
    "--json",
  ];
  const first = runRunnerAsync(argsFor(workspaceA, "Run graph A"), { env: environment });
  await wait(5);
  const second = runRunnerAsync(argsFor(workspaceB, "Run graph B"), { env: environment });
  const [resultA, resultB] = await Promise.all([first, second]);
  assert.equal(resultA.status, 0, resultA.stderr || resultA.stdout);
  assert.equal(resultB.status, 0, resultB.stderr || resultB.stdout);
  assert.ok(await readFile(`${guardPath}.overlap`, "utf8").catch(() => null), "two workspaces never overlapped");
  const summaryA = JSON.parse(resultA.stdout.trim());
  const summaryB = JSON.parse(resultB.stdout.trim());
  for (const summary of [summaryA, summaryB]) {
    assert.equal(summary.status, "completed");
    const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
    assert.equal(run.options.queue_wait_minutes, 1);
    const attempts = [];
    for (const nodeId of run.node_order) {
      const attemptsPath = path.join(summary.run_dir, "nodes", nodeId, "attempts.json");
      if (await readFile(attemptsPath, "utf8").catch(() => null)) {
        attempts.push(...JSON.parse(await readFile(attemptsPath, "utf8")));
      }
    }
    assert.ok(attempts.some((attempt) => (attempt.model_queue?.wait_ms || 0) > 0));
    assert.match(await readFile(summary.report, "utf8"), /Model concurrency: adaptive shared capacity/);
  }
});

test("one Graph run overlaps read-only reviews while source writers and validation remain exclusive", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  const queueRoot = path.join(root, "queue");
  const guardPath = path.join(root, "active-model.guard");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const execution = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--goal",
      "Audit the fixture with parallel independent reviews",
      "--max-parallel",
      "2",
      "--workspace-read-lanes",
      "2",
      "--queue-wait-minutes",
      "1",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_FAKE_SCENARIO: "happy",
        AEG_FAKE_ACTIVE_GUARD: guardPath,
        AEG_FAKE_EXPECT_OVERLAP: "1",
        AEG_FAKE_HOLD_MS: "500",
        AEG_MODEL_QUEUE_ROOT: queueRoot,
        AEG_MODEL_CAPACITY_INITIAL: "2",
      },
    },
  );
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const summary = JSON.parse(execution.stdout.trim());
  assert.equal(summary.status, "completed");
  assert.ok(await readFile(`${guardPath}.overlap`, "utf8").catch(() => null), "read-only review nodes never overlapped");
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  assert.equal(run.options.max_parallel, 2);
  assert.equal(run.options.workspace_read_lanes, 2);
  const graph = JSON.parse(await readFile(path.join(summary.run_dir, "graph.json"), "utf8"));
  const sourceWriterNodeIds = new Set(graph.nodes.filter((node) => node.write_access === true).map((node) => node.id));
  assert.deepEqual([...sourceWriterNodeIds], ["implementation"]);
  const sourceWriterAttempts = [];
  for (const nodeId of run.node_order.filter((id) => sourceWriterNodeIds.has(id))) {
    const attempts = await readFile(path.join(summary.run_dir, "nodes", nodeId, "attempts.json"), "utf8").catch(() => null);
    if (attempts) sourceWriterAttempts.push(...JSON.parse(attempts));
  }
  assert.ok(sourceWriterAttempts.every((attempt) => attempt.model_queue?.access_mode === "write"));
  const verificationAttempts = JSON.parse(
    await readFile(path.join(summary.run_dir, "nodes", "verification-r0", "attempts.json"), "utf8"),
  );
  assert.ok(verificationAttempts.length > 0);
  assert.ok(verificationAttempts.every((attempt) => attempt.model_queue?.access_mode === "write"));
  const independentAttempts = JSON.parse(
    await readFile(path.join(summary.run_dir, "nodes", "independent-review-r0", "attempts.json"), "utf8"),
  );
  assert.ok(independentAttempts.length > 0);
  assert.ok(independentAttempts.every((attempt) => attempt.model_queue?.access_mode === "write"));
});

test("stop interrupts a capacity wait, preserves evidence, and resumes the exact run", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  const queueRoot = path.join(root, "queue");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const capacityConfig = { initial: 2, minimum: 1, maximum: 4, successThreshold: 8, cooldownMs: 0 };
  const heldA = await acquireModelSlot({
    queueRoot,
    workspace: path.join(root, "holder-a"),
    capacityConfig,
    waitMinutes: 1,
    pollMs: 10,
  });
  const heldB = await acquireModelSlot({
    queueRoot,
    workspace: path.join(root, "holder-b"),
    capacityConfig,
    waitMinutes: 1,
    pollMs: 10,
  });
  const environment = {
    ...process.env,
    AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
    AEG_MODEL_QUEUE_ROOT: queueRoot,
    AEG_MODEL_QUEUE_POLL_MS: "10",
  };
  const startedPromise = runRunnerAsync(
    [
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--goal",
      "Audit the fixture and allow the owner to stop a queued run",
      "--queue-wait-minutes",
      "1",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    { env: environment, timeout: 15_000 },
  );
  const selected = await waitFor(async () => (await listRuns(stateRoot, workspace))[0] || null, {
    message: "queued run state",
  });
  await waitFor(async () => {
    const queue = await inspectModelQueue({ queueRoot, capacityConfig });
    const identity = await realpath(workspace);
    return queue.waiting.some((request) => request.workspace_key === createHash("sha256").update(
      process.platform === "win32" ? identity.toLowerCase() : identity,
    ).digest("hex"));
  }, { message: "workspace queue request" });
  const queuedStatus = spawnSync(
    process.execPath,
    [RUNNER, "status", "--workspace", workspace, "--state-root", stateRoot, "--run", selected.run.run_id, "--json"],
    { encoding: "utf8", timeout: 10_000, env: environment },
  );
  assert.equal(queuedStatus.status, 0, queuedStatus.stderr || queuedStatus.stdout);
  const queuedRuntime = JSON.parse(queuedStatus.stdout.trim()).runtime;
  assert.equal(queuedRuntime.phase, "queued");
  assert.equal(queuedRuntime.current_node, "planner");
  assert.ok(queuedRuntime.queue_position >= 1);
  assert.equal(queuedRuntime.model_active, false);

  const stopStartedAt = Date.now();
  const stopped = spawnSync(
    process.execPath,
    [
      RUNNER,
      "stop",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--run",
      selected.run.run_id,
      "--stop-wait-seconds",
      "5",
      "--json",
    ],
    { encoding: "utf8", timeout: 10_000, env: environment },
  );
  assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  assert.ok(Date.now() - stopStartedAt < 5_000, stopped.stdout);
  const stopSummary = JSON.parse(stopped.stdout.trim());
  assert.equal(stopSummary.status, "interrupted");
  const started = await startedPromise;
  assert.equal(started.status, 0, started.stderr || started.stdout);
  assert.equal(JSON.parse(started.stdout.trim()).status, "interrupted");
  await Promise.all([heldA.release(), heldB.release()]);

  const interrupted = JSON.parse(await readFile(path.join(selected.directory, "run.json"), "utf8"));
  assert.equal(interrupted.blocker.type, "OWNER_STOPPED");
  const interruptedReport = await readFile(interrupted.report, "utf8");
  assert.match(interruptedReport, /Resume this exact run/);
  assert.match(interruptedReport, /Model attempts observed: 1/);
  const interruptedAttempts = JSON.parse(
    await readFile(path.join(selected.directory, "nodes", "planner", "attempts.json"), "utf8"),
  );
  assert.equal(interruptedAttempts[0].interrupted, true);
  assert.equal(interruptedAttempts[0].model_queue.status, "interrupted");
  const resumed = spawnSync(
    process.execPath,
    [
      RUNNER,
      "resume",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--run",
      selected.run.run_id,
      "--queue-wait-minutes",
      "1",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: environment },
  );
  assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
  assert.equal(JSON.parse(resumed.stdout.trim()).status, "completed");
});

test("stop terminates an active model child even when the run lock is lost", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  const queueRoot = path.join(root, "queue");
  const guardPath = path.join(root, "active-model.guard");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const environment = {
    ...process.env,
    AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
    AEG_MODEL_QUEUE_ROOT: queueRoot,
    AEG_MODEL_QUEUE_POLL_MS: "10",
    AEG_FAKE_ACTIVE_GUARD: guardPath,
    AEG_FAKE_HOLD_MS: "60000",
  };
  const startedPromise = runRunnerAsync(
    [
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--goal",
      "Audit the fixture and stop an active model child",
      "--queue-wait-minutes",
      "1",
      "--timeout-minutes",
      "2",
      "--json",
    ],
    { env: environment, timeout: 15_000 },
  );
  const selected = await waitFor(async () => (await listRuns(stateRoot, workspace))[0] || null, {
    message: "active run state",
  });
  await waitFor(async () => {
    const queue = await inspectModelQueue({ queueRoot });
    return queue.active.some((lease) => Number.isInteger(lease.child_pid) && lease.child_pid > 0);
  }, { message: "active model child", timeout: ACTIVE_MODEL_START_TIMEOUT });
  await rm(path.join(selected.directory, ".lock"), { force: true });

  const stopped = spawnSync(
    process.execPath,
    [
      RUNNER,
      "stop",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--run",
      selected.run.run_id,
      "--stop-wait-seconds",
      "5",
      "--json",
    ],
    { encoding: "utf8", timeout: 10_000, env: environment },
  );
  assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  assert.equal(JSON.parse(stopped.stdout.trim()).status, "interrupted");
  const started = await startedPromise;
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const queue = await inspectModelQueue({ queueRoot });
  assert.equal(queue.active.length, 0);
  assert.equal(queue.waiting.length, 0);
});

test("stop --force recovers an exact legacy runner that cannot acknowledge the stop marker", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  const created = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--dry-run",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--goal",
      "Audit the fixture for a legacy force-stop exercise",
      "--json",
    ],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(created.status, 0, created.stderr || created.stdout);
  const summary = JSON.parse(created.stdout.trim());
  const runPath = path.join(summary.run_dir, "run.json");
  const run = JSON.parse(await readFile(runPath, "utf8"));
  run.status = "running";
  await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");

  const legacyRunner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    windowsHide: true,
    stdio: "ignore",
  });
  t.after(() => {
    if (legacyRunner.exitCode === null && legacyRunner.signalCode === null) legacyRunner.kill();
  });
  await writeFile(
    path.join(summary.run_dir, ".lock"),
    `${JSON.stringify({
      version: 2,
      pid: legacyRunner.pid,
      process_started_at_ms: Date.now(),
      runner_path: process.execPath,
      acquired_at: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
  const stopped = spawnSync(
    process.execPath,
    [
      RUNNER,
      "stop",
      "--force",
      "--stop-wait-seconds",
      "0",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--run",
      summary.run_id,
      "--json",
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
  assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  assert.equal(JSON.parse(stopped.stdout.trim()).status, "interrupted");
  await waitFor(() => legacyRunner.exitCode !== null || legacyRunner.signalCode !== null, { message: "legacy runner termination" });
  assert.equal(JSON.parse(await readFile(runPath, "utf8")).blocker.type, "OWNER_STOPPED");
});

test("ordinary node process failure is reported, unlocked, and resumable", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const environment = {
    ...process.env,
    AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
    AEG_FAKE_SCENARIO: "node-always-fails",
  };
  const first = spawnSync(
    process.execPath,
    [RUNNER, "start", "--user-approved", "--workspace", workspace, "--state-root", stateRoot, "--goal", "Recover a failed review", "--timeout-minutes", "1", "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: environment },
  );
  assert.equal(first.status, 2, first.stderr || first.stdout);
  const blocked = JSON.parse(first.stdout.trim());
  assert.equal(blocked.status, "completed_with_gaps");
  const blockedCompletion = JSON.parse(await readFile(path.join(blocked.run_dir, "completion.json"), "utf8"));
  assert.match(blockedCompletion.resume_command, /resume .*--run/);
  const report = await readFile(blocked.report, "utf8");
  assert.match(report, /NODE_PROCESS_FAILURE/);
  assert.match(report, /review-risk/);
  assert.match(report, /Runner Errors/);
  assert.equal(await readFile(path.join(blocked.run_dir, ".lock"), "utf8").catch(() => null), null);
  assert.equal((await readdir(blocked.run_dir, { recursive: true })).some((entry) => entry.includes("raw-last-message")), false);

  const resumed = spawnSync(
    process.execPath,
    [RUNNER, "resume", "--workspace", workspace, "--state-root", stateRoot, "--run", blocked.run_id, "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: { ...environment, AEG_FAKE_SCENARIO: "happy" } },
  );
  assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
  assert.equal(JSON.parse(resumed.stdout.trim()).status, "completed");
});

test("recorded read-only blockers flow into synthesis and later gates", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const execution = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--goal",
      "Audit the fixture workspace and continue after a recorded read-only evidence gap",
      "--max-parallel",
      "2",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_FAKE_SCENARIO: "recorded-blocker",
      },
    },
  );
  assert.equal(execution.status, 2, execution.stderr || execution.stdout);
  const summary = JSON.parse(execution.stdout.trim());
  assert.equal(summary.status, "completed_with_gaps");
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  assert.equal(run.nodes["review-behavior"].status, "blocked");
  assert.equal(run.nodes.synthesis.status, "completed");
  assert.equal(run.nodes.implementation.status, "completed");
  assert.equal(run.nodes["verification-r0"].status, "completed");
  assert.equal(run.nodes["independent-review-r0"].status, "completed");
  const report = await readFile(summary.report, "utf8");
  assert.match(report, /EVIDENCE_GAP/);
});

test("synthesis authorization blockers produce an exact owner scope", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const execution = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--goal",
      "Audit the fixture workspace and continue after a synthesis authorization blocker",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_FAKE_SCENARIO: "synthesis-owner-gate",
      },
    },
  );
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const summary = JSON.parse(execution.stdout.trim());
  assert.equal(summary.status, "waiting_owner");
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  assert.match(run.plan.owner_gate.reason, /synthesized fixture change/i);
  assert.match(run.plan.owner_gate.authorization_scope, /synthesized fixture change/i);
  assert.equal(run.nodes.implementation, undefined);
});

test("broad audit routes through the installed graph specialist pack", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  const execution = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--goal",
      "Broadly audit and automatically repair this workspace",
      "--max-parallel",
      "4",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_CLAUDE_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_FAKE_SCENARIO: "specialist-routing",
      },
    },
  );
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const summary = JSON.parse(execution.stdout.trim());
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  assert.deepEqual(run.plan.discovery_skills, ["graph-requirements-design"]);
  assert.deepEqual(run.plan.implementation_skills, [
    "graph-engineering-quality",
    "graph-product-quality",
    "graph-experience-quality",
  ]);
  assert.deepEqual(run.plan.verification_skills, ["graph-release-assurance"]);
  const expectedReviews = {
    "review-engineering": "graph-engineering-quality",
    "review-product": "graph-product-quality",
    "review-experience": "graph-experience-quality",
    "review-security": "graph-security-privacy",
  };
  for (const [node, skill] of Object.entries(expectedReviews)) {
    const proof = JSON.parse(await readFile(path.join(summary.run_dir, "nodes", node, "proof.json"), "utf8"));
    assert.equal(proof.supplied_skills[0].name, skill);
    assert.ok(proof.supplied_skills[0].references.length >= 1);
    const input = await readFile(path.join(summary.run_dir, "nodes", node, "input.md"), "utf8");
    assert.match(input, new RegExp(skill));
    assert.match(input, /<required_reference/);
  }
  const verificationProof = JSON.parse(
    await readFile(path.join(summary.run_dir, "nodes", "verification-r0", "proof.json"), "utf8"),
  );
  assert.equal(verificationProof.supplied_skills[0].name, "graph-release-assurance");
  assert.equal(verificationProof.supplied_skills[0].references.length, 2);
  const controllerBundle = verificationProof.supplied_skills.find((skill) => skill.name === "autonomous-engineering-graph");
  assert.equal(controllerBundle.controller_enforced, true);
  assert.equal(controllerBundle.logical_path, "runner://node-runtime-contract.md");
  assert.equal(controllerBundle.references.length, 0);
  const verificationInput = await readFile(path.join(summary.run_dir, "nodes", "verification-r0", "input.md"), "utf8");
  assert.match(verificationInput, /<controller_contract/);
  assert.match(verificationInput, /runner:\/\/node-runtime-contract\.md/);
  assert.match(verificationInput, /Do not put autonomous-engineering-graph in skills_applied/);
  assert.match(verificationInput, /copy the complete literal command string you submitted in the successful tool call/);
  assert.doesNotMatch(verificationInput, /[A-Z]:\\[^\n"]*autonomous-engineering-graph/i);
  assert.doesNotMatch(verificationInput, /## Capacity And Service Failure/);
  assert.ok(Buffer.byteLength(verificationInput) < 90_000, `verification input was ${Buffer.byteLength(verificationInput)} bytes`);
  const independentProof = JSON.parse(
    await readFile(path.join(summary.run_dir, "nodes", "independent-review-r0", "proof.json"), "utf8"),
  );
  assert.equal(independentProof.supplied_skills[0].name, "graph-release-assurance");
  const independentInput = await readFile(path.join(summary.run_dir, "nodes", "independent-review-r0", "input.md"), "utf8");
  assert.match(independentInput, /copy the complete literal command string you submitted in the successful tool call/);
  assert.ok(Buffer.byteLength(independentInput) < 90_000, `independent-review input was ${Buffer.byteLength(independentInput)} bytes`);
  const report = await readFile(summary.report, "utf8");
  for (const skill of Object.values(expectedReviews)) assert.match(report, new RegExp(skill));
  assert.match(report, /graph-release-assurance/);
});

test("a synthesis-derived owner gate requires explicit scoped authorization before implementation", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const environment = {
    ...process.env,
    AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
    AEG_FAKE_SCENARIO: "synthesis-owner-gate",
  };
  const started = spawnSync(
    process.execPath,
    [RUNNER, "start", "--user-approved", "--workspace", workspace, "--state-root", stateRoot, "--goal", "Change authentication", "--timeout-minutes", "1", "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: environment },
  );
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const waiting = JSON.parse(started.stdout.trim());
  assert.equal(waiting.status, "waiting_owner");
  let run = JSON.parse(await readFile(path.join(waiting.run_dir, "run.json"), "utf8"));
  assert.equal(run.nodes.implementation, undefined);

  const withoutAuthorization = spawnSync(
    process.execPath,
    [RUNNER, "resume", "--workspace", workspace, "--state-root", stateRoot, "--run", waiting.run_id, "--timeout-minutes", "1", "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: environment },
  );
  assert.equal(withoutAuthorization.status, 0, withoutAuthorization.stderr || withoutAuthorization.stdout);
  assert.equal(JSON.parse(withoutAuthorization.stdout.trim()).status, "waiting_owner");

  const unrelatedScope = "Approve an unrelated payment documentation change";
  const unrelated = spawnSync(
    process.execPath,
    [RUNNER, "resume", "--workspace", workspace, "--state-root", stateRoot, "--run", waiting.run_id, "--authorize", unrelatedScope, "--timeout-minutes", "1", "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: environment },
  );
  assert.equal(unrelated.status, 0, unrelated.stderr || unrelated.stdout);
  assert.equal(JSON.parse(unrelated.stdout.trim()).status, "waiting_owner");

  run = JSON.parse(await readFile(path.join(waiting.run_dir, "run.json"), "utf8"));
  const scope = run.plan.owner_gate.authorization_scope;
  const authorized = spawnSync(
    process.execPath,
    [RUNNER, "resume", "--workspace", workspace, "--state-root", stateRoot, "--run", waiting.run_id, "--authorize", scope, "--timeout-minutes", "1", "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: environment },
  );
  assert.equal(authorized.status, 0, authorized.stderr || authorized.stdout);
  const completed = JSON.parse(authorized.stdout.trim());
  assert.equal(completed.status, "completed");
  run = JSON.parse(await readFile(path.join(waiting.run_dir, "run.json"), "utf8"));
  assert.equal(run.authorizations.length, 2);
  assert.equal(run.authorizations[0].scope, unrelatedScope);
  assert.equal(run.authorizations[1].scope, scope);
  assert.ok((await readFile(path.join(waiting.run_dir, "nodes", "implementation", "input.md"), "utf8")).includes(scope));
  assert.match(await readFile(completed.report, "utf8"), /Explicit Owner Authorizations/);
});

test("stage supervisors can reject once, correct only their owning stage, and then pass", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const result = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--workspace-mode",
      "live",
      "--state-root",
      stateRoot,
      "--goal",
      "Audit and repair the fixture with stage supervision",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_FAKE_SCENARIO: "supervision-correction",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout.trim());
  assert.equal(summary.status, "completed");
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  assert.equal(run.nodes["planner-supervision"].gate, "fail");
  assert.equal(run.nodes["planner-supervision-r1"].gate, "pass");
  assert.equal(run.nodes["synthesis-supervision"].gate, "fail");
  assert.equal(run.nodes["synthesis-correction-r1"].status, "completed");
  assert.equal(run.nodes["synthesis-supervision-r1"].gate, "pass");
  assert.equal(run.nodes["implementation-supervision"].gate, "fail");
  assert.equal(run.nodes["correction-r1"].status, "completed");
  assert.equal(run.nodes["implementation-supervision-r1"].gate, "pass");
  assert.deepEqual(
    Object.fromEntries(Object.entries(run.supervision_state).map(([stage, state]) => [stage, state.phase])),
    { planner: "passed", synthesis: "passed", implementation: "passed" },
  );
  const synthesisCorrectionInput = await readFile(
    path.join(summary.run_dir, "nodes", "synthesis-correction-r1", "input.md"),
    "utf8",
  );
  assert.match(synthesisCorrectionInput, /"node": "synthesis"/);
  assert.match(synthesisCorrectionInput, /"node": "synthesis-supervision"/);
  assert.doesNotMatch(synthesisCorrectionInput, /"node": "review-behavior"/);
  assert.doesNotMatch(synthesisCorrectionInput, /"node": "review-risk"/);
  assert.ok(
    Buffer.byteLength(synthesisCorrectionInput) < 35_000,
    `synthesis correction input was ${Buffer.byteLength(synthesisCorrectionInput)} bytes`,
  );
});

test("planner correction stops before a second supervision call when it makes no progress", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the fixture");
  const result = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--workspace-mode",
      "live",
      "--state-root",
      stateRoot,
      "--goal",
      "Audit the fixture and reject a planner that repeats an unchanged plan",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_FAKE_SCENARIO: "planner-no-progress",
      },
    },
  );
  assert.equal(result.status, 2, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout.trim());
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  assert.equal(run.status, "completed_with_gaps");
  assert.equal(run.blocker.type, "SUPERVISION_CORRECTION_NO_PROGRESS");
  assert.equal(run.nodes["planner-supervision-r1"], undefined);
});

test("retryable implementation failure enters bounded correction before verification", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the fixture");
  const result = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--workspace-mode",
      "live",
      "--state-root",
      stateRoot,
      "--goal",
      "Audit and repair the fixture after an implementation test failure",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_FAKE_SCENARIO: "implementation-failure",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout.trim());
  assert.equal(summary.status, "completed");
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  assert.equal(run.nodes.implementation.status, "needs_retry");
  assert.equal(run.nodes["implementation-supervision"].gate, "fail");
  assert.equal(run.nodes["correction-r1"].status, "completed");
  assert.equal(run.nodes["implementation-supervision-r1"].gate, "pass");
  assert.equal(run.nodes["verification-r1"].gate, "pass");
  assert.equal(run.nodes["independent-review-r1"].gate, "pass");
  assert.equal(await readFile(path.join(workspace, "graph-output.txt"), "utf8"), "corrected by fake Codex\n");
});

test("supervision-off still gives a retryable implementation failure one bounded correction", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the fixture");
  const result = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--workspace-mode",
      "live",
      "--supervision",
      "off",
      "--state-root",
      stateRoot,
      "--goal",
      "Repair a fixture with supervision disabled",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_FAKE_SCENARIO: "implementation-failure",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout.trim());
  assert.equal(summary.status, "completed");
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  assert.equal(run.nodes.implementation.status, "needs_retry");
  assert.equal(run.nodes["correction-r1"].status, "completed");
  assert.equal(run.nodes["verification-r1"].gate, "pass");
  assert.equal(run.nodes["independent-review-r1"].gate, "pass");
  assert.equal(run.supervision_state.implementation, undefined);
});

test("a deferred synthesis authorization finding does not create an owner gate", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const execution = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--goal",
      "Audit and repair repository-local issues while deferring production deployment",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_FAKE_SCENARIO: "deferred-synthesis-owner-gate",
      },
    },
  );
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const summary = JSON.parse(execution.stdout.trim());
  assert.equal(summary.status, "completed");
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  assert.equal(run.plan.owner_gate.required, false);
  assert.equal(run.nodes.implementation.status, "completed");
  const synthesis = JSON.parse(await readFile(path.join(summary.run_dir, "nodes", "synthesis", "result.json"), "utf8"));
  assert.equal(synthesis.blockers.length, 0);
  assert.equal(synthesis.deferred_protected_actions.length, 1);
});

test("a StorePulse-shaped high-risk audit plan completes without a false owner gate or impossible checks", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");

  const execution = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--goal",
      "Comprehensively audit and reversibly repair the current frozen StorePulse-like workspace without deploy, publish, destructive data actions, or source-workspace merge.",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_CLAUDE_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_FAKE_SCENARIO: "storepulse-plan",
      },
    },
  );

  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const summary = JSON.parse(execution.stdout.trim());
  assert.equal(summary.status, "completed");
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  assert.equal(run.plan.risk_level, "high");
  assert.equal(run.plan.owner_gate.required, false);
  assert.deepEqual(run.plan.required_checks.map((check) => check.id), ["fixture-verification"]);
  assert.ok(run.plan.excluded_surfaces.some((entry) => entry.surface === "miniprogram-rendered-probe"));
  assert.equal(run.plan.excluded_surfaces.some((entry) => entry.surface === "independent-release-review"), false);
  assert.deepEqual(
    Object.fromEntries(Object.entries(run.supervision_state).map(([stage, state]) => [stage, state.phase])),
    { planner: "passed", synthesis: "passed", implementation: "passed" },
  );
  assert.equal(run.nodes["verification-r0"].gate, "pass");
  assert.equal(run.nodes["independent-review-r0"].gate, "pass");
  const supervisionInput = await readFile(path.join(summary.run_dir, "nodes", "planner-supervision", "input.md"), "utf8");
  const supervisionProof = JSON.parse(await readFile(path.join(summary.run_dir, "nodes", "planner-supervision", "proof.json"), "utf8"));
  const supervisionQueue = JSON.parse(await readFile(path.join(summary.run_dir, "nodes", "planner-supervision", "attempts", "attempt-1", "model-queue.json"), "utf8"));
  assert.match(supervisionInput, /controller_managed_graph/);
  assert.match(supervisionInput, /planner cannot create an owner gate/i);
  assert.match(supervisionInput, /Do not call tools, run commands, inspect the repository/);
  assert.doesNotMatch(supervisionInput, /## Capacity And Service Failure/);
  assert.doesNotMatch(supervisionInput, /## Workspace Isolation/);
  assert.ok(Buffer.byteLength(supervisionInput) < 30_000, `supervision input was ${Buffer.byteLength(supervisionInput)} bytes`);
  assert.deepEqual(supervisionProof.commands, []);
  assert.equal(supervisionQueue.workspace_key, run.nodes.discovery.model_queue.workspace_key);
  assert.match(await readFile(summary.report, "utf8"), /- Status: \*\*completed\*\*/);
});

test("role model and effort settings reach the intended child attempts and survive in evidence", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const result = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--workspace-mode",
      "live",
      "--state-root",
      stateRoot,
      "--goal",
      "Audit and repair the role routing fixture",
      "--role-model",
      "planner=strong-planner",
      "--role-model",
      "codex.planner=codex-strong-planner",
      "--role-model",
      "supervisor=strong-supervisor",
      "--role-model",
      "review=standard-review",
      "--role-effort",
      "planner=xhigh,supervisor=high,review=low",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: { ...process.env, AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]) },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout.trim());
  const planner = JSON.parse(await readFile(path.join(summary.run_dir, "nodes", "planner", "attempts.json"), "utf8"));
  const supervisor = JSON.parse(await readFile(path.join(summary.run_dir, "nodes", "planner-supervision", "attempts.json"), "utf8"));
  const review = JSON.parse(await readFile(path.join(summary.run_dir, "nodes", "review-behavior", "attempts.json"), "utf8"));
  assert.equal(planner[0].requested_model, "codex-strong-planner");
  assert.equal(planner[0].requested_reasoning_effort, "xhigh");
  assert.equal(supervisor[0].requested_model, "strong-supervisor");
  assert.equal(supervisor[0].requested_reasoning_effort, "high");
  assert.equal(review[0].requested_model, "standard-review");
  assert.equal(review[0].requested_reasoning_effort, "low");
});

test("failed worktree materialization removes its directory and Git registration", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const runDir = path.join(root, "state", "run");
  const executionRoot = path.join(root, "isolated");
  await mkdir(workspace, { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  for (const args of [
    ["init"],
    ["add", "fixture.txt"],
    ["-c", "user.name=Graph Test", "-c", "user.email=graph@example.invalid", "commit", "-m", "fixture"],
  ]) {
    const git = spawnSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true });
    assert.equal(git.status, 0, git.stderr || git.stdout);
  }
  const manifest = await captureWorkspaceManifest(workspace);
  manifest.files["zz-missing-overlay.txt"] = {
    kind: "file",
    sha256: contentHash("missing\n"),
    size: 8,
    mode: 0o100644,
  };

  await assert.rejects(
    createFrozenWorkspace(workspace, runDir, "worktree", manifest, { executionRoot }),
    /zz-missing-overlay|ENOENT|no such file/i,
  );
  const worktrees = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: workspace,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(worktrees.status, 0, worktrees.stderr || worktrees.stdout);
  assert.doesNotMatch(worktrees.stdout, new RegExp(executionRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  assert.deepEqual(await readdir(executionRoot).catch(() => []), []);
});

test("isolated worktree creation disables repository post-checkout hooks", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const runDir = path.join(root, "state", "run");
  const executionRoot = path.join(root, "isolated");
  const hookDirectory = path.join(root, "hooks");
  const marker = path.join(root, "hook-ran.txt");
  await mkdir(workspace, { recursive: true });
  await mkdir(hookDirectory, { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  for (const args of [
    ["init"],
    ["add", "fixture.txt"],
    ["-c", "user.name=Graph Test", "-c", "user.email=graph@example.invalid", "commit", "-m", "fixture"],
  ]) {
    const git = spawnSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true });
    assert.equal(git.status, 0, git.stderr || git.stdout);
  }
  await writeFile(
    path.join(hookDirectory, "post-checkout"),
    "#!/bin/sh\nnode -e \"require('fs').writeFileSync(process.env.GRAPH_HOOK_MARKER, 'HOOK_RAN\\n')\"\n",
    "utf8",
  );
  if (process.platform !== "win32") await chmod(path.join(hookDirectory, "post-checkout"), 0o755);
  const configured = spawnSync("git", ["-C", workspace, "config", "core.hooksPath", hookDirectory], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(configured.status, 0, configured.stderr || configured.stdout);
  const previousMarker = process.env.GRAPH_HOOK_MARKER;
  process.env.GRAPH_HOOK_MARKER = marker;
  let isolation = null;
  try {
    const manifest = await captureWorkspaceManifest(workspace);
    isolation = await createFrozenWorkspace(workspace, runDir, "worktree", manifest, { executionRoot });
    assert.equal(await readFile(marker, "utf8").catch(() => null), null);
  } finally {
    if (previousMarker === undefined) delete process.env.GRAPH_HOOK_MARKER;
    else process.env.GRAPH_HOOK_MARKER = previousMarker;
    if (isolation) {
      await removeFrozenWorkspace({
        sourceWorkspace: workspace,
        executionWorkspace: isolation.execution_workspace,
        mode: isolation.mode,
        managedRoot: isolation.managed_root,
        managedKey: isolation.managed_key,
      });
    }
  }
});

test("isolated Git operations disable filters and fsmonitor without losing dirty status", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const runDir = path.join(root, "state", "run");
  const executionRoot = path.join(root, "isolated");
  const filterScript = path.join(root, "filter.mjs");
  const fsmonitorScript = path.join(root, "fsmonitor.mjs");
  const filterMarker = path.join(root, "filter-ran.txt");
  const fsmonitorMarker = path.join(root, "fsmonitor-ran.txt");
  await mkdir(workspace, { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(workspace, ".gitattributes"), "fixture.txt filter=graph-isolation\n", "utf8");
  await writeFile(path.join(workspace, "fixture.txt"), "committed fixture\n", "utf8");
  await writeFile(
    filterScript,
    "import { appendFileSync, readFileSync } from 'node:fs';\n" +
      "appendFileSync(process.env.GRAPH_FILTER_MARKER, 'FILTER_RAN\\n');\n" +
      "process.stdout.write(readFileSync(0));\n",
    "utf8",
  );
  await writeFile(
    fsmonitorScript,
    "import { appendFileSync } from 'node:fs';\n" +
      "appendFileSync(process.env.GRAPH_FSMONITOR_MARKER, 'FSMONITOR_RAN\\n');\n",
    "utf8",
  );
  for (const args of [
    ["init"],
    ["add", ".gitattributes", "fixture.txt"],
    ["-c", "user.name=Graph Test", "-c", "user.email=graph@example.invalid", "commit", "-m", "fixture"],
  ]) {
    const git = spawnSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true });
    assert.equal(git.status, 0, git.stderr || git.stdout);
  }
  const commandForGit = (script) =>
    [process.execPath, script]
      .map((value) => `"${value.replace(/\\/g, "/").replace(/"/g, '\\"')}"`)
      .join(" ");
  for (const [key, value] of [
    ["filter.graph-isolation.clean", commandForGit(filterScript)],
    ["filter.graph-isolation.smudge", commandForGit(filterScript)],
    ["filter.graph-isolation.process", commandForGit(filterScript)],
    ["filter.graph-isolation.required", "true"],
    ["core.fsmonitor", commandForGit(fsmonitorScript)],
  ]) {
    const configured = spawnSync("git", ["-C", workspace, "config", key, value], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(configured.status, 0, configured.stderr || configured.stdout);
  }
  await writeFile(path.join(workspace, "fixture.txt"), "dirty launch snapshot\n", "utf8");

  const previousFilterMarker = process.env.GRAPH_FILTER_MARKER;
  const previousFsmonitorMarker = process.env.GRAPH_FSMONITOR_MARKER;
  process.env.GRAPH_FILTER_MARKER = filterMarker;
  process.env.GRAPH_FSMONITOR_MARKER = fsmonitorMarker;
  let isolation = null;
  try {
    const manifest = await captureWorkspaceManifest(workspace);
    isolation = await createFrozenWorkspace(workspace, runDir, "worktree", manifest, { executionRoot });
    const isolatedManifest = await captureWorkspaceManifest(isolation.execution_workspace);
    assert.equal(await readFile(filterMarker, "utf8").catch(() => null), null);
    assert.equal(await readFile(fsmonitorMarker, "utf8").catch(() => null), null);
    assert.match(isolatedManifest.status, /^ M fixture\.txt$/m);
    assert.equal(
      await readFile(path.join(isolation.execution_workspace, "fixture.txt"), "utf8"),
      "dirty launch snapshot\n",
    );
  } finally {
    if (previousFilterMarker === undefined) delete process.env.GRAPH_FILTER_MARKER;
    else process.env.GRAPH_FILTER_MARKER = previousFilterMarker;
    if (previousFsmonitorMarker === undefined) delete process.env.GRAPH_FSMONITOR_MARKER;
    else process.env.GRAPH_FSMONITOR_MARKER = previousFsmonitorMarker;
    if (isolation) {
      await removeFrozenWorkspace({
        sourceWorkspace: workspace,
        executionWorkspace: isolation.execution_workspace,
        mode: isolation.mode,
        managedRoot: isolation.managed_root,
        managedKey: isolation.managed_key,
      });
    }
  }
});

test("worktree isolation freezes dirty input, exports results, rejects conflicts, and cleans up on purge", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "committed fixture\n", "utf8");
  for (const args of [
    ["init"],
    ["add", "fixture.txt"],
    ["-c", "user.name=Graph Test", "-c", "user.email=graph@example.invalid", "commit", "-m", "fixture"],
  ]) {
    const git = spawnSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true });
    assert.equal(git.status, 0, git.stderr || git.stdout);
  }
  await writeFile(path.join(workspace, "fixture.txt"), "dirty launch snapshot\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const result = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--workspace-mode",
      "worktree",
      "--state-root",
      stateRoot,
      "--goal",
      "Audit and repair the isolated fixture",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT * 2,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_EXECUTION_ROOT: path.join(root, "isolated"),
      },
    },
  );
  const failedSummary = result.stdout.trim() ? JSON.parse(result.stdout.trim()) : null;
  const failedReport = failedSummary?.run_dir
    ? await readFile(path.join(failedSummary.run_dir, "report.md"), "utf8").catch(() => "")
    : "";
  assert.equal(result.status, 0, `${result.stderr || result.stdout}\n${failedReport}`);
  const summary = failedSummary;
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  assert.equal(run.workspace_isolation.mode, "worktree");
  assert.notEqual(run.execution_workspace, workspace);
  assert.equal(await readFile(path.join(run.execution_workspace, "fixture.txt"), "utf8"), "dirty launch snapshot\n");
  assert.equal(await readFile(path.join(workspace, "graph-output.txt"), "utf8").catch(() => null), null);
  assert.equal(await readFile(path.join(run.execution_workspace, "graph-output.txt"), "utf8"), "implemented by fake Codex\n");
  const completion = JSON.parse(await readFile(path.join(summary.run_dir, "completion.json"), "utf8"));
  assert.equal(completion.workspace_mode, "worktree");
  assert.equal(completion.status, "completed");
  assert.deepEqual(completion.notification, []);
  assert.ok(run.results.apply_command.includes("apply.mjs"));
  for (const dependency of ["apply.mjs", "runtime-admission.mjs", "process-identity.mjs", "runtime/manifest.mjs"]) {
    assert.ok(await readFile(path.join(summary.run_dir, "results", dependency), "utf8"));
  }

  await writeFile(path.join(workspace, "fixture.txt"), "continued user development\n", "utf8");
  await writeFile(path.join(workspace, "graph-output.txt"), "user-owned conflicting result\n", "utf8");
  const conflict = spawnSync(
    process.execPath,
    [path.join(summary.run_dir, "results", "apply.mjs"), "--result-dir", path.join(summary.run_dir, "results"), "--workspace", workspace],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /changed since Graph started/);
  assert.equal(await readFile(path.join(workspace, "graph-output.txt"), "utf8"), "user-owned conflicting result\n");

  await rm(path.join(workspace, "graph-output.txt"), { force: true });
  const applied = spawnSync(
    process.execPath,
    [path.join(summary.run_dir, "results", "apply.mjs"), "--result-dir", path.join(summary.run_dir, "results"), "--workspace", workspace],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  assert.equal(await readFile(path.join(workspace, "graph-output.txt"), "utf8"), "implemented by fake Codex\n");
  assert.equal(await readFile(path.join(workspace, "fixture.txt"), "utf8"), "continued user development\n");

  const purged = spawnSync(
    process.execPath,
    [RUNNER, "purge", "--workspace", workspace, "--state-root", stateRoot, "--run", run.run_id, "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(purged.status, 0, purged.stderr || purged.stdout);
  const worktrees = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: workspace, encoding: "utf8", windowsHide: true });
  assert.equal(worktrees.status, 0, worktrees.stderr || worktrees.stdout);
  assert.doesNotMatch(worktrees.stdout, new RegExp(run.execution_workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
});

test(
  "Windows worktree isolation uses a short managed path and purges it after a long-path checkout",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await temporaryDirectory(t);
    const workspace = path.join(root, "workspace");
    const stateRoot = path.join(root, `state-${"s".repeat(90)}`);
    const executionRoot = path.join(root, "w");
    const relative = path.join(
      "apps",
      "server",
      "prisma",
      "migrations",
      "20260724140005_add_field_lengths_and_fk_rules",
      "migration.sql",
    );
    await mkdir(path.dirname(path.join(workspace, relative)), { recursive: true });
    await writeFile(path.join(workspace, relative), "SELECT 1;\n", "utf8");
    for (const args of [
      ["init"],
      ["-c", "core.longpaths=true", "add", "."],
      [
        "-c",
        "core.longpaths=true",
        "-c",
        "user.name=Graph Test",
        "-c",
        "user.email=graph@example.invalid",
        "commit",
        "-m",
        "fixture",
      ],
    ]) {
      const git = spawnSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true });
      assert.equal(git.status, 0, git.stderr || git.stdout);
    }
    const environment = {
      ...process.env,
      AEG_EXECUTION_ROOT: executionRoot,
      AEG_DISABLE_NOTIFICATIONS: "1",
    };
    const started = spawnSync(
      process.execPath,
      [
        RUNNER,
        "start",
        "--user-approved",
        "--workspace",
        workspace,
        "--workspace-mode",
        "worktree",
        "--state-root",
        stateRoot,
        "--goal",
        "Validate Windows long path isolation",
        "--dry-run",
        "--no-notify",
        "--json",
      ],
      { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: environment },
    );
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const summary = JSON.parse(started.stdout.trim());
    const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
    const legacyTarget = path.join(summary.run_dir, "workspace", relative);
    assert.ok(legacyTarget.length > 260, `Expected legacy target to exceed 260 characters, got ${legacyTarget.length}`);
    assert.ok(path.relative(executionRoot, run.execution_workspace).split(path.sep)[0] !== "..");
    assert.ok(run.execution_workspace.length < path.join(summary.run_dir, "workspace").length);
    assert.equal(await readFile(path.join(run.execution_workspace, relative), "utf8"), "SELECT 1;\n");

    const purged = spawnSync(
      process.execPath,
      [RUNNER, "purge", "--workspace", workspace, "--state-root", stateRoot, "--run", run.run_id, "--json"],
      { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: environment },
    );
    assert.equal(purged.status, 0, purged.stderr || purged.stdout);
    assert.equal(await readFile(path.join(run.execution_workspace, relative), "utf8").catch(() => null), null);
    const worktrees = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd: workspace,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(worktrees.status, 0, worktrees.stderr || worktrees.stdout);
    assert.doesNotMatch(worktrees.stdout, new RegExp(run.execution_workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  },
);

test("managed copy isolation records its binding and purge removes only that copy", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  const executionRoot = path.join(root, "managed");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "copy fixture\n", "utf8");
  const environment = {
    ...process.env,
    AEG_EXECUTION_ROOT: executionRoot,
    AEG_DISABLE_NOTIFICATIONS: "1",
  };
  const started = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--workspace-mode",
      "copy",
      "--state-root",
      stateRoot,
      "--goal",
      "Validate managed copy cleanup",
      "--dry-run",
      "--no-notify",
      "--json",
    ],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: environment },
  );
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const summary = JSON.parse(started.stdout.trim());
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  assert.equal(run.workspace_isolation.mode, "copy");
  assert.equal(run.workspace_isolation.managed, true);
  assert.equal(await readFile(path.join(run.execution_workspace, "fixture.txt"), "utf8"), "copy fixture\n");
  const purged = spawnSync(
    process.execPath,
    [RUNNER, "purge", "--workspace", workspace, "--state-root", stateRoot, "--run", run.run_id, "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: environment },
  );
  assert.equal(purged.status, 0, purged.stderr || purged.stdout);
  assert.equal(await readFile(path.join(run.execution_workspace, "fixture.txt"), "utf8").catch(() => null), null);
});

test("blocked or unreviewed result packages cannot be applied", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const runDir = path.join(root, "run");
  const resultDir = path.join(runDir, "results");
  await mkdir(path.join(resultDir, "files"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "source\n", "utf8");
  await writeFile(path.join(resultDir, "files", "fixture.txt"), "graph result\n", "utf8");
  const metadata = {
    version: 1,
    run_id: "blocked-result",
    terminal_status: "blocked",
    verification_passed: false,
    independent_review_passed: false,
    eligible_to_apply: false,
    source_workspace: workspace,
    changed_files: ["fixture.txt"],
    source_records: { "fixture.txt": { kind: "file", sha256: contentHash("source\n") } },
    result_records: { "fixture.txt": { kind: "file", sha256: contentHash("graph result\n") } },
  };
  await writeFile(path.join(resultDir, "metadata.json"), `${JSON.stringify(metadata)}\n`, "utf8");
  await writeFile(path.join(runDir, "completion.json"), `${JSON.stringify({
    run_id: metadata.run_id,
    status: "blocked",
    required_checks: [],
    independent_review: null,
  })}\n`, "utf8");
  const blocked = spawnSync(
    process.execPath,
    [APPLY_RESULTS, "--result-dir", resultDir, "--workspace", workspace],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Refusing to apply incomplete Graph results/);
  assert.equal(await readFile(path.join(workspace, "fixture.txt"), "utf8"), "source\n");

  await writeFile(path.join(resultDir, "metadata.json"), `${JSON.stringify({
    ...metadata,
    terminal_status: "completed",
    verification_passed: true,
    independent_review_passed: true,
    eligible_to_apply: true,
  })}\n`, "utf8");
  const missingReview = spawnSync(
    process.execPath,
    [APPLY_RESULTS, "--result-dir", resultDir, "--workspace", workspace],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(missingReview.status, 1);
  assert.match(missingReview.stderr, /without a matching completed verification and independent-review artifact/);
  assert.equal(await readFile(path.join(workspace, "fixture.txt"), "utf8"), "source\n");
});

test("result application rejects permission conflicts and restores the recorded result mode", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const runDir = path.join(root, "run");
  const resultDir = path.join(runDir, "results");
  const source = path.join(workspace, "fixture.txt");
  const payload = path.join(resultDir, "files", "fixture.txt");
  await mkdir(path.dirname(payload), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(source, "source\n", "utf8");
  await chmod(source, 0o600);
  const sourceMode = (await lstat(source)).mode & 0o777;
  await writeFile(payload, "graph result\n", "utf8");
  await chmod(payload, 0o444);
  const resultMode = (await lstat(payload)).mode & 0o777;
  assert.notEqual(sourceMode, resultMode);
  const metadata = {
    version: 1,
    run_id: "permission-result",
    terminal_status: "completed",
    verification_passed: true,
    independent_review_passed: true,
    eligible_to_apply: true,
    source_workspace: workspace,
    changed_files: ["fixture.txt"],
    source_records: {
      "fixture.txt": { kind: "file", sha256: contentHash("source\n"), mode: sourceMode },
    },
    result_records: {
      "fixture.txt": { kind: "file", sha256: contentHash("graph result\n"), mode: resultMode },
    },
  };
  await writeFile(path.join(resultDir, "metadata.json"), `${JSON.stringify(metadata)}\n`, "utf8");
  await writeFile(path.join(runDir, "completion.json"), `${JSON.stringify({
    run_id: metadata.run_id,
    status: "completed",
    machine_check_evaluation: { application_pass: true },
    independent_review: { status: "completed", gate: "pass" },
  })}\n`, "utf8");

  await chmod(source, resultMode);
  const conflict = spawnSync(
    process.execPath,
    [APPLY_RESULTS, "--result-dir", resultDir, "--workspace", workspace],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(conflict.status, 1, conflict.stderr || conflict.stdout);
  assert.match(conflict.stderr, /changed since Graph started/);
  assert.equal(await readFile(source, "utf8"), "source\n");

  await chmod(source, sourceMode);
  const applied = spawnSync(
    process.execPath,
    [APPLY_RESULTS, "--result-dir", resultDir, "--workspace", workspace],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  assert.equal(await readFile(source, "utf8"), "graph result\n");
  assert.equal((await lstat(source)).mode & 0o777, resultMode);
  await chmod(source, 0o600);
  await chmod(payload, 0o600);
});

test("result application rolls back prior files and created directories after a mid-apply failure", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const runDir = path.join(root, "run");
  const resultDir = path.join(runDir, "results");
  const filesRoot = path.join(resultDir, "files");
  await mkdir(path.join(filesRoot, "created"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "first.txt"), "first source\n", "utf8");
  await writeFile(path.join(workspace, "third.txt"), "third source\n", "utf8");
  await writeFile(path.join(filesRoot, "first.txt"), "first result\n", "utf8");
  await writeFile(path.join(filesRoot, "created", "nested.txt"), "created result\n", "utf8");
  await writeFile(path.join(filesRoot, "third.txt"), "third result\n", "utf8");
  const metadata = {
    version: 1,
    run_id: "transactional-result",
    terminal_status: "completed",
    verification_passed: true,
    independent_review_passed: true,
    eligible_to_apply: true,
    source_workspace: workspace,
    changed_files: ["first.txt", "created/nested.txt", "third.txt"],
    source_records: {
      "first.txt": { kind: "file", sha256: contentHash("first source\n"), mode: defaultFileMode },
      "created/nested.txt": { missing: true },
      "third.txt": { kind: "file", sha256: contentHash("third source\n"), mode: defaultFileMode },
    },
    result_records: {
      "first.txt": { kind: "file", sha256: contentHash("first result\n"), mode: defaultFileMode },
      "created/nested.txt": { kind: "file", sha256: contentHash("created result\n"), mode: defaultFileMode },
      "third.txt": { kind: "file", sha256: contentHash("third result\n"), mode: defaultFileMode },
    },
  };
  await writeFile(path.join(resultDir, "metadata.json"), `${JSON.stringify(metadata)}\n`, "utf8");
  await writeFile(path.join(runDir, "completion.json"), `${JSON.stringify({
    run_id: metadata.run_id,
    status: "completed",
    machine_check_evaluation: { application_pass: true },
    independent_review: { status: "completed", gate: "pass" },
  })}\n`, "utf8");

  await assert.rejects(
    applyResults({
      resultDir,
      workspace,
      beforeApplyFile: ({ index }) => {
        if (index === 2) throw new Error("injected apply failure");
      },
    }),
    /injected apply failure; source workspace rollback completed/,
  );
  assert.equal(await readFile(path.join(workspace, "first.txt"), "utf8"), "first source\n");
  assert.equal(await readFile(path.join(workspace, "third.txt"), "utf8"), "third source\n");
  assert.equal(await readFile(path.join(workspace, "created", "nested.txt"), "utf8").catch(() => null), null);
  assert.equal(await lstat(path.join(workspace, "created")).catch(() => null), null);
  assert.deepEqual((await readdir(resultDir)).filter((name) => name.startsWith(".apply-transaction-")), []);
});

test("result application commits edits, additions, and deletions from one staged transaction", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const runDir = path.join(root, "run");
  const resultDir = path.join(runDir, "results");
  const filesRoot = path.join(resultDir, "files");
  await mkdir(path.join(filesRoot, "new"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "edit.txt"), "old edit\n", "utf8");
  await writeFile(path.join(workspace, "delete.txt"), "old delete\n", "utf8");
  await writeFile(path.join(filesRoot, "edit.txt"), "new edit\n", "utf8");
  await writeFile(path.join(filesRoot, "new", "nested.txt"), "new file\n", "utf8");
  const metadata = {
    version: 1,
    run_id: "mixed-transaction-result",
    terminal_status: "completed",
    verification_passed: true,
    independent_review_passed: true,
    eligible_to_apply: true,
    source_workspace: workspace,
    changed_files: ["edit.txt", "delete.txt", "new/nested.txt"],
    source_records: {
      "edit.txt": { kind: "file", sha256: contentHash("old edit\n"), mode: defaultFileMode },
      "delete.txt": { kind: "file", sha256: contentHash("old delete\n"), mode: defaultFileMode },
      "new/nested.txt": { missing: true },
    },
    result_records: {
      "edit.txt": { kind: "file", sha256: contentHash("new edit\n"), mode: defaultFileMode },
      "delete.txt": { missing: true },
      "new/nested.txt": { kind: "file", sha256: contentHash("new file\n"), mode: defaultFileMode },
    },
  };
  await writeFile(path.join(resultDir, "metadata.json"), `${JSON.stringify(metadata)}\n`, "utf8");
  await writeFile(path.join(runDir, "completion.json"), `${JSON.stringify({
    run_id: metadata.run_id,
    status: "completed",
    machine_check_evaluation: { application_pass: true },
    independent_review: { status: "completed", gate: "pass" },
  })}\n`, "utf8");

  const result = await applyResults({ resultDir, workspace });
  assert.equal(result.status, "applied");
  assert.deepEqual(result.files_applied, metadata.changed_files);
  assert.equal(await readFile(path.join(workspace, "edit.txt"), "utf8"), "new edit\n");
  assert.equal(await readFile(path.join(workspace, "delete.txt"), "utf8").catch(() => null), null);
  assert.equal(await readFile(path.join(workspace, "new", "nested.txt"), "utf8"), "new file\n");
  assert.deepEqual((await readdir(resultDir)).filter((name) => name.startsWith(".apply-transaction-")), []);
});

test("result application serializes the full transaction per source workspace", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const admissionRoot = path.join(root, "control");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "source\n", "utf8");

  async function createResultPackage(runId, resultContents) {
    const runDir = path.join(root, runId);
    const resultDir = path.join(runDir, "results");
    await mkdir(path.join(resultDir, "files"), { recursive: true });
    await writeFile(path.join(resultDir, "files", "fixture.txt"), resultContents, "utf8");
    const metadata = {
      version: 1,
      run_id: runId,
      terminal_status: "completed",
      verification_passed: true,
      independent_review_passed: true,
      eligible_to_apply: true,
      source_workspace: workspace,
      changed_files: ["fixture.txt"],
      source_records: {
        "fixture.txt": { kind: "file", sha256: contentHash("source\n"), mode: defaultFileMode },
      },
      result_records: {
        "fixture.txt": { kind: "file", sha256: contentHash(resultContents), mode: defaultFileMode },
      },
    };
    await writeFile(path.join(resultDir, "metadata.json"), `${JSON.stringify(metadata)}\n`, "utf8");
    await writeFile(path.join(runDir, "completion.json"), `${JSON.stringify({
      run_id: runId,
      status: "completed",
      machine_check_evaluation: { application_pass: true },
      independent_review: { status: "completed", gate: "pass" },
    })}\n`, "utf8");
    return resultDir;
  }

  const firstResultDir = await createResultPackage("first-result", "first result\n");
  const secondResultDir = await createResultPackage("second-result", "second result\n");
  let continueFirst;
  let markFirstEntered;
  const firstEntered = new Promise((resolve) => {
    markFirstEntered = resolve;
  });
  const firstGate = new Promise((resolve) => {
    continueFirst = resolve;
  });
  const firstApply = applyResults({
    resultDir: firstResultDir,
    workspace,
    admissionRoot,
    beforeApplyFile: async ({ index }) => {
      if (index !== 0) return;
      markFirstEntered();
      await firstGate;
    },
  });
  await firstEntered;
  try {
    await assert.rejects(
      applyResults({ resultDir: secondResultDir, workspace, admissionRoot }),
      (error) => error?.code === "RUNTIME_ADMISSION_BUSY",
    );
  } finally {
    continueFirst();
  }
  const first = await firstApply;
  assert.equal(first.status, "applied");
  assert.equal(await readFile(path.join(workspace, "fixture.txt"), "utf8"), "first result\n");
});

test("a live Graph run holds the same workspace admission used by result application", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const runDir = path.join(root, "active-live-run");
  const resultRunDir = path.join(root, "result-run");
  const resultDir = path.join(resultRunDir, "results");
  const admissionRoot = path.join(root, "control");
  await mkdir(workspace, { recursive: true });
  await mkdir(runDir, { recursive: true });
  await mkdir(path.join(resultDir, "files"), { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "source\n", "utf8");
  await writeFile(path.join(resultDir, "files", "fixture.txt"), "result\n", "utf8");
  await writeFile(path.join(runDir, "run.json"), `${JSON.stringify({
    run_id: "active-live-run",
    workspace,
    execution_workspace: workspace,
    workspace_isolation: { mode: "live", isolated: false },
  })}\n`, "utf8");
  const metadata = {
    version: 1,
    run_id: "result-run",
    terminal_status: "completed",
    verification_passed: true,
    independent_review_passed: true,
    eligible_to_apply: true,
    source_workspace: workspace,
    changed_files: ["fixture.txt"],
    source_records: {
      "fixture.txt": { kind: "file", sha256: contentHash("source\n"), mode: defaultFileMode },
    },
    result_records: {
      "fixture.txt": { kind: "file", sha256: contentHash("result\n"), mode: defaultFileMode },
    },
  };
  await writeFile(path.join(resultDir, "metadata.json"), `${JSON.stringify(metadata)}\n`, "utf8");
  await writeFile(path.join(resultRunDir, "completion.json"), `${JSON.stringify({
    run_id: metadata.run_id,
    status: "completed",
    machine_check_evaluation: { application_pass: true },
    independent_review: { status: "completed", gate: "pass" },
  })}\n`, "utf8");

  const releaseRun = await acquireLock(runDir, { controlRoot: admissionRoot });
  try {
    await assert.rejects(
      applyResults({ resultDir, workspace, admissionRoot }),
      (error) => error?.code === "RUNTIME_ADMISSION_BUSY",
    );
  } finally {
    await releaseRun();
  }
  assert.equal((await applyResults({ resultDir, workspace, admissionRoot })).status, "applied");
  assert.equal(await readFile(path.join(workspace, "fixture.txt"), "utf8"), "result\n");
});

test("result application rejects link records before mutating the source workspace", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  const runDir = path.join(root, "run");
  const resultDir = path.join(runDir, "results");
  await mkdir(path.join(resultDir, "files"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "outside.txt"), "outside stays unchanged\n", "utf8");
  const metadata = {
    version: 1,
    run_id: "linked-result",
    terminal_status: "completed",
    verification_passed: true,
    independent_review_passed: true,
    eligible_to_apply: true,
    source_workspace: workspace,
    changed_files: ["linked-dir"],
    source_records: { "linked-dir": { missing: true } },
    result_records: {
      "linked-dir": {
        kind: "symlink",
        link_target: outside,
        link_type: process.platform === "win32" ? "junction" : "dir",
      },
    },
  };
  await writeFile(path.join(resultDir, "metadata.json"), `${JSON.stringify(metadata)}\n`, "utf8");
  await writeFile(path.join(runDir, "completion.json"), `${JSON.stringify({
    run_id: metadata.run_id,
    status: "completed",
    machine_check_evaluation: { application_pass: true },
    independent_review: { status: "completed", gate: "pass" },
  })}\n`, "utf8");

  const rejected = spawnSync(
    process.execPath,
    [APPLY_RESULTS, "--result-dir", resultDir, "--workspace", workspace],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(rejected.status, 1, rejected.stderr || rejected.stdout);
  assert.match(rejected.stderr, /Refusing to apply linked Graph results/);
  assert.equal(await lstat(path.join(workspace, "linked-dir")).catch(() => null), null);
  assert.equal(await readFile(path.join(outside, "outside.txt"), "utf8"), "outside stays unchanged\n");
});

test("an isolated run with a link result never exports an apply command", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the fixture");
  const result = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--workspace-mode",
      "copy",
      "--state-root",
      stateRoot,
      "--goal",
      "Audit and repair the fixture without exporting linked results",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_FAKE_SCENARIO: "result-link",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout.trim());
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  const metadata = JSON.parse(await readFile(path.join(summary.run_dir, "results", "metadata.json"), "utf8"));
  assert.equal(run.status, "completed");
  assert.equal(run.results.eligible_to_apply, false);
  assert.equal(run.results.apply_command, null);
  assert.equal(run.results.result_boundary_passed, false);
  assert.deepEqual(run.results.unsafe_result_links, ["graph-link"]);
  assert.equal(metadata.eligible_to_apply, false);
  assert.equal(metadata.result_boundary_passed, false);
  assert.deepEqual(metadata.unsafe_result_links, ["graph-link"]);
  assert.equal(await readFile(path.join(summary.run_dir, "results", "apply.mjs"), "utf8").catch(() => null), null);
});

test("a failed isolated run exports evidence but no apply command", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the fixture");
  const result = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--workspace-mode",
      "copy",
      "--state-root",
      stateRoot,
      "--goal",
      "Audit and repair the fixture but reject unverified output",
      "--max-corrections",
      "0",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: {
        ...process.env,
        AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
        AEG_FAKE_SCENARIO: "failed-command-pass",
      },
    },
  );
  assert.equal(result.status, 2, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout.trim());
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  const metadata = JSON.parse(await readFile(path.join(summary.run_dir, "results", "metadata.json"), "utf8"));
  assert.equal(run.status, "completed_with_gaps");
  assert.equal(run.results.eligible_to_apply, false);
  assert.equal(run.results.apply_command, null);
  assert.equal(metadata.eligible_to_apply, false);
  assert.equal(metadata.verification_passed, false);
  assert.equal(await readFile(path.join(summary.run_dir, "results", "apply.mjs"), "utf8").catch(() => null), null);
  assert.equal(await readFile(path.join(workspace, "graph-output.txt"), "utf8").catch(() => null), null);
});

test("nested scope isolation snapshots the complete repository and keeps the execution cwd scoped", async (t) => {
  const root = await temporaryDirectory(t);
  const repository = path.join(root, "repository");
  const nested = path.join(repository, "fixtures", "booking-ledger");
  const runDir = path.join(root, "run");
  await mkdir(nested, { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(repository, "parent-only.txt"), "parent\n", "utf8");
  await writeFile(path.join(nested, "fixture.txt"), "nested\n", "utf8");
  for (const args of [
    ["init"],
    ["add", "."],
    ["-c", "user.name=Graph Test", "-c", "user.email=graph@example.invalid", "commit", "-m", "fixture"],
  ]) {
    const git = spawnSync("git", args, { cwd: repository, encoding: "utf8", windowsHide: true });
    assert.equal(git.status, 0, git.stderr || git.stdout);
  }

  const manifest = await captureWorkspaceManifest(repository);
  assert.equal(manifest.git, true);
  const isolation = await createFrozenWorkspace(repository, runDir, "auto", manifest, { executionRoot: runDir });
  assert.equal(isolation.mode, "worktree");
  assert.equal(await readFile(path.join(isolation.execution_workspace, "parent-only.txt"), "utf8"), "parent\n");
  const scoped = path.join(isolation.execution_workspace, "fixtures", "booking-ledger");
  assert.equal(await readFile(path.join(scoped, "fixture.txt"), "utf8"), "nested\n");
  await assert.rejects(readFile(path.join(isolation.execution_workspace, "missing-parent.txt")), { code: "ENOENT" });
  await removeFrozenWorkspace({
    sourceWorkspace: repository,
    executionWorkspace: isolation.execution_workspace,
    mode: isolation.mode,
    managedRoot: runDir,
    managedKey: isolation.managed_key,
  });
});

test("an isolated owner-gated run resumes after the source workspace continues changing", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "launch snapshot\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const environment = {
    ...process.env,
    AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
    AEG_FAKE_SCENARIO: "synthesis-owner-gate",
  };
  const started = spawnSync(
    process.execPath,
    [RUNNER, "start", "--user-approved", "--workspace", workspace, "--workspace-mode", "copy", "--state-root", stateRoot, "--goal", "Change authentication", "--timeout-minutes", "1", "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: environment },
  );
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const waiting = JSON.parse(started.stdout.trim());
  assert.equal(waiting.status, "waiting_owner");
  const runPath = path.join(waiting.run_dir, "run.json");
  let run = JSON.parse(await readFile(runPath, "utf8"));
  const scope = run.plan.owner_gate.authorization_scope;
  const completion = JSON.parse(await readFile(path.join(waiting.run_dir, "completion.json"), "utf8"));
  assert.equal(completion.resume_command, null);
  assert.equal(completion.authorization_required, scope);

  await writeFile(path.join(workspace, "fixture.txt"), "source changed while waiting\n", "utf8");
  const resumed = spawnSync(
    process.execPath,
    [RUNNER, "resume", "--workspace", workspace, "--state-root", stateRoot, "--run", run.run_id, "--authorize", scope, "--timeout-minutes", "1", "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: environment },
  );
  assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
  assert.equal(JSON.parse(resumed.stdout.trim()).status, "completed");
  run = JSON.parse(await readFile(runPath, "utf8"));
  assert.equal(await readFile(path.join(run.execution_workspace, "fixture.txt"), "utf8"), "launch snapshot\n");
  assert.equal(await readFile(path.join(workspace, "fixture.txt"), "utf8"), "source changed while waiting\n");
});

test("completion artifacts notify once per terminal state and summary regeneration does not duplicate", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  const notificationLog = path.join(root, "notifications.jsonl");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const environment = {
    ...process.env,
    AEG_DISABLE_NOTIFICATIONS: "0",
    AEG_DISABLE_SYSTEM_NOTIFICATIONS: "1",
    AEG_FAKE_NOTIFICATION_LOG: notificationLog,
    AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]),
  };
  const started = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--workspace-mode",
      "live",
      "--state-root",
      stateRoot,
      "--goal",
      "Audit and repair the notification fixture",
      "--notification-command",
      `"${process.execPath}" "${FAKE_NOTIFIER}"`,
      "--timeout-minutes",
      "1",
      "--json",
    ],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: environment },
  );
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const summary = JSON.parse(started.stdout.trim());
  const firstLines = (await readFile(notificationLog, "utf8")).trim().split(/\r?\n/);
  assert.equal(firstLines.length, 1);
  assert.equal(JSON.parse(firstLines[0]).status, "completed");
  const completion = JSON.parse(await readFile(path.join(summary.run_dir, "completion.json"), "utf8"));
  assert.equal(completion.status, "completed");
  assert.equal(completion.notification.some((item) => item.channel === "command" && item.status === "sent"), true);

  const regenerated = spawnSync(
    process.execPath,
    [RUNNER, "summary", "--workspace", workspace, "--state-root", stateRoot, "--run", summary.run_id, "--force", "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: environment },
  );
  assert.equal(regenerated.status, 0, regenerated.stderr || regenerated.stdout);
  const finalLines = (await readFile(notificationLog, "utf8")).trim().split(/\r?\n/);
  assert.equal(finalLines.length, 1);
});

test("global installer refuses an active runtime and installs a validated staged package after release", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = path.join(root, "codex-home");
  const binDir = path.join(root, "bin");
  const lockDir = path.join(codexHome, "graph-runs", "bucket", "run");
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    path.join(lockDir, ".runner-owner.json"),
    `${JSON.stringify({
      version: 2,
      pid: process.pid,
      process_started_at_ms: Math.round(Date.now() - process.uptime() * 1_000),
      runner_path: path.resolve(process.argv[1]),
      acquired_at: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
  const blocked = spawnSync(
    process.execPath,
    [INSTALLER, "--codex-home", codexHome, "--bin-dir", binDir],
    { encoding: "utf8", timeout: SLOW_INTEGRATION_TIMEOUT },
  );
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Refusing to update Graph.*run_lock/s);
  assert.equal(await readFile(path.join(codexHome, "skills", "autonomous-engineering-graph", "SKILL.md"), "utf8").catch(() => null), null);

  await writeFile(
    path.join(lockDir, ".runner-owner.json"),
    `${JSON.stringify({
      version: 2,
      pid: process.pid,
      process_started_at_ms: Date.parse("2000-01-01T00:00:00.000Z"),
      runner_path: path.resolve(process.argv[1]),
      acquired_at: "2000-01-01T00:00:00.000Z",
    })}\n`,
    "utf8",
  );
  const installed = spawnSync(
    process.execPath,
    [INSTALLER, "--codex-home", codexHome, "--bin-dir", binDir],
    { encoding: "utf8", timeout: SLOW_INTEGRATION_TIMEOUT },
  );
  assert.equal(installed.status, 0, spawnResultDetails(installed));
  const output = JSON.parse(installed.stdout.trim());
  assert.equal(output.status, "installed");
  assert.equal(output.skills.includes("autonomous-engineering-graph"), true);
  const installedSkill = await readFile(path.join(codexHome, "skills", "autonomous-engineering-graph", "SKILL.md"), "utf8");
  assert.match(installedSkill, /current task.*explicitly names|explicitly accepts/is);
  assert.match(installedSkill, /--follow/);
  assert.match(await readFile(path.join(binDir, process.platform === "win32" ? "graph-engineering.cmd" : "graph-engineering"), "utf8"), /graph-runner\.mjs/);
  assert.deepEqual((await readdir(path.join(codexHome, "skills"))).filter((name) => name.startsWith(".graph-engineering-")), []);
});

test("global installer sees a runner registered outside the default state root", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = path.join(root, "codex-home");
  const binDir = path.join(root, "bin");
  const controlRoot = path.join(root, "control");
  const runDir = path.join(root, "external-state", "bucket", "run");
  await mkdir(runDir, { recursive: true });
  const release = await acquireLock(runDir, { controlRoot });
  try {
    const blocked = spawnSync(
      process.execPath,
      [INSTALLER, "--codex-home", codexHome, "--bin-dir", binDir],
      {
        encoding: "utf8",
        timeout: INTEGRATION_TIMEOUT,
        env: {
          ...process.env,
          AEG_TEST_MODE: "1",
          AEG_TEST_RUNTIME_CONTROL_ROOT: controlRoot,
          AEG_MODEL_QUEUE_ROOT: path.join(root, "empty-queue"),
          AEG_STATE_ROOT: "",
        },
      },
    );
    assert.equal(blocked.status, 1, blocked.stderr || blocked.stdout);
    assert.match(blocked.stderr, /Refusing to update Graph.*runner/s);
    assert.equal(await readFile(path.join(codexHome, "skills", "autonomous-engineering-graph", "SKILL.md"), "utf8").catch(() => null), null);
  } finally {
    await release();
  }
});

test("installer admission serializes scan-to-swap with runners and other installers", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = path.join(root, "codex-home");
  const binDir = path.join(root, "bin");
  const controlRoot = path.join(root, "control");
  const runDir = path.join(root, "external-state", "bucket", "run");
  await mkdir(runDir, { recursive: true });

  let continueInstall;
  let markScanComplete;
  const scanComplete = new Promise((resolve) => {
    markScanComplete = resolve;
  });
  const installGate = new Promise((resolve) => {
    continueInstall = resolve;
  });
  const firstInstall = installGraph({
    codexHome,
    binDir,
    controlRoot,
    hooks: {
      afterRuntimeScan: async () => {
        markScanComplete();
        await installGate;
      },
    },
  });
  await scanComplete;
  try {
    await assert.rejects(
      installGraph({ codexHome, binDir, controlRoot }),
      (error) => error?.code === "RUNTIME_ADMISSION_BUSY",
    );
    await assert.rejects(
      acquireLock(runDir, { controlRoot }),
      (error) => error?.code === "RUNTIME_ADMISSION_BUSY",
    );
  } finally {
    continueInstall();
  }
  assert.equal((await firstInstall).status, "installed");

  const releaseRun = await acquireLock(runDir, { controlRoot });
  try {
    await assert.rejects(
      installGraph({ codexHome, binDir, controlRoot }),
      /Refusing to update Graph.*runner/s,
    );
  } finally {
    await releaseRun();
  }
});

test("global installer scans an explicitly supplied legacy state root", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = path.join(root, "codex-home");
  const binDir = path.join(root, "bin");
  const stateRoot = path.join(root, "legacy-external-state");
  const ownerDir = path.join(stateRoot, "bucket", "run");
  await mkdir(ownerDir, { recursive: true });
  await writeFile(
    path.join(ownerDir, ".runner-owner.json"),
    `${JSON.stringify({
      version: 2,
      pid: process.pid,
      process_started_at_ms: Math.round(Date.now() - process.uptime() * 1_000),
      runner_path: path.resolve(process.argv[1]),
      acquired_at: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
  const blocked = spawnSync(
    process.execPath,
    [INSTALLER, "--codex-home", codexHome, "--bin-dir", binDir, "--state-root", stateRoot],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: { ...process.env, AEG_MODEL_QUEUE_ROOT: path.join(root, "empty-queue"), AEG_STATE_ROOT: "" },
    },
  );
  assert.equal(blocked.status, 1, blocked.stderr || blocked.stdout);
  assert.match(blocked.stderr, /Refusing to update Graph.*run_lock/s);
});

test("global installer restores skills and launchers after a launcher commit failure", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = path.join(root, "codex-home");
  const binDir = path.join(root, "bin");
  const oldSkill = path.join(codexHome, "skills", "autonomous-engineering-graph", "old-marker.txt");
  const launcherNames = process.platform === "win32"
    ? ["graph-engineering.cmd", "graph-engineering.ps1"]
    : ["graph-engineering"];
  await mkdir(path.dirname(oldSkill), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(oldSkill, "old skill\n", "utf8");
  for (const name of launcherNames) await writeFile(path.join(binDir, name), `old ${name}\n`, "utf8");

  await assert.rejects(
    installGraph({
      codexHome,
      binDir,
      hooks: {
        afterLauncherInstalled: () => {
          throw new Error("injected launcher failure");
        },
      },
    }),
    /injected launcher failure/,
  );
  assert.equal(await readFile(oldSkill, "utf8"), "old skill\n");
  for (const name of launcherNames) {
    assert.equal(await readFile(path.join(binDir, name), "utf8"), `old ${name}\n`);
  }
  assert.deepEqual((await readdir(path.join(codexHome, "skills"))).filter((name) => name.startsWith(".graph-engineering-")), []);
  assert.deepEqual((await readdir(binDir)).filter((name) => name.includes(".stage-") || name.includes(".backup-")), []);
});

test("global installer refuses a live lease in the legacy queue during path migration", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = path.join(root, "codex-home");
  const binDir = path.join(root, "bin");
  const canonicalQueue = path.join(root, "canonical-queue");
  const legacyLeases = path.join(codexHome, "graph-runtime", "model-queue", "leases");
  await mkdir(legacyLeases, { recursive: true });
  await writeFile(
    path.join(legacyLeases, "live.json"),
    `${JSON.stringify({
      version: 1,
      pid: process.pid,
      process_started_at_ms: Math.round(Date.now() - process.uptime() * 1_000),
      runner_path: path.resolve(process.argv[1]),
      acquired_at: new Date().toISOString(),
    })}\n`,
    "utf8",
  );

  const blocked = spawnSync(
    process.execPath,
    [INSTALLER, "--codex-home", codexHome, "--bin-dir", binDir],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: { ...process.env, AEG_MODEL_QUEUE_ROOT: canonicalQueue },
    },
  );

  assert.equal(blocked.status, 1, blocked.stderr || blocked.stdout);
  assert.match(blocked.stderr, /Refusing to update Graph.*model_lease/s);
  assert.equal(await readFile(path.join(codexHome, "skills", "autonomous-engineering-graph", "SKILL.md"), "utf8").catch(() => null), null);
});

test("global installer reclaims a lock whose live PID has no matching process identity", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = path.join(root, "codex-home");
  const binDir = path.join(root, "bin");
  const lockDir = path.join(codexHome, "graph-runs", "bucket", "stale-pid");
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    path.join(lockDir, ".runner-owner.json"),
    `${JSON.stringify({
      version: 1,
      pid: process.pid,
      process_started_at_ms: null,
      runner_path: path.join(root, "previous-install", "graph-runner.mjs"),
      acquired_at: new Date().toISOString(),
    })}\n`,
    "utf8",
  );

  const installed = spawnSync(
    process.execPath,
    [INSTALLER, "--codex-home", codexHome, "--bin-dir", binDir],
    { encoding: "utf8", timeout: SLOW_INTEGRATION_TIMEOUT },
  );
  assert.equal(installed.status, 0, spawnResultDetails(installed));
  assert.equal(JSON.parse(installed.stdout.trim()).status, "installed");
});

test("global installer refuses a matching live legacy owner without a start timestamp", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = path.join(root, "codex-home");
  const binDir = path.join(root, "bin");
  const lockDir = path.join(codexHome, "graph-runs", "bucket", "legacy-live-owner");
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    path.join(lockDir, ".runner-owner.json"),
    `${JSON.stringify({
      version: 1,
      pid: process.pid,
      process_started_at_ms: null,
      runner_path: path.resolve(process.argv[1]),
      acquired_at: new Date().toISOString(),
    })}\n`,
    "utf8",
  );

  const blocked = spawnSync(
    process.execPath,
    [INSTALLER, "--codex-home", codexHome, "--bin-dir", binDir],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(blocked.status, 1, blocked.stderr || blocked.stdout);
  assert.match(blocked.stderr, /Refusing to update Graph.*run_lock/s);
  assert.equal(await readFile(path.join(codexHome, "skills", "autonomous-engineering-graph", "SKILL.md"), "utf8").catch(() => null), null);
});

test(
  "Windows installer follows the npm global prefix and its PowerShell launcher preserves multiline arguments",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await temporaryDirectory(t);
    const codexHome = path.join(root, "codex-home");
    const npmPrefix = path.join(root, "custom-npm-prefix");
    const appData = path.join(root, "app-data");
    const workspace = path.join(root, "workspace");
    const stateRoot = path.join(root, "state");
    await mkdir(workspace, { recursive: true });

    const environment = {
      ...process.env,
      APPDATA: appData,
      npm_config_prefix: npmPrefix,
      AEG_DISABLE_NOTIFICATIONS: "1",
    };
    const installed = spawnSync(
      process.execPath,
      [INSTALLER, "--codex-home", codexHome],
      { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: environment },
    );
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    const installSummary = JSON.parse(installed.stdout.trim());
    assert.equal(path.resolve(installSummary.bin_dir), path.resolve(npmPrefix));

    const cmdLauncher = path.join(npmPrefix, "graph-engineering.cmd");
    const ps1Launcher = path.join(npmPrefix, "graph-engineering.ps1");
    assert.match(await readFile(cmdLauncher, "utf8"), /graph-runner\.mjs/);
    assert.match(await readFile(ps1Launcher, "utf8"), /@args/);

    const launcherEnvironment = {
      ...environment,
      PATH: `${npmPrefix}${path.delimiter}${process.env.PATH || ""}`,
    };
    const resolved = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "(Get-Command graph-engineering).Source",
      ],
      { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: launcherEnvironment },
    );
    assert.equal(resolved.status, 0, resolved.stderr || resolved.stdout);
    assert.equal(path.resolve(resolved.stdout.trim()).toLowerCase(), path.resolve(ps1Launcher).toLowerCase());

    const goal = "Audit the frozen workspace.\nRepair only independently validated defects.";
    const dryRun = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        ps1Launcher,
        "start",
        "--workspace",
        workspace,
        "--state-root",
        stateRoot,
        "--goal",
        goal,
        "--user-approved",
        "--dry-run",
        "--workspace-mode",
        "live",
        "--no-notify",
        "--json",
      ],
      { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: launcherEnvironment },
    );
    assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
    const runSummary = JSON.parse(dryRun.stdout.trim());
    const run = JSON.parse(await readFile(path.join(runSummary.run_dir, "run.json"), "utf8"));
    assert.equal(run.goal_sha256, contentHash(goal));
    assert.equal(run.options.user_approved, true);
  },
);

async function statOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

test("preview reports audit coverage and high assurance without creating a Run or state residue", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });

  const previewed = spawnSync(
    process.execPath,
    [RUNNER, "preview", "--workspace", workspace, "--goal", "Audit the repository", "--state-root", stateRoot, "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(previewed.status, 0, previewed.stderr || previewed.stdout);
  const output = JSON.parse(previewed.stdout.trim());
  assert.equal(output.status, "preview");
  assert.equal(output.creates_run, false);
  assert.equal(output.creates_workspace, false);
  assert.equal(output.creates_state, false);
  assert.equal(output.plan.mode, "audit");
  // The empty preview workspace is tiny, so the unpinned review fan-out
  // auto-scales to the task floor and records the decision.
  assert.equal(output.plan.review_limit_per_wave, 4);
  assert.equal(output.plan.coverage.auto_review_scaling.applied, true);
  assert.ok(Array.isArray(output.plan.required_checks));
  assert.ok(Array.isArray(output.capabilities));
  assert.deepEqual(output.capabilities.map((entry) => entry.backend).sort(), ["claude", "codex"]);
  for (const entry of output.capabilities) {
    assert.ok(entry.installed && entry.invocable && entry["read-sandbox-verified"] && entry["write-sandbox-verified"]);
  }
  assert.equal(output.assurance.level, "high");
  assert.equal(output.budget.profile, "default");
  assert.equal(output.budget.max_tokens, 6_000_000);
  assert.ok(output.preflight.environment_keys.length > 0);
  assert.equal(await statOrNull(stateRoot), null);

  const missingGoal = spawnSync(
    process.execPath,
    [RUNNER, "preview", "--workspace", workspace, "--state-root", stateRoot, "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(missingGoal.status, 1);
  assert.match(missingGoal.stderr, /preview requires --goal/);
  assert.equal(await statOrNull(stateRoot), null);
});

test("goal mode inference keeps ordinary implementation requests as task mode", () => {
  assert.equal(inferGoalMode("Implement the queue retry behavior"), "task");
  assert.equal(inferGoalMode("Review this one parser function"), "review");
  assert.equal(inferGoalMode("Audit the complete repository for release readiness"), "audit");
  assert.equal(inferGoalMode("审计整个仓库的发布准备情况"), "audit");
});

test("stream budget guard stops at the declared aggregate token ceiling", () => {
  const guard = tokenBudgetGuard(100);
  guard.consume(`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 70, output_tokens: 20 } })}\n`);
  assert.equal(guard.exceeded, false);
  guard.consume(`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 80, output_tokens: 30 } })}\n`);
  assert.equal(guard.exceeded, true);
  assert.equal(guard.observed_tokens, 110);
});

test("strict agent capability doctor blocks an installed but unverified backend", () => {
  const matrix = {
    backend: "codex",
    installed: { status: "PASS", value: "codex" },
    invocable: { status: "PASS", value: "codex 1.0.0" },
    "read-sandbox-verified": { status: "WARN", value: "unverified" },
    "write-sandbox-verified": { status: "WARN", value: "unverified" },
    "automatic-fallback-ready": { status: "WARN", value: "not-ready" },
  };
  const doctor = agentCapabilityDoctor({ backend: "codex", matrix, strict: true, testFixtureOverride: false });
  assert.equal(doctor.status, "blocked");
  assert.ok(doctor.gaps.some((gap) => /read-sandbox-verified/.test(gap.check)));
  assert.ok(doctor.gaps.some((gap) => /write-sandbox-verified/.test(gap.check)));
});

test("runs lists saved runs with recovery flags and usage", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const otherWorkspace = path.join(root, "other-workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await mkdir(otherWorkspace, { recursive: true });
  const bucket = workspaceBucket(stateRoot, workspace);
  for (const [runId, status] of [["run-open", "blocked"], ["run-done", "completed"]]) {
    const directory = path.join(bucket, runId);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "run.json"),
      `${JSON.stringify({ run_id: runId, workspace, status, created_at: "2026-08-20T00:00:00.000Z" })}\n`,
      "utf8",
    );
  }

  const listed = spawnSync(
    process.execPath,
    [RUNNER, "runs", "--state-root", stateRoot, "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(listed.status, 0, listed.stderr || listed.stdout);
  const output = JSON.parse(listed.stdout.trim());
  assert.equal(output.state_root, path.resolve(stateRoot));
  assert.ok(Number.isFinite(output.usage.bytes));
  const byId = new Map(output.runs.map((entry) => [entry.run.run_id, entry]));
  assert.equal(byId.get("run-open").recoverable, true);
  assert.equal(byId.get("run-open").run.status, "blocked");
  assert.equal(byId.get("run-done").recoverable, false);
  assert.ok(byId.get("run-done").size_bytes >= 0);

  const filtered = spawnSync(
    process.execPath,
    [RUNNER, "runs", "--workspace", otherWorkspace, "--state-root", stateRoot, "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(filtered.status, 0, filtered.stderr || filtered.stdout);
  assert.equal(JSON.parse(filtered.stdout.trim()).runs.length, 0);
});

test("diff summarizes added, modified, deleted, and mode-only changes", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  const runDir = path.join(workspaceBucket(stateRoot, workspace), "diff-run");
  const resultDir = path.join(runDir, "results");
  await mkdir(resultDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(runDir, "run.json"),
    `${JSON.stringify({ run_id: "diff-run", workspace, status: "completed", created_at: "2026-08-20T00:00:00.000Z" })}\n`,
    "utf8",
  );
  await writeFile(path.join(resultDir, "metadata.json"), `${JSON.stringify({
    version: 1,
    run_id: "diff-run",
    terminal_status: "completed",
    verification_passed: true,
    independent_review_passed: true,
    eligible_to_apply: true,
    source_workspace: workspace,
    changed_files: ["added.txt", "modified.txt", "gone.txt", "perm.txt"],
    source_records: {
      "modified.txt": { kind: "file", sha256: contentHash("old"), mode: defaultFileMode },
      "gone.txt": { kind: "file", sha256: contentHash("gone"), mode: defaultFileMode },
      "perm.txt": { kind: "file", sha256: contentHash("same"), mode: 0o644 },
    },
    result_records: {
      "added.txt": { kind: "file", sha256: contentHash("added"), mode: defaultFileMode },
      "modified.txt": { kind: "file", sha256: contentHash("new"), mode: defaultFileMode },
      "perm.txt": { kind: "file", sha256: contentHash("same"), mode: 0o755 },
    },
  })}\n`, "utf8");

  const diffed = spawnSync(
    process.execPath,
    [RUNNER, "diff", "--workspace", workspace, "--state-root", stateRoot, "--run", "diff-run", "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(diffed.status, 0, diffed.stderr || diffed.stdout);
  const output = JSON.parse(diffed.stdout.trim());
  assert.equal(output.run_id, "diff-run");
  assert.equal(output.eligible_to_apply, true);
  assert.deepEqual(output.additions, ["added.txt"]);
  assert.deepEqual(output.modifications, ["modified.txt"]);
  assert.deepEqual(output.deletions, ["gone.txt"]);
  assert.deepEqual(output.mode_only, ["perm.txt"]);

  const missingRun = spawnSync(
    process.execPath,
    [RUNNER, "diff", "--workspace", workspace, "--state-root", stateRoot, "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(missingRun.status, 1);
  assert.match(missingRun.stderr, /diff requires --run/);
});

test("apply dry-run checks eligibility and conflicts without writing", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const runDir = path.join(root, "run");
  const resultDir = path.join(runDir, "results");
  const filesRoot = path.join(resultDir, "files");
  await mkdir(filesRoot, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "first.txt"), "first source\n", "utf8");
  await writeFile(path.join(filesRoot, "first.txt"), "first result\n", "utf8");
  await writeFile(
    path.join(resultDir, "metadata.json"),
    `${JSON.stringify({
      version: 1,
      run_id: "dry-run-result",
      terminal_status: "completed",
      verification_passed: true,
      independent_review_passed: true,
      eligible_to_apply: true,
      source_workspace: workspace,
      changed_files: ["first.txt"],
      source_records: { "first.txt": { kind: "file", sha256: contentHash("first source\n"), mode: defaultFileMode } },
      result_records: { "first.txt": { kind: "file", sha256: contentHash("first result\n"), mode: defaultFileMode } },
    })}\n`,
    "utf8",
  );
  await writeFile(path.join(runDir, "completion.json"), `${JSON.stringify({
    run_id: "dry-run-result",
    status: "completed",
    machine_check_evaluation: { application_pass: true },
    independent_review: { status: "completed", gate: "pass" },
  })}\n`, "utf8");

  const checked = await applyResults({ resultDir, workspace, dryRun: true });
  assert.equal(checked.status, "dry-run");
  assert.deepEqual(checked.files_checked, ["first.txt"]);
  assert.equal(checked.writes, 0);
  assert.equal(await readFile(path.join(workspace, "first.txt"), "utf8"), "first source\n");

  await writeFile(path.join(workspace, "first.txt"), "conflicting edit\n", "utf8");
  await assert.rejects(applyResults({ resultDir, workspace, dryRun: true }), /changed since Graph started/);
  assert.equal(await readFile(path.join(workspace, "first.txt"), "utf8"), "conflicting edit\n");
});

test("apply --file applies one manifest path selectively and records a partial application", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  const runDir = path.join(workspaceBucket(stateRoot, workspace), "selective-run");
  const resultDir = path.join(runDir, "results");
  const filesRoot = path.join(resultDir, "files");
  await mkdir(filesRoot, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "first.txt"), "first source\n", "utf8");
  await writeFile(path.join(workspace, "second.txt"), "second source\n", "utf8");
  await writeFile(path.join(filesRoot, "first.txt"), "first result\n", "utf8");
  await writeFile(path.join(filesRoot, "second.txt"), "second result\n", "utf8");
  await writeFile(
    path.join(runDir, "run.json"),
    `${JSON.stringify({ run_id: "selective-run", workspace, status: "completed", created_at: "2026-08-20T00:00:00.000Z" })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(resultDir, "metadata.json"),
    `${JSON.stringify({
      version: 1,
      run_id: "selective-run",
      terminal_status: "completed",
      verification_passed: true,
      independent_review_passed: true,
      eligible_to_apply: true,
      source_workspace: workspace,
      changed_files: ["first.txt", "second.txt"],
      source_records: {
        "first.txt": { kind: "file", sha256: contentHash("first source\n"), mode: defaultFileMode },
        "second.txt": { kind: "file", sha256: contentHash("second source\n"), mode: defaultFileMode },
      },
      result_records: {
        "first.txt": { kind: "file", sha256: contentHash("first result\n"), mode: defaultFileMode },
        "second.txt": { kind: "file", sha256: contentHash("second result\n"), mode: defaultFileMode },
      },
    })}\n`,
    "utf8",
  );
  await writeFile(path.join(runDir, "completion.json"), `${JSON.stringify({
    run_id: "selective-run",
    status: "completed",
    machine_check_evaluation: { application_pass: true },
    independent_review: { status: "completed", gate: "pass" },
  })}\n`, "utf8");

  const dryRun = spawnSync(
    process.execPath,
    [RUNNER, "apply", "--workspace", workspace, "--state-root", stateRoot, "--run", "selective-run", "--file", "first.txt", "--dry-run", "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
  assert.equal(JSON.parse(dryRun.stdout.trim()).status, "dry-run");
  assert.equal(await readFile(path.join(workspace, "first.txt"), "utf8"), "first source\n");
  assert.equal(JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")).application, undefined);

  const applied = spawnSync(
    process.execPath,
    [RUNNER, "apply", "--workspace", workspace, "--state-root", stateRoot, "--run", "selective-run", "--file", "first.txt", "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  assert.equal(JSON.parse(applied.stdout.trim()).files_applied.length, 1);
  assert.equal(await readFile(path.join(workspace, "first.txt"), "utf8"), "first result\n");
  assert.equal(await readFile(path.join(workspace, "second.txt"), "utf8"), "second source\n");
  const savedRun = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
  assert.equal(savedRun.application.status, "partial_application");
  assert.deepEqual(savedRun.application.files, ["first.txt"]);
  const events = await readFile(path.join(runDir, "events", "events.jsonl"), "utf8");
  assert.match(events, /RunPartiallyApplied/);

  const unknownFile = spawnSync(
    process.execPath,
    [RUNNER, "apply", "--workspace", workspace, "--state-root", stateRoot, "--run", "selective-run", "--file", "not-in-manifest.txt", "--dry-run", "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(unknownFile.status, 1);
  assert.match(unknownFile.stderr, /not in the Run manifest/);
});

test("recheck guards refuse invalid scopes, unfinished runs, and drifted results", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "tracked.txt"), "unchanged\n", "utf8");

  async function recheckSpawn(runId, extraArgs) {
    return spawnSync(
      process.execPath,
      [RUNNER, "recheck", "--workspace", workspace, "--state-root", stateRoot, "--run", runId, ...extraArgs],
      { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
    );
  }
  async function writeGuardRun(runId, { status = "completed", nodes = null, metadata = null, afterManifest = true } = {}) {
    const runDir = path.join(workspaceBucket(stateRoot, workspace), runId);
    await mkdir(path.join(runDir, "results"), { recursive: true });
    await writeFile(
      path.join(runDir, "run.json"),
      `${JSON.stringify({
        run_id: runId,
        workspace,
        status,
        created_at: "2026-08-20T00:00:00.000Z",
        ...(nodes ? { nodes } : {}),
        plan: { required_checks: [{ id: "apply-check", command: ["node", "-e", ""], blocking_scope: "apply" }] },
      })}\n`,
      "utf8",
    );
    if (metadata) {
      await writeFile(
        path.join(runDir, "results", "metadata.json"),
        `${JSON.stringify({ version: 1, run_id: runId, terminal_status: "completed", ...metadata })}\n`,
        "utf8",
      );
    }
    if (afterManifest) {
      await writeFile(path.join(runDir, "workspace-after.json"), `${JSON.stringify(await captureWorkspaceManifest(workspace))}\n`, "utf8");
    }
    return runDir;
  }

  const reviewPassed = { independent_review: { kind: "independent_review", status: "completed", gate: "pass" } };

  await writeGuardRun("guard-scope", { nodes: reviewPassed, metadata: {}, afterManifest: false });
  const badScope = await recheckSpawn("guard-scope", ["--scope", "both", "--json"]);
  assert.equal(badScope.status, 1);
  assert.match(badScope.stderr, /recheck scope must be apply or release/);

  await writeGuardRun("guard-status", { status: "completed_with_gaps", nodes: reviewPassed, metadata: {}, afterManifest: false });
  const notCompleted = await recheckSpawn("guard-status", ["--scope", "apply", "--json"]);
  assert.equal(notCompleted.status, 1);
  assert.match(notCompleted.stderr, /recheck requires a completed Run/);

  await writeGuardRun("guard-review", { metadata: {}, afterManifest: false });
  const missingReview = await recheckSpawn("guard-review", ["--scope", "apply", "--json"]);
  assert.equal(missingReview.status, 1);
  assert.match(missingReview.stderr, /original independent review to have passed/);

  await writeGuardRun("guard-metadata", { nodes: reviewPassed, afterManifest: false });
  const missingMetadata = await recheckSpawn("guard-metadata", ["--scope", "apply", "--json"]);
  assert.equal(missingMetadata.status, 1);
  assert.match(missingMetadata.stderr, /frozen result metadata/);

  await writeGuardRun("guard-drift", { nodes: reviewPassed, metadata: {} });
  await writeFile(path.join(workspace, "tracked.txt"), "drifted\n", "utf8");
  const drifted = await recheckSpawn("guard-drift", ["--scope", "apply", "--json"]);
  assert.equal(drifted.status, 1);
  assert.match(drifted.stderr, /Frozen Run result changed/);
});

test("recheck returns already-satisfied without starting a model process", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "tracked.txt"), "unchanged\n", "utf8");
  const runDir = path.join(workspaceBucket(stateRoot, workspace), "satisfied-run");
  await mkdir(path.join(runDir, "results"), { recursive: true });
  await writeFile(
    path.join(runDir, "run.json"),
    `${JSON.stringify({
      run_id: "satisfied-run",
      workspace,
      status: "completed",
      created_at: "2026-08-20T00:00:00.000Z",
      nodes: { independent_review: { kind: "independent_review", status: "completed", gate: "pass" } },
      plan: {
        required_checks: [
          { id: "apply-check", command: ["node", "-e", ""], blocking_scope: "apply" },
          { id: "release-check", command: ["node", "-e", ""], blocking_scope: "release" },
        ],
      },
      machine_check_evaluation: { checks: [{ id: "apply-check", status: "pass" }] },
    })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(runDir, "results", "metadata.json"),
    `${JSON.stringify({ version: 1, run_id: "satisfied-run", terminal_status: "completed", eligible_to_apply: true })}\n`,
    "utf8",
  );
  await writeFile(path.join(runDir, "workspace-after.json"), `${JSON.stringify(await captureWorkspaceManifest(workspace))}\n`, "utf8");

  const rechecked = spawnSync(
    process.execPath,
    [RUNNER, "recheck", "--workspace", workspace, "--state-root", stateRoot, "--run", "satisfied-run", "--scope", "apply", "--json"],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(rechecked.status, 0, rechecked.stderr || rechecked.stdout);
  const output = JSON.parse(rechecked.stdout.trim());
  assert.equal(output.status, "already-satisfied");
  assert.equal(output.scope, "apply");
  assert.deepEqual(output.checks, []);
  assert.equal(output.writes, 0);
  const savedRun = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
  assert.equal(savedRun.rechecks, undefined);
});

test("effective review limits shrink for small workspaces and never below audit domains", async (t) => {
  const root = await temporaryDirectory(t);
  const small = path.join(root, "small");
  const large = path.join(root, "large", "src");
  await mkdir(small, { recursive: true });
  await mkdir(large, { recursive: true });
  await writeFile(path.join(small, "fixture.txt"), "small fixture\n", "utf8");
  for (let index = 0; index < 40; index += 1) {
    await writeFile(path.join(large, `module-${index}.mjs`), `export const value = ${index};\n`, "utf8");
  }

  const taskSmall = await effectiveReviewLimits({ workspace: small, mode: "task", explicit: false, perWave: 6, total: 12 });
  assert.equal(taskSmall.perWave, 2);
  assert.equal(taskSmall.total, 2);
  assert.equal(taskSmall.scaling.applied, true);
  assert.equal(taskSmall.scaling.configured.per_wave, 6);

  const auditSmall = await effectiveReviewLimits({ workspace: small, mode: "audit", explicit: false, perWave: 6, total: 12 });
  assert.equal(auditSmall.perWave, 4);
  assert.equal(auditSmall.total, 4);
  assert.equal(auditSmall.scaling.applied, true);

  const auditLarge = await effectiveReviewLimits({ workspace: path.join(root, "large"), mode: "audit", explicit: false, perWave: 6, total: 12 });
  assert.equal(auditLarge.perWave, 6);
  assert.equal(auditLarge.total, 12);
  assert.equal(auditLarge.scaling.applied, false);

  const pinned = await effectiveReviewLimits({ workspace: small, mode: "audit", explicit: true, perWave: 6, total: 12 });
  assert.equal(pinned.perWave, 6);
  assert.equal(pinned.total, 12);
  assert.equal(pinned.scaling.applied, false);
});

test("loop nodes scope correction rounds to the failures that caused them", () => {
  const plan = {
    verification_skills: ["fixture-review"],
    implementation_skills: [],
    review_nodes: [{ id: "review-engineering", skills: ["fixture-review"] }],
  };

  const roundZero = makeLoopNode("verification", 0, "implementation", plan, {
    machine_check_evaluation: { checks: [{ id: "check-a", status: "fail" }] },
  });
  assert.equal(roundZero.incremental_check_ids, undefined);
  assert.doesNotMatch(roundZero.focus, /Incremental re-verification/);

  const priorEvaluation = {
    checks: [
      { id: "check-a", status: "pass" },
      { id: "check-b", status: "fail" },
      { id: "check-b", status: "claim_missing" },
    ],
  };
  assert.deepEqual(unsatisfiedCheckIds(priorEvaluation), ["check-b"]);
  assert.deepEqual(unsatisfiedCheckIds({ checks: [{ id: "check-ok", status: "pass" }] }), []);

  const incremental = makeLoopNode("verification", 1, "correction-r1", plan, { machine_check_evaluation: priorEvaluation });
  assert.deepEqual(incremental.incremental_check_ids, ["check-b"]);
  assert.match(incremental.focus, /check-b/);
  assert.ok(!incremental.focus.includes("check-a"));

  const reviewRoundZero = makeLoopNode("independent_review", 0, "verification-r0", plan, {
    findings: [{ id: "F1" }],
    blockers: [{ reason: "rejected" }],
  });
  assert.doesNotMatch(reviewRoundZero.focus, /Incremental fresh-context review/);

  const reviewIncremental = makeLoopNode("independent_review", 1, "verification-r1", plan, {
    findings: [{ id: "F1", fingerprint: "fp-edge-case", title: "missed edge case" }],
    blockers: [{ reason: "the fix missed an edge case" }],
  });
  assert.match(reviewIncremental.focus, /Incremental fresh-context review/);
  assert.match(reviewIncremental.focus, /the fix missed an edge case/);
  assert.match(reviewIncremental.focus, /fp-edge-case/);
});

test("a small-workspace run records auto review scaling without shrinking coverage below its floor", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "small fixture\n", "utf8");
  await writeSkill(path.join(workspace, ".codex"), "fixture-review", "Review the graph fixture");
  const execution = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--goal",
      "Audit the fixture workspace",
      "--workspace-mode",
      "live",
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: { ...process.env, AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]) },
    },
  );
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const summary = JSON.parse(execution.stdout.trim());
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  assert.equal(run.options.review_limits_explicit, false);
  assert.equal(run.plan.coverage.auto_review_scaling.applied, true);
  assert.equal(run.plan.coverage.auto_review_scaling.workspace_files > 0, true);
  const reviewNodes = run.node_order.filter((id) => id.startsWith("review-"));
  assert.ok(reviewNodes.length >= 1 && reviewNodes.length <= 2, `unexpected review fan-out: ${reviewNodes.join(", ")}`);
});

test("independent review dependencies carry machine facts without self-reported prose", () => {
  const verificationResult = {
    status: "completed",
    gate: "pass",
    summary: "all checks passed",
    evidence: [{ claim: "agent claims success".repeat(20), source: "fake-check", kind: "tool" }],
    findings: [{
      id: "FIND-1",
      severity: "high",
      title: "edge case defect",
      evidence: "long self-reported evidence prose ".repeat(30),
      recommended_action: "long recommended action ".repeat(20),
      fingerprint: "fp-find-1",
      related_finding_ids: [],
      validation: "reproduced",
      disposition: "fixed",
    }],
    blockers: [],
    files_changed: ["src/one.mjs", "src/two.mjs"],
    checks: [{ id: "fixture-verification", status: "pass", command: "fake-check verification", finding_ids: [] }],
    machine_check_evaluation: { checks: [{ id: "fixture-verification", status: "pass" }] },
  };

  const reviewerContext = compactResultForDependency(
    "verification-r1",
    verificationResult,
    { kind: "independent_review" },
    {},
  );
  assert.equal(reviewerContext.findings.length, 1);
  assert.equal(reviewerContext.findings[0].fingerprint, "fp-find-1");
  assert.equal(reviewerContext.findings[0].disposition, "fixed");
  assert.equal(reviewerContext.findings[0].evidence, undefined);
  assert.equal(reviewerContext.evidence, undefined);
  assert.deepEqual(reviewerContext.machine_check_evaluation, [{ id: "fixture-verification", status: "pass" }]);
  assert.deepEqual(reviewerContext.files_changed, ["src/one.mjs", "src/two.mjs"]);
  assert.match(reviewerContext.upstream_scope_note, /fresh-context reviewer/);

  const correctionContext = compactResultForDependency(
    "verification-r1",
    verificationResult,
    { kind: "correction" },
    {},
  );
  assert.ok(correctionContext.findings[0].evidence.includes("self-reported evidence prose"));
  assert.equal(correctionContext.evidence.length, 1);
  assert.equal(correctionContext.machine_check_evaluation, undefined);
});

test("the workspace file map is bounded and skips generated directories", async (t) => {
  const root = await temporaryDirectory(t);
  await mkdir(path.join(root, "src", "nested"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "dep"), { recursive: true });
  await mkdir(path.join(root, ".git", "objects"), { recursive: true });
  await writeFile(path.join(root, "src", "app.mjs"), "export const app = 1;\n", "utf8");
  await writeFile(path.join(root, "src", "nested", "util.mjs"), "export const util = 1;\n", "utf8");
  await writeFile(path.join(root, "node_modules", "dep", "index.js"), "ignored\n", "utf8");
  await writeFile(path.join(root, ".git", "objects", "pack.dat"), "ignored\n", "utf8");

  const map = await workspaceFileMap(root);
  assert.equal(map.truncated, false);
  assert.ok(map.files.includes("src/app.mjs"));
  assert.ok(map.files.includes("src/nested/util.mjs"));
  assert.ok(!map.files.includes("node_modules"));
  assert.ok(!map.files.includes(".git"));
  assert.equal(map.count, 2);

  const capped = path.join(root, "capped");
  await mkdir(capped, { recursive: true });
  for (let index = 0; index < 250; index += 1) {
    await writeFile(path.join(capped, `file-${index}.txt`), "x\n", "utf8");
  }
  const truncatedMap = await workspaceFileMap(capped);
  assert.equal(truncatedMap.truncated, true);
  assert.equal(truncatedMap.count, 200);
});

test("review dry-run records the module map and opt-in static Android preflight", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(path.join(workspace, "app", "src", "main"), { recursive: true });
  await writeFile(path.join(workspace, "settings.gradle.kts"), 'include(":app", ":screenshot-demo")\n', "utf8");
  await writeFile(path.join(workspace, "app", "build.gradle.kts"), 'plugins { id("com.android.application") }\n', "utf8");
  await writeFile(path.join(workspace, "app", "src", "main", "AndroidManifest.xml"), "<manifest />\n", "utf8");
  const execution = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--workspace-mode",
      "live",
      "--mode",
      "review",
      "--machine-preflight",
      "--dry-run",
      "--goal",
      "Review the Android module layout",
      "--json",
    ],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: { ...process.env, AEG_DISABLE_NOTIFICATIONS: "1" } },
  );
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const summary = JSON.parse(execution.stdout.trim());
  assert.equal(summary.status, "planned");
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  assert.equal(run.machine_preflight.readiness, "gaps");
  assert.equal(run.machine_preflight.gradle_probe, "not_requested");
  const map = JSON.parse(await readFile(path.join(summary.run_dir, "workspace-module-map.json"), "utf8"));
  assert.ok(map.gradle.missing_modules.some((module) => module.project_path === ":screenshot-demo"));
  const preflight = JSON.parse(await readFile(path.join(summary.run_dir, "machine-preflight.json"), "utf8"));
  assert.equal(preflight.probe.status, "not_requested");
  assert.ok(preflight.gaps.some((gap) => gap.kind === "gradle-module"));
  assert.match(await readFile(summary.report, "utf8"), /Android\/Gradle Machine Preflight/);
});

test("opt-in Gradle machine preflight records wrapper command evidence", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(path.join(workspace, "app", "src", "main"), { recursive: true });
  await writeFile(path.join(workspace, "settings.gradle.kts"), 'include(":app")\n', "utf8");
  await writeFile(path.join(workspace, "app", "build.gradle.kts"), 'plugins { id("com.android.application") }\n', "utf8");
  await writeFile(path.join(workspace, "app", "src", "main", "AndroidManifest.xml"), "<manifest />\n", "utf8");
  const wrapperName = process.platform === "win32" ? "gradlew.bat" : "gradlew";
  const wrapperContents = process.platform === "win32"
    ? "@echo off\r\nif \"%1\"==\"projects\" echo Root project 'fixture'\r\nexit /b 0\r\n"
    : "#!/bin/sh\nif [ \"$1\" = \"projects\" ]; then echo \"Root project 'fixture'\"; fi\nexit 0\n";
  await writeFile(path.join(workspace, wrapperName), wrapperContents, "utf8");
  if (process.platform !== "win32") await chmod(path.join(workspace, wrapperName), 0o755);

  const execution = spawnSync(
    process.execPath,
    [
      RUNNER,
      "start",
      "--user-approved",
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--workspace-mode",
      "live",
      "--mode",
      "review",
      "--machine-preflight-gradle",
      "--dry-run",
      "--goal",
      "Probe the Android module layout",
      "--json",
    ],
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT, env: { ...process.env, AEG_DISABLE_NOTIFICATIONS: "1" } },
  );
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const summary = JSON.parse(execution.stdout.trim());
  const preflight = JSON.parse(await readFile(path.join(summary.run_dir, "machine-preflight.json"), "utf8"));
  assert.equal(preflight.probe.status, "pass");
  assert.equal(preflight.probe.command_count, 1);
  assert.equal(preflight.probe.commands[0].kind, "projects");
  assert.deepEqual(preflight.probe.commands[0].args, ["projects", "--no-daemon", "--console=plain"]);
  assert.equal(preflight.probe.commands[0].cwd, await realpath(workspace));
  assert.equal(preflight.probe.commands[0].exit_code, 0);
  assert.match(preflight.probe.commands[0].command_line, /gradlew/);
  assert.equal(preflight.probe.commands[0].surface_truncated, false);
  assert.equal(summary.status, "planned");
});
