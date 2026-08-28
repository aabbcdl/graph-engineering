import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseProcessRecord, processRecordState } from "./process-identity.mjs";

const INCOMPLETE_RECORD_GRACE_MS = 30_000;

function runtimeControlRoot({ environment = process.env } = {}) {
  if (environment.AEG_TEST_MODE === "1" && environment.AEG_TEST_RUNTIME_CONTROL_ROOT) {
    return path.resolve(environment.AEG_TEST_RUNTIME_CONTROL_ROOT);
  }
  return path.resolve(path.join(os.homedir(), ".graph-engineering", "runtime-control"));
}

function runnerRegistryRoot(controlRoot = runtimeControlRoot()) {
  return path.join(path.resolve(controlRoot), "runners");
}

function workspaceIdentity(workspace) {
  const resolved = path.resolve(workspace);
  let existing = resolved;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  try {
    const canonicalExisting = realpathSync(existing);
    const canonical = path.join(canonicalExisting, resolved.slice(existing.length).replace(/^[/\\]+/, ""));
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  } catch {
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }
}

function workspaceApplyLockPath(controlRoot, workspace) {
  const key = createHash("sha256").update(workspaceIdentity(workspace)).digest("hex");
  return path.join(path.resolve(controlRoot), "workspace-apply", `${key}.lock`);
}

function currentProcessStartedAtMs() {
  return Math.round(Date.now() - process.uptime() * 1_000);
}

function busyError(lockPath, record, purpose, identityStatus) {
  const error = new Error(
    `Runtime admission is busy for ${purpose}: pid=${record?.pid || "unknown"} ` +
      `identity=${identityStatus} ${lockPath}`,
  );
  error.code = "RUNTIME_ADMISSION_BUSY";
  error.lock_path = lockPath;
  error.owner_pid = Number.isInteger(Number(record?.pid)) ? Number(record.pid) : null;
  error.owner_purpose = record?.purpose || null;
  error.owner_identity = identityStatus;
  return error;
}

async function delay(milliseconds) {
  if (milliseconds > 0) await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireIdentityLock(
  lockPath,
  {
    purpose = "runtime_operation",
    ownerPath = path.resolve(process.argv[1] || process.execPath),
    identityState = processRecordState,
    incompleteRecordGraceMs = INCOMPLETE_RECORD_GRACE_MS,
    retryBusyOwnerPurposes = [],
    retryBusyTimeoutMs = 0,
    retryBusyDelayMs = 15,
  } = {},
) {
  const resolved = path.resolve(lockPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const token = randomUUID();
  const record = {
    version: 1,
    token,
    purpose,
    pid: process.pid,
    process_started_at_ms: currentProcessStartedAtMs(),
    runner_path: path.resolve(ownerPath),
    acquired_at: new Date().toISOString(),
  };

  const retryPurposes = new Set(
    Array.isArray(retryBusyOwnerPurposes)
      ? retryBusyOwnerPurposes.map((value) => String(value))
      : [],
  );
  const retryDeadline = Date.now() + Math.max(0, Number(retryBusyTimeoutMs) || 0);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let handle;
    try {
      handle = await open(resolved, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      return async () => {
        let current = null;
        try {
          current = JSON.parse(await readFile(resolved, "utf8"));
        } catch {
          // A missing or replaced record is no longer owned by this release.
        }
        if (current?.token === token && Number(current?.pid) === process.pid) {
          await rm(resolved, { force: true });
        }
      };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (error?.code !== "EEXIST") {
        let current = null;
        try {
          current = JSON.parse(await readFile(resolved, "utf8"));
        } catch {
          // The record may be incomplete or already gone after an I/O error.
        }
        if (current?.token === token) await rm(resolved, { force: true }).catch(() => {});
        throw error;
      }
    }

    const details = await stat(resolved).catch(() => null);
    const contents = await readFile(resolved, "utf8").catch(() => "");
    const owner = parseProcessRecord(contents, details?.mtimeMs || null);
    const validPid = Number.isInteger(Number(owner?.pid)) && Number(owner.pid) > 0;
    if (!validPid && details && Date.now() - details.mtimeMs < incompleteRecordGraceMs) {
      throw busyError(resolved, owner, purpose, "incomplete");
    }
    const ownerState = validPid
      ? identityState(owner, { expectedPath: owner?.runner_path || null, refresh: true })
      : "dead";
    if (["match", "unknown"].includes(ownerState)) {
      const busy = busyError(resolved, owner, purpose, ownerState);
      if (
        ownerState === "match" &&
        retryPurposes.has(owner?.purpose) &&
        Date.now() < retryDeadline
      ) {
        await delay(Math.max(1, Number(retryBusyDelayMs) || 1));
        attempt -= 1;
        continue;
      }
      throw busy;
    }
    const stalePath = `${resolved}.stale.${process.pid}.${Date.now()}.${randomUUID()}`;
    try {
      await rename(resolved, stalePath);
      await rm(stalePath, { force: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (["EACCES", "EBUSY", "EPERM"].includes(error?.code)) {
        const busy = busyError(resolved, owner, purpose, "contended");
        if (
          retryPurposes.has(owner?.purpose) &&
          Date.now() < retryDeadline
        ) {
          await delay(Math.max(1, Number(retryBusyDelayMs) || 1));
          attempt -= 1;
          continue;
        }
        throw busy;
      }
      throw error;
    }
  }
  throw new Error(`Could not acquire runtime admission after stale-lock recovery: ${resolved}`);
}

function runtimeAdmissionLockPath(controlRoot) {
  return path.join(path.resolve(controlRoot), "admission.lock");
}

function acquireRuntimeAdmission(controlRoot = runtimeControlRoot(), options = {}) {
  return acquireIdentityLock(runtimeAdmissionLockPath(controlRoot), options);
}

function acquireWorkspaceAdmission(workspace, { controlRoot = runtimeControlRoot(), ...options } = {}) {
  return acquireIdentityLock(workspaceApplyLockPath(controlRoot, workspace), options);
}

export {
  acquireIdentityLock,
  acquireRuntimeAdmission,
  acquireWorkspaceAdmission,
  runnerRegistryRoot,
  runtimeControlRoot,
  runtimeAdmissionLockPath,
  workspaceApplyLockPath,
};
