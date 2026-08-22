#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { spawnCodex } from "../../skills/autonomous-engineering-graph/scripts/graph-runner.mjs";
import { evaluationArguments, finishEvaluation, readGoal } from "./common.mjs";

const args = evaluationArguments();
const goal = await readGoal(args);
const nodeDir = path.join(path.dirname(args.output), "baseline-agent");
const schema = path.join(nodeDir, "result.schema.json");
await mkdir(nodeDir, { recursive: true });
await writeFile(
  schema,
  `${JSON.stringify({
    type: "object",
    additionalProperties: false,
    required: ["status", "summary", "findings", "completed_gates"],
    properties: {
      status: { type: "string", enum: ["completed", "blocked"] },
      summary: { type: "string" },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "summary", "evidence", "files", "validated", "fixed"],
          properties: {
            title: { type: "string" },
            summary: { type: "string" },
            evidence: { type: "string" },
            files: { type: "array", items: { type: "string" } },
            validated: { type: "boolean" },
            fixed: { type: "boolean" },
          },
        },
      },
      completed_gates: { type: "boolean" },
    },
  })}\n`,
  "utf8",
);

const prompt = `You are the single-agent baseline in a controlled software-engineering evaluation.

Goal:
${goal}

Work only in the current workspace. Read its instructions and product contracts, inspect the complete implementation, identify concrete defects including edge cases not covered by visible tests, implement every evidence-backed reversible fix, add proportionate tests, and run the required validation. Do not use Graph Engineering or delegate to other agents. Do not read outside this workspace. Do not commit, push, deploy, publish, access remote services, or perform destructive actions.

Return a concise structured record of every validated issue you found, the evidence, affected files, and whether you fixed it. Set completed_gates true only after the workspace's required tests pass.`;

let execution;
let structured = { status: "blocked", findings: [], completed_gates: false };
try {
  execution = await spawnCodex({
    prompt,
    schema,
    nodeDir,
    workspace: args.workspace,
    admissionWorkspace: args.workspace,
    sandbox: "workspace-write",
    model: args.model,
    reasoningEffort: args.reasoningEffort,
    workspaceReadLanes: 1,
    timeoutMinutes: 45,
    queueWaitMinutes: 60,
    isolatedCodexConfig: true,
    attempt: 1,
    backend: "codex",
    queueScope: "global",
    runId: `eval-${args.fixtureId}-${args.repetition}-baseline`,
    nodeId: "single-agent",
  });
  if (execution.last_message_path) {
    structured = JSON.parse(await readFile(execution.last_message_path, "utf8"));
  }
} catch (error) {
  structured = { status: "blocked", findings: [], completed_gates: false, summary: String(error.message || error) };
}

await finishEvaluation({
  args,
  status: execution?.exit_code === 0 && structured.status === "completed" ? "completed" : "blocked",
  usage: execution?.proof?.usage || null,
  queueMs: execution?.queue_ms || 0,
  rawFindings: structured.findings || [],
  completedGates: execution?.exit_code === 0 && structured.completed_gates === true,
  artifacts: {
    proof: execution?.proof_path || null,
    events: execution?.events_path || null,
    summary: structured.summary || null,
  },
});
