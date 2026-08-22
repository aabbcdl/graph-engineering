#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

// The configured Windows elevated sandbox rejects writes below %TEMP%. Keep
// the disposable probe under the trusted Codex data root instead, matching the
// paths used by real isolated Graph workspaces.
const smokeRoot = process.env.AEG_WRITE_SMOKE_ROOT || path.join(process.env.USERPROFILE || os.homedir(), ".codex", "graph-write-smoke");
await mkdir(smokeRoot, { recursive: true });
const root = await mkdtemp(path.join(smokeRoot, "run-"));
const workspace = path.join(root, "workspace");
const nodeDir = path.join(root, "node");
const schema = path.join(root, "result.schema.json");
const target = path.join(workspace, "graph-windows-write-smoke.txt");
const backendArgument = process.argv.indexOf("--backend");
const backend = process.env.AEG_WRITE_SMOKE_BACKEND || (backendArgument >= 0 ? process.argv[backendArgument + 1] : null) || "codex";
if (!["codex", "claude"].includes(backend)) {
  throw new Error("AEG_WRITE_SMOKE_BACKEND must be codex or claude");
}
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
      required: ["status", "file", "content"],
      properties: {
        status: { type: "string", enum: ["completed"] },
        file: { type: "string" },
        content: { type: "string" },
      },
    })}\n`,
    "utf8",
  );

  const execution = await spawnCodex({
    prompt:
      "Use the native apply_patch tool to create graph-windows-write-smoke.txt in the current repository with the exact content `graph windows write smoke` followed by one newline. Then read the file back. Return only the required JSON with status completed, the relative file name, and the exact content read. Do not use shell redirection, commit, or change any other file.",
    schema,
    nodeDir,
    workspace,
    admissionWorkspace: workspace,
    sandbox: "workspace-write",
    model: null,
    reasoningEffort: "low",
    workspaceReadLanes: 1,
    // Keep the child deadline below ordinary CI/desktop command wrappers so
    // spawnCodex can terminate its own complete process tree on a silent model.
    timeoutMinutes: 4,
    queueWaitMinutes: 10,
    isolatedCodexConfig: true,
    attempt: 1,
    backend,
    queueScope: "global",
    runId: "windows-write-smoke",
    nodeId: "write-probe",
    sourceMutationAllowed: true,
  });
  if (execution.exit_code !== 0 || execution.timed_out) {
    const errors = (execution.proof.errors || []).map(String).join(" | ");
    throw new Error(
      `${backend} writer exited ${execution.exit_code}; timed_out=${execution.timed_out}` +
        `${errors ? `; errors=${errors.slice(0, 1000)}` : ""}`,
    );
  }
  const content = await readFile(target, "utf8");
  const structured = JSON.parse(await readFile(execution.last_message_path, "utf8"));
  const fileChangeObserved = (execution.proof.tool_calls || []).some(
    (call) => call.type === "file_change" && ["completed", "success", "succeeded"].includes(String(call.status || "").toLowerCase()),
  );
  if (execution.sandbox !== "workspace-write" || execution.proof.sandbox !== "workspace-write") {
    throw new Error("Machine proof did not retain workspace-write sandbox capability");
  }
  if (content !== "graph windows write smoke\n") throw new Error(`Unexpected file content: ${JSON.stringify(content)}`);
  if (structured.status !== "completed" || structured.file !== "graph-windows-write-smoke.txt" || structured.content !== content) {
    throw new Error(`Unexpected structured result: ${JSON.stringify(structured)}`);
  }
  if (!fileChangeObserved) throw new Error("Codex did not emit a successful file_change event");
  if ((execution.proof.machine_failures || []).some((failure) => failure.type === "sandbox_write_denied")) {
    throw new Error("Machine proof recorded a sandbox write denial");
  }
  result = {
    status: "pass",
    backend,
    sandbox: execution.proof.sandbox,
    file_change_observed: true,
    content_sha256: createHash("sha256").update(content).digest("hex"),
  };
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  if (process.env.AEG_KEEP_WRITE_SMOKE !== "1") {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
      process.stderr.write(`write smoke cleanup failed for ${root}: ${cleanupError.message || cleanupError}\n`);
    }
  } else {
    process.stderr.write(`write smoke artifacts retained at ${root}\n`);
  }
}

if (backend === "claude") {
  const capability = await recordClaudeSandboxProbe("workspace-write", workspace);
  result.automatic_fallback_ready = capability.automatic_fallback_ready;
  result.capability_file = capability.path;
}
process.stdout.write(`${JSON.stringify(result)}\n`);
