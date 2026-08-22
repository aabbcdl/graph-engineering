import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function requiredArgument(name) {
  const value = argument(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
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
    arm: requiredArgument("--arm"),
    fixtureId,
    repetition: Number.parseInt(requiredArgument("--repetition"), 10),
  };
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

async function finishEvaluation({ args, status, usage, queueMs, rawFindings, completedGates, artifacts = {} }) {
  const evaluator = await loadEvaluator(args.fixtureId);
  const graded = await evaluator.evaluate(args.workspace, rawFindings);
  const result = {
    status,
    model: args.model,
    reasoning_effort: args.reasoningEffort,
    token_budget: args.tokenBudget,
    usage: normalizedUsage(usage),
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

export { evaluationArguments, finishEvaluation, isRepositoryFinding, normalizedUsage, readGoal };
