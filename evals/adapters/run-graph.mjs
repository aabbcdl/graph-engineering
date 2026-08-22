#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluationArguments, finishEvaluation, isRepositoryFinding, readGoal } from "./common.mjs";

const args = evaluationArguments();
const goal = await readGoal(args);
const projectRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const runner = path.join(projectRoot, "skills", "autonomous-engineering-graph", "scripts", "graph-runner.mjs");
const runnerSha256 = createHash("sha256").update(await readFile(runner)).digest("hex");
// Keep low-budget pilots bounded, but give the full pilot the same three-round
// correction budget as the production runner. This measures completion rather
// than making the evaluation fail solely on a recoverable final-review gap.
const maxCorrections = args.tokenBudget >= 3_500_000 ? "3" : "2";
const stateRoot = path.join(path.dirname(args.output), "graph-state");
const execution = spawnSync(
  process.execPath,
  [
    runner,
    "start",
    "--workspace", args.workspace,
    "--workspace-mode", "auto",
    "--supervision", "stage",
    "--goal", goal,
    "--user-approved",
    "--agent-backend", "codex",
    "--no-agent-fallback",
    "--model", args.model,
    "--reasoning-effort", args.reasoningEffort,
    "--max-parallel", "2",
    "--workspace-read-lanes", "2",
    "--max-corrections", maxCorrections,
    "--timeout-minutes", "45",
    "--service-retry-minutes", "10",
    "--max-service-failures", "3",
    "--queue-wait-minutes", "60",
    "--state-root", stateRoot,
    "--no-notify",
    "--json",
  ],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true },
);

let summary = null;
try {
  summary = JSON.parse(execution.stdout.trim());
} catch {
  summary = { status: "failed", run_id: null, run_dir: null };
}

let completion = null;
let run = null;
let lineage = { findings: [] };
let applyStatus = null;
if (summary.run_dir) {
  completion = JSON.parse(await readFile(path.join(summary.run_dir, "completion.json"), "utf8").catch(() => "null"));
  run = JSON.parse(await readFile(path.join(summary.run_dir, "run.json"), "utf8").catch(() => "null"));
  lineage = JSON.parse(await readFile(path.join(summary.run_dir, "finding-lineage.json"), "utf8").catch(() => '{"findings":[]}'));
}

if (summary.status === "completed" && run?.results?.directory && (run.results.changed_files || []).length > 0) {
  const applied = spawnSync(
    process.execPath,
    [
      path.join(run.results.directory, "apply.mjs"),
      "--result-dir", run.results.directory,
      "--workspace", args.workspace,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  applyStatus = { exit_code: applied.status, stdout: applied.stdout.trim(), stderr: applied.stderr.trim() };
}

const rawFindings = (lineage.findings || []).filter(isRepositoryFinding).map((finding) => ({
  title: finding.title,
  summary: (finding.observations || []).map((item) => item.evidence).filter(Boolean).join("\n"),
  evidence: (finding.observations || []).map((item) => `${item.node}: ${item.evidence}`).join("\n"),
  files: (finding.observations || []).flatMap((item) => item.files || []),
  validated: ["test_confirmed", "reproduced"].includes(finding.validation),
  fixed: finding.proven_fixed === true,
}));
const requiredChecksPass = (completion?.required_checks || []).every((check) => check.status === "pass");
const independentPass = completion?.independent_review?.status === "completed" && completion?.independent_review?.gate === "pass";
const applyPass = applyStatus === null || applyStatus.exit_code === 0;

await finishEvaluation({
  args,
  status: execution.status === 0 && summary.status === "completed" && applyPass ? "completed" : summary.status || "failed",
  usage: completion?.cost?.usage || null,
  queueMs: completion?.cost?.queue_ms || 0,
  rawFindings,
  completedGates: summary.status === "completed" && requiredChecksPass && independentPass && applyPass,
  identity: { runner_sha256: runnerSha256, run_version: Number.isInteger(run?.version) ? run.version : null },
  artifacts: {
    run_id: summary.run_id || null,
    run_dir: summary.run_dir || null,
    report: completion?.report || null,
    apply: applyStatus,
    stderr: execution.stderr.trim().slice(-4000),
  },
});
