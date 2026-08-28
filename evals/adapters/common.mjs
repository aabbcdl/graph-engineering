import { access, readFile, writeFile } from "node:fs/promises";
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
  if (!usage || !Number.isFinite(usage.input_tokens) || !Number.isFinite(usage.output_tokens)) return null;
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
  finishEvaluation,
  graphRunnerArguments,
  isRepositoryFinding,
  normalizedUsage,
  readGoal,
  readHarness,
  reportedHarnessIdentity,
};
