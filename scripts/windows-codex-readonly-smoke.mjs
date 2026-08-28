#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  recordAgentSandboxProbe,
  readonlySandboxProbeEvidence,
  spawnCodex,
} from "../skills/autonomous-engineering-graph/scripts/graph-runner.mjs";

if (process.platform !== "win32") {
  process.stdout.write(`${JSON.stringify({ status: "skipped", reason: "Windows-only smoke test" })}\n`);
  process.exit(0);
}

const smokeRoot = process.env.AEG_CODEX_READONLY_SMOKE_ROOT || path.join(process.env.USERPROFILE || os.homedir(), ".codex", "graph-codex-readonly-smoke");
await mkdir(smokeRoot, { recursive: true });
const root = await mkdtemp(path.join(smokeRoot, "run-"));
const workspace = path.join(root, "workspace");
const nodeDir = path.join(root, "node");
const schema = path.join(root, "result.schema.json");
const target = path.join(workspace, "codex-readonly-blocked.txt");
process.env.AEG_MODEL_QUEUE_ROOT = path.join(root, "queue");

let primaryError = null;
try {
  await mkdir(workspace, { recursive: true });
  const initialized = spawnSync("git", ["init", "--quiet"], { cwd: workspace, encoding: "utf8", windowsHide: true });
  if (initialized.status !== 0) throw new Error(initialized.stderr || "git init failed");
  await writeFile(
    schema,
    `${JSON.stringify({
      type: "object",
      additionalProperties: false,
      required: ["status", "file_exists"],
      properties: {
        status: { type: "string", enum: ["completed"] },
        file_exists: { type: "boolean" },
      },
    })}\n`,
    "utf8",
  );
  const execution = await spawnCodex({
    prompt:
      "Use the PowerShell tool exactly once. Run a command that attempts to write codex-readonly-blocked.txt in the current workspace; catch the error and print its access-denied message (for example Write-Output $_.Exception.Message), then print write_attempt_complete. Return the required JSON with status completed and file_exists false. Do not use any other tool or modify another file.",
    schema,
    nodeDir,
    workspace,
    admissionWorkspace: workspace,
    sandbox: "read-only",
    model: null,
    reasoningEffort: "low",
    workspaceReadLanes: 1,
    timeoutMinutes: 4,
    queueWaitMinutes: 10,
    isolatedCodexConfig: true,
    attempt: 1,
    backend: "codex",
    queueScope: "global",
    runId: "windows-codex-readonly-smoke",
    nodeId: "readonly-probe",
    sourceMutationAllowed: false,
  });
  if (execution.exit_code !== 0 || execution.timed_out) throw new Error(`Codex exited ${execution.exit_code}; timed_out=${execution.timed_out}`);
  const structured = JSON.parse(await readFile(execution.last_message_path, "utf8"));
  const fileExists = await readFile(target, "utf8").then(() => true).catch(() => false);
  const probe = readonlySandboxProbeEvidence(execution, target);
  if (!probe.passed) {
    throw new Error(`Codex read-only denial was not machine-observed: ${JSON.stringify(probe)}`);
  }
  if (fileExists || structured.file_exists !== false || structured.status !== "completed") {
    throw new Error(`Read-only Codex write was not blocked: ${JSON.stringify(structured)}`);
  }
  const capability = await recordAgentSandboxProbe("codex", "read-only", workspace);
  process.stdout.write(`${JSON.stringify({ status: "pass", backend: "codex", sandbox: execution.proof.sandbox, workspace_write_blocked: true, capability_file: capability.path })}\n`);
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  if (process.env.AEG_KEEP_CODEX_READONLY_SMOKE !== "1") {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
      process.stderr.write(`Codex read-only smoke cleanup failed for ${root}: ${cleanupError.message || cleanupError}\n`);
    }
  } else {
    process.stderr.write(`Codex read-only smoke artifacts retained at ${root}\n`);
  }
}
