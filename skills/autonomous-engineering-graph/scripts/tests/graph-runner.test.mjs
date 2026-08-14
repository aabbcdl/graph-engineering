import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  atomicWriteJson,
  acquireLock,
  acquireModelSlot,
  AGENT_BACKENDS,
  assertRunCanResume,
  catalogForPlanner,
  captureWorkspaceManifest,
  childEnvironment,
  claudeAgentArgs,
  claudeLastMessageFromEvents,
  commandExecutables,
  compileGraph,
  configuredGitAliases,
  dependencyGateSatisfied,
  dependencyContext,
  diffManifests,
  discoverSkills,
  ensureNodeResultConsistency,
  fallbackBackendOrder,
  generateReport,
  httpStatusesInEvidence,
  inspectModelQueue,
  isolatedCodexConfigArgs,
  latestCompletedCorrection,
  listRuns,
  modelQueueRoot,
  modelCapacityOutcome,
  mergeRunOptionsForResume,
  backendEndpointKey,
  normalizeAgentBackend,
  newestWorkingCodexInvocation,
  nodeSandboxMode,
  nodeInputBudget,
  nodeInputBudgetError,
  normalizeQueueScope,
  normalizePlannerResult,
  optionsForResume,
  parseArgs,
  permanentBackendFailure,
  proofFromClaudeEvents,
  proofFromEvents,
  queueMutexContentionError,
  replaceFileWithRetry,
  RedactingLineTransform,
  resolveCodexInvocation,
  separateCodexHomeRequired,
  runtimeSnapshot,
  runPool,
  saveRun,
  transientExecutionFailure,
  waitForBackgroundHandoff,
  workspaceBucket,
} from "../graph-runner.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(TEST_DIR, "..", "graph-runner.mjs");
const RESTORE = path.resolve(TEST_DIR, "..", "restore-run.mjs");
const APPLY_RESULTS = path.resolve(TEST_DIR, "..", "apply-results.mjs");
const INSTALLER = path.resolve(TEST_DIR, "..", "..", "..", "..", "scripts", "install.mjs");
const FAKE_NOTIFIER = path.join(TEST_DIR, "fake-notifier.mjs");
const FAKE_CODEX = path.join(TEST_DIR, "fake-codex.mjs");
const INTEGRATION_TIMEOUT = 60_000;
const TEST_QUEUE_ROOT = path.join(os.tmpdir(), `aeg-test-model-queue-${process.pid}`);
process.env.AEG_MODEL_QUEUE_ROOT = TEST_QUEUE_ROOT;
process.env.AEG_WORKSPACE_MODE = "live";
process.env.AEG_DISABLE_NOTIFICATIONS = "1";
after(async () => rm(TEST_QUEUE_ROOT, { recursive: true, force: true }));

function contentHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aeg-test-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
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
  assert.deepEqual(parseArgs(["resume", "--background", "--run", "fixture"]), {
    command: "resume",
    options: { background: true, run: "fixture" },
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
    "--supervision <stage|off>",
    "--role-model <role=model>",
    "--role-effort <role=effort>",
    "--role-backend <role=backend>",
    "--notify / --no-notify",
    "--notification-command <command>",
  ]) {
    assert.match(help.stdout, new RegExp(option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(help.stdout, /completion\.json/);
  assert.match(help.stdout, /results[\\/]apply\.mjs/);

  const startHelp = spawnSync(process.execPath, [RUNNER, "start", "--help"], { encoding: "utf8", timeout: INTEGRATION_TIMEOUT });
  assert.equal(startHelp.status, 0, startHelp.stderr || startHelp.stdout);
  assert.match(startHelp.stdout, /isolated snapshot/i);
  assert.match(startHelp.stdout, /stage supervision/i);
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

test("skill metadata disables implicit invocation", async () => {
  const metadata = await readFile(path.resolve(TEST_DIR, "..", "..", "agents", "openai.yaml"), "utf8");
  assert.match(metadata, /allow_implicit_invocation:\s*false/);
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

test("claude node arguments deny file mutation for a read-only node", () => {
  const readOnly = claudeAgentArgs({
    schema: "{}",
    workspace: "C:\\fixture\\workspace",
    sandbox: "read-only",
    model: null,
    isolatedConfig: true,
    mcpConfigPath: "C:\\fixture\\mcp.json",
  });
  assert.ok(readOnly.includes("--disallowedTools"));
  assert.ok(readOnly.includes("Write"));
  assert.ok(readOnly.includes("--strict-mcp-config"));
  // Every node needs the shell to run its own verification commands without an
  // interactive approver.
  assert.ok(readOnly.includes("--allowed-tools"));
  assert.ok(readOnly.includes("PowerShell") || readOnly.includes("Bash"));

  const writer = claudeAgentArgs({
    schema: "{}",
    workspace: "C:\\fixture\\workspace",
    sandbox: "workspace-write",
    model: "fixture-model",
    reasoningEffort: "xhigh",
    isolatedConfig: true,
    mcpConfigPath: "C:\\fixture\\mcp.json",
  });
  assert.equal(writer.includes("--disallowedTools"), false);
  assert.ok(writer.includes("Edit"));
  assert.ok(writer.includes("--model"));
  assert.ok(writer.includes("fixture-model"));
  assert.deepEqual(writer.slice(writer.indexOf("--effort"), writer.indexOf("--effort") + 2), ["--effort", "xhigh"]);

  const ultra = claudeAgentArgs({
    schema: "{}",
    workspace: "C:\\fixture\\workspace",
    sandbox: "read-only",
    model: null,
    reasoningEffort: "ultra",
    isolatedConfig: false,
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

test("Codex invocation selection prefers the newest working CLI", () => {
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
  assert.equal(
    newestWorkingCodexInvocation(candidates, (candidate) => versions.get(candidate.command)).command,
    "desktop-codex",
  );
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

test("bundled graph specialist names cannot be shadowed by a project skill", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const codexHome = path.join(root, "codex-home");
  await writeSkill(path.join(workspace, ".codex"), "graph-security-privacy", "untrusted project shadow");
  await writeSkill(path.join(workspace, ".codex"), "graph-release-assurance-override", "untrusted graph namespace");
  await writeSkill(codexHome, "graph-security-privacy", "trusted global specialist");
  const catalog = await discoverSkills(workspace, codexHome);
  const specialist = catalog.find((skill) => skill.name === "graph-security-privacy");
  assert.equal(specialist?.origin, "global");
  assert.equal(specialist?.description, "trusted global specialist");
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
  process.env.GRAPH_TEST_SECRET_TOKEN = "must-not-cross-boundary";
  process.env.GIT_CONFIG_GLOBAL = path.join(os.tmpdir(), "graph-test-global.gitconfig");
  try {
    const environment = childEnvironment();
    assert.equal(environment.GRAPH_TEST_SECRET_TOKEN, undefined);
    assert.equal(environment.AUTONOMOUS_GRAPH_NODE, "1");
    assert.equal(environment.GIT_CONFIG_GLOBAL, process.env.GIT_CONFIG_GLOBAL);
    assert.ok(environment.PATH || environment.Path);
  } finally {
    if (previous === undefined) delete process.env.GRAPH_TEST_SECRET_TOKEN;
    else process.env.GRAPH_TEST_SECRET_TOKEN = previous;
    if (previousGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGitConfigGlobal;
  }
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

test("child environment preserves the Git config source used by workspace snapshots", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "workspace");
  const gitConfigGlobal = path.join(root, "global.gitconfig");
  await mkdir(workspace, { recursive: true });
  await writeFile(gitConfigGlobal, "[alias]\n  graph-status = status\n", "utf8");
  const previousGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = gitConfigGlobal;
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
  } finally {
    if (previousGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGitConfigGlobal;
  }
});

test("Codex resolution ignores workspace-local command shims", async (t) => {
  const workspace = await temporaryDirectory(t);
  await writeFile(path.join(workspace, "codex.cmd"), "@echo unsafe\n", "utf8");
  await writeFile(path.join(workspace, "codex.ps1"), "Write-Output unsafe\n", "utf8");
  const previous = process.env.AEG_CODEX_COMMAND_JSON;
  delete process.env.AEG_CODEX_COMMAND_JSON;
  try {
    const invocation = resolveCodexInvocation(workspace);
    const candidates = [invocation.command, ...invocation.prefix].filter((value) => path.isAbsolute(value));
    for (const candidate of candidates) {
      const relation = path.relative(workspace, candidate);
      assert.ok(relation.startsWith("..") || path.isAbsolute(relation));
    }
  } finally {
    if (previous !== undefined) process.env.AEG_CODEX_COMMAND_JSON = previous;
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

test("a required command counts when it runs inside an exit-code-capturing wrapper", () => {
  // A verifier legitimately wraps the planned command to read its exit code.
  // The real command text still has to appear in a successful host event.
  const wrapper =
    '"---FULL-TEST-SUITE---"; $o = node --test *>&1 | Out-String; "TEST_EXIT=$LASTEXITCODE"; $o';
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

test("a paraphrased command claim is accepted while a fabricated one is not", () => {
  // A verifier commonly reports several probes as one summarised line. That is
  // not a fabricated claim as long as the same executables really ran.
  const observed = [
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
    { commands: observed, tool_calls: [{ type: "command_execution", status: "completed" }] },
    [],
    [],
    [{ id: "suite", description: "Run the suite", command: "node --test", source: "planner" }],
  );
  assert.equal(paraphrased.gate, "pass");
  assert.equal(paraphrased.findings.some((f) => String(f.id).startsWith("RUNNER-")), false);

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
    { commands: observed, tool_calls: [{ type: "command_execution", status: "completed" }] },
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
  const skillPath = "D:\\ai-data\\skills\\codex-skills\\autonomous-engineering-graph\\SKILL.md";
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
  const error = nodeInputBudgetError({ id: "synthesis", kind: "synthesis" }, 200_000, 192_000);
  assert.equal(error.code, "NODE_INPUT_BUDGET_EXCEEDED");
  assert.equal(error.input_bytes, 200_000);
  assert.equal(error.budget_bytes, 192_000);
  assert.match(error.message, /before contacting a model/);
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
  assert.equal(summary.status, "blocked");
  const run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8"));
  assert.equal(run.blocker.type, "NODE_INPUT_BUDGET_EXCEEDED");
  assert.match(run.blocker.reason, /NODE_INPUT_BUDGET_EXCEEDED|exceeding the .* budget/);
  assert.equal(run.blocker.node_id, "discovery");
  assert.equal(run.blocker.input_bytes > run.blocker.budget_bytes, true);
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

test("stale run locks are reclaimed while active locks are rejected", async (t) => {
  const runDir = await temporaryDirectory(t);
  await writeFile(path.join(runDir, ".lock"), "99999999\n2000-01-01T00:00:00Z\n", "utf8");
  const release = await acquireLock(runDir);
  await assert.rejects(acquireLock(runDir), /already active/);
  await release();
  assert.equal(await readFile(path.join(runDir, ".lock"), "utf8").catch(() => null), null);
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
      "--workspace",
      workspace,
      "--state-root",
      stateRoot,
      "--run",
      paused.run_id,
      "--timeout-minutes",
      "1",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: INTEGRATION_TIMEOUT,
      env: { ...environment, AEG_FAKE_SCENARIO: "happy" },
    },
  );
  assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
  const completed = JSON.parse(resumed.stdout.trim());
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
    AEG_FAKE_HOLD_MS: "50",
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
    return queue.waiting.some((request) => request.workspace_key === createHash("sha256").update(
      process.platform === "win32" ? path.resolve(workspace).toLowerCase() : path.resolve(workspace),
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

test("stop terminates an active model child and releases its workspace lease", async (t) => {
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
  }, { message: "active model child" });

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
    if (legacyRunner.exitCode === null) legacyRunner.kill();
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
  await waitFor(() => legacyRunner.exitCode !== null, { message: "legacy runner termination" });
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
  assert.equal(blocked.status, "blocked");
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
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const summary = JSON.parse(execution.stdout.trim());
  assert.equal(summary.status, "completed");
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
  assert.doesNotMatch(verificationInput, /[A-Z]:\\[^\n"]*autonomous-engineering-graph/i);
  assert.doesNotMatch(verificationInput, /## Capacity And Service Failure/);
  assert.ok(Buffer.byteLength(verificationInput) < 90_000, `verification input was ${Buffer.byteLength(verificationInput)} bytes`);
  const independentProof = JSON.parse(
    await readFile(path.join(summary.run_dir, "nodes", "independent-review-r0", "proof.json"), "utf8"),
  );
  assert.equal(independentProof.supplied_skills[0].name, "graph-release-assurance");
  const independentInput = await readFile(path.join(summary.run_dir, "nodes", "independent-review-r0", "input.md"), "utf8");
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
      timeout: INTEGRATION_TIMEOUT,
      env: { ...process.env, AEG_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CODEX]) },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout.trim());
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
    AEG_FAKE_SCENARIO: "owner-gate",
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
    path.join(lockDir, ".lock"),
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
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Refusing to update Graph.*run_lock/s);
  assert.equal(await readFile(path.join(codexHome, "skills", "autonomous-engineering-graph", "SKILL.md"), "utf8").catch(() => null), null);

  await writeFile(
    path.join(lockDir, ".lock"),
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
    { encoding: "utf8", timeout: INTEGRATION_TIMEOUT },
  );
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const output = JSON.parse(installed.stdout.trim());
  assert.equal(output.status, "installed");
  assert.equal(output.skills.includes("autonomous-engineering-graph"), true);
  assert.match(await readFile(path.join(codexHome, "skills", "autonomous-engineering-graph", "SKILL.md"), "utf8"), /explicitly requests Graph/i);
  assert.match(await readFile(path.join(binDir, process.platform === "win32" ? "graph-engineering.cmd" : "graph-engineering"), "utf8"), /graph-runner\.mjs/);
  assert.deepEqual((await readdir(path.join(codexHome, "skills"))).filter((name) => name.startsWith(".graph-engineering-")), []);
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
