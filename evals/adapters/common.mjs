import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { harnessIdentity } from "../lib/pair-runner.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function requiredArgument(name) {
  const value = argument(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function pathIsInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalPath(target) {
  const resolved = path.resolve(target);
  let existing = resolved;
  while (!existsSync(existing)) {
    try {
      if (lstatSync(existing).isSymbolicLink()) return null;
    } catch (error) {
      if (error?.code !== "ENOENT") return null;
    }
    const parent = path.dirname(existing);
    if (parent === existing) return null;
    existing = parent;
  }
  try {
    const canonicalExisting = realpathSync(existing);
    return path.join(canonicalExisting, resolved.slice(existing.length).replace(/^[/\\]+/, ""));
  } catch {
    return null;
  }
}

function pathsOverlap(left, right) {
  return pathIsInside(left, right) || pathIsInside(right, left);
}

function gitInspectionEnvironment(sourceEnvironment = process.env) {
  const environment = { ...sourceEnvironment };
  for (const key of Object.keys(environment)) {
    // Ambient Git redirectors can make rev-parse inspect a different checkout
    // or index than the workspace supplied by the harness.
    if (/^GIT_/i.test(key)) delete environment[key];
  }
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

function workspaceGitRoot(workspace) {
  const result = spawnSync("git", ["-C", path.resolve(workspace), "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: gitInspectionEnvironment(),
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  const root = String(result.stdout || "").trim();
  return root || null;
}

function evaluationStateRoot({ output, workspace }) {
  const resolvedOutput = path.resolve(output);
  const candidate = path.join(path.dirname(resolvedOutput), "graph-state");
  const sourceRoot = workspaceGitRoot(workspace) || path.resolve(workspace);
  const canonicalSourceRoot = canonicalPath(sourceRoot);
  const canonicalCandidate = canonicalPath(candidate);
  if (!canonicalSourceRoot || !canonicalCandidate) {
    throw new Error("Evaluation state root could not be canonicalized safely");
  }
  if (!pathsOverlap(canonicalSourceRoot, canonicalCandidate)) return candidate;

  const identity = createHash("sha256")
    .update(`${path.resolve(workspace)}\0${resolvedOutput}`)
    .digest("hex")
    .slice(0, 20);
  const fallback = path.join(path.resolve(os.tmpdir()), "graph-engineering-eval-state", identity);
  const canonicalFallback = canonicalPath(fallback);
  if (!canonicalFallback || pathsOverlap(canonicalSourceRoot, canonicalFallback)) {
    throw new Error("Evaluation state root must be outside the source checkout");
  }
  return fallback;
}

function optionalPositiveNumber(name) {
  const value = argument(name);
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

function evaluationArguments() {
  const fixtureId = requiredArgument("--fixture-id");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(fixtureId)) throw new Error("Invalid fixture id");
  return {
    workspace: path.resolve(requiredArgument("--workspace")),
    goalFile: path.resolve(requiredArgument("--goal-file")),
    output: path.resolve(requiredArgument("--output")),
    model: requiredArgument("--model"),
    reasoningEffort: requiredArgument("--reasoning-effort"),
    tokenBudget: Number.parseInt(requiredArgument("--token-budget"), 10),
    harnessFile: path.resolve(requiredArgument("--harness-file")),
    timeoutMinutes: optionalPositiveNumber("--timeout-minutes"),
    arm: requiredArgument("--arm"),
    fixtureId,
    repetition: Number.parseInt(requiredArgument("--repetition"), 10),
  };
}

async function readHarness(args) {
  return JSON.parse(await readFile(args.harnessFile, "utf8"));
}

async function reportedHarnessIdentity(args, additions = {}) {
  const expected = await readHarness(args);
  return {
    ...await harnessIdentity({
      manifestSha256: expected.manifest_sha256,
      budgetContract: expected.budget_contract || null,
      toolchain: expected.toolchain_contract || expected.toolchain || null,
    }),
    ...additions,
  };
}

function graphRunnerArguments({
  runner,
  workspace,
  goal,
  model,
  reasoningEffort,
  tokenBudget,
  timeoutMinutes,
  maxCorrections,
  stateRoot,
}) {
  const args = [
    runner,
    "start",
    "--workspace", workspace,
    "--workspace-mode", "auto",
    "--supervision", "stage",
    "--goal", goal,
    "--user-approved",
    "--agent-backend", "codex",
    "--no-agent-fallback",
    "--model", model,
    "--reasoning-effort", reasoningEffort,
    "--max-parallel", "2",
    "--workspace-read-lanes", "2",
    "--max-corrections", maxCorrections,
    "--max-run-tokens", String(tokenBudget),
    "--service-retry-minutes", "10",
    "--max-service-failures", "3",
    "--queue-wait-minutes", "60",
    "--state-root", stateRoot,
    "--no-notify",
    "--json",
  ];
  if (Number.isFinite(timeoutMinutes) && timeoutMinutes > 0) {
    args.push("--max-run-minutes", String(timeoutMinutes));
  }
  return args;
}

async function loadEvaluator(fixtureId) {
  const target = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", `${fixtureId}.evaluator.mjs`);
  await access(target);
  return import(pathToFileURL(target).href);
}

function normalizedUsage(usage) {
  if (
    !usage ||
    !Number.isSafeInteger(usage.input_tokens) ||
    usage.input_tokens < 0 ||
    !Number.isSafeInteger(usage.output_tokens) ||
    usage.output_tokens < 0
  ) return null;
  return {
    input_tokens: Number(usage.input_tokens),
    output_tokens: Number(usage.output_tokens),
  };
}

function isRepositoryFinding(finding) {
  const observations = Array.isArray(finding?.observations) ? finding.observations : [];
  if (!observations.length) return true;
  return !observations.every((observation) =>
    String(observation?.id || "").toUpperCase().startsWith("RUNNER-"),
  );
}

async function finishEvaluation({ args, status, usage, queueMs, rawFindings, completedGates, artifacts = {}, identity = null, budgetEnforcement = null }) {
  const harness = await readHarness(args);
  const evaluator = await loadEvaluator(args.fixtureId);
  const graded = await evaluator.evaluate(args.workspace, rawFindings);
  const reportedIdentity = identity && typeof identity === "object" ? { ...identity } : identity;
  if (harness.toolchain_contract) {
    // The evaluator is the authority for what binary actually ran. A mere
    // manifest echo is not enough to make a toolchain-bound pair comparable.
    reportedIdentity.toolchain_contract = graded.toolchain_contract || null;
  }
  const result = {
    status,
    model: args.model,
    reasoning_effort: args.reasoningEffort,
    token_budget: args.tokenBudget,
    timeout_minutes: args.timeoutMinutes,
    usage: normalizedUsage(usage),
    ...(budgetEnforcement ? { budget_enforcement: budgetEnforcement } : {}),
    harness_identity: reportedIdentity,
    findings: graded.findings,
    regression_checks: graded.regression_checks,
    completed_gates: completedGates && graded.regression_checks.every((check) => check.status === "pass"),
    queue_ms: Number.isFinite(queueMs) ? queueMs : 0,
    artifacts,
  };
  await writeFile(args.output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

async function readGoal(args) {
  return (await readFile(args.goalFile, "utf8")).trim();
}

export {
  evaluationArguments,
  evaluationStateRoot,
  finishEvaluation,
  graphRunnerArguments,
  isRepositoryFinding,
  normalizedUsage,
  readGoal,
  readHarness,
  reportedHarnessIdentity,
};
