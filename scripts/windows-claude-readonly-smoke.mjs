#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  recordClaudeSandboxProbe,
  spawnCodex,
} from "../skills/autonomous-engineering-graph/scripts/graph-runner.mjs";

if (process.platform !== "win32") {
  process.stdout.write(`${JSON.stringify({ status: "skipped", reason: "Windows-only smoke test" })}\n`);
  process.exit(0);
}

const smokeRoot = process.env.AEG_CLAUDE_SMOKE_ROOT || path.join(process.env.USERPROFILE || os.homedir(), ".codex", "graph-claude-sandbox-smoke");
await mkdir(smokeRoot, { recursive: true });
const root = await mkdtemp(path.join(smokeRoot, "run-"));
const workspace = path.join(root, "workspace");
const nodeDir = path.join(root, "node");
const schema = path.join(root, "result.schema.json");
const target = path.join(workspace, "claude-readonly-blocked.txt");
process.env.AEG_MODEL_QUEUE_ROOT = path.join(root, "queue");

let result = null;
let primaryError = null;
try {
  await mkdir(workspace, { recursive: true });
  const initialized = spawnSync("git", ["init", "--quiet"], {
    cwd: workspace,
    encoding: "utf8",
    windowsHide: true,
  });
  if (initialized.status !== 0) throw new Error(initialized.stderr || "git init failed");
  await writeFile(
    schema,
    `${JSON.stringify({
      type: "object",
      additionalProperties: false,
      required: ["status", "command_attempted", "file_exists"],
      properties: {
        status: { type: "string", enum: ["completed"] },
        command_attempted: { type: "boolean" },
        file_exists: { type: "boolean" },
      },
    })}\n`,
    "utf8",
  );

  const execution = await spawnCodex({
    prompt:
      "Use the PowerShell tool exactly once. Run a command that catches its own error while attempting to write the file `claude-readonly-blocked.txt` in the current workspace, for example `[IO.File]::WriteAllText((Join-Path (Get-Location) 'claude-readonly-blocked.txt'), 'blocked')`, and then print `write_attempt_complete`. Do not use Edit, Write, Bash, or any other tool. Return only the required JSON with status completed, command_attempted true, and file_exists false if the write was denied. Do not modify anything else.",
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
    backend: "claude",
    queueScope: "global",
    runId: "windows-claude-readonly-smoke",
    nodeId: "readonly-probe",
    sourceMutationAllowed: false,
  });
  const settings = JSON.parse(await readFile(path.join(nodeDir, "attempts", "attempt-1", "claude-settings.json"), "utf8"));
  if (execution.exit_code !== 0 || execution.timed_out) {
    const errors = [
      ...(execution.proof?.errors || []),
      execution.stderr,
    ]
      .filter(Boolean)
      .map(String)
      .join(" | ");
    throw new Error(
      `Claude exited ${execution.exit_code}; timed_out=${execution.timed_out}` +
        `${errors ? `; errors=${errors.slice(0, 1000)}` : ""}`,
    );
  }
  const commands = execution.proof.commands || [];
  const structuredText = await readFile(execution.last_message_path, "utf8").catch(() => null);
  if (structuredText === null) throw new Error("Claude did not emit a structured last-message result");
  const structured = JSON.parse(structuredText);
  const fileExists = await readFile(target, "utf8").then(() => true).catch(() => false);
  if (settings.sandbox?.enabled !== true || settings.sandbox?.failIfUnavailable !== true || settings.sandbox?.allowUnsandboxedCommands !== false) {
    throw new Error(`Claude settings were not fail-closed: ${JSON.stringify(settings)}`);
  }
  if (!commands.length) throw new Error("Claude did not emit a PowerShell command event");
  if (fileExists || structured.file_exists !== false) throw new Error("Read-only Claude wrote the protected workspace file");
  if (structured.status !== "completed" || structured.command_attempted !== true) {
    throw new Error(`Unexpected structured result: ${JSON.stringify(structured)}`);
  }
  result = {
    status: "pass",
    backend: "claude",
    sandbox: execution.proof.sandbox,
    settings_fail_closed: true,
    command_event_count: commands.length,
    workspace_write_blocked: true,
  };
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  if (process.env.AEG_KEEP_CLAUDE_SMOKE !== "1") {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
      process.stderr.write(`Claude smoke cleanup failed for ${root}: ${cleanupError.message || cleanupError}\n`);
    }
  } else {
    process.stderr.write(`Claude smoke artifacts retained at ${root}\n`);
  }
}

const capability = await recordClaudeSandboxProbe("read-only", workspace);
result.automatic_fallback_ready = capability.automatic_fallback_ready;
result.capability_file = capability.path;
process.stdout.write(`${JSON.stringify(result)}\n`);
