#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

async function hashFile(target) {
  const hash = createHash("sha256");
  hash.update(await readFile(target));
  return hash.digest("hex");
}

function changedFiles(before, after) {
  const changed = [];
  const all = new Set([...Object.keys(before.files || {}), ...Object.keys(after.files || {})]);
  for (const file of [...all].sort()) {
    const left = before.files?.[file];
    const right = after.files?.[file];
    if (!left || !right || left.sha256 !== right.sha256 || left.missing !== right.missing) changed.push(file);
  }
  return changed;
}

function workspacePath(workspace, relative) {
  const target = path.resolve(workspace, ...relative.split("/"));
  const relation = path.relative(workspace, target);
  if (relation.startsWith("..") || path.isAbsolute(relation)) throw new Error(`Recovery path escapes workspace: ${relative}`);
  return target;
}

function pathIdentity(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  return pathIdentity(left) === pathIdentity(right);
}

function pathIsInside(parent, candidate) {
  const relation = path.relative(path.resolve(parent), path.resolve(candidate));
  return relation === "" || (!relation.startsWith("..") && !path.isAbsolute(relation));
}

async function assertNoLinkedParents(workspace, relative) {
  const parts = relative.split("/").filter(Boolean);
  let current = workspace;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const details = await lstat(current);
    if (details.isSymbolicLink()) throw new Error(`Recovery path has a linked parent: ${relative}`);
    const resolved = await realpath(current);
    if (!samePath(resolved, workspace) && !pathIsInside(workspace, resolved)) {
      throw new Error(`Recovery path resolves outside workspace: ${relative}`);
    }
  }
}

function findExternalGit(workspace) {
  const names = process.platform === "win32" ? ["git.exe"] : ["git"];
  for (const directory of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.resolve(directory.replace(/^"|"$/g, ""), name);
      if (!existsSync(candidate)) continue;
      const resolved = realpathSync(candidate);
      if (!pathIsInside(workspace, resolved)) return resolved;
    }
  }
  throw new Error("A trusted git executable was not found on PATH");
}

async function matchesRecord(target, record) {
  if (!record || record.missing) return !(await exists(target));
  try {
    const details = await lstat(target);
    if (record.kind === "symlink") {
      if (!details.isSymbolicLink()) return false;
      const linkTarget = await readlink(target);
      return linkTarget === record.link_target && createHash("sha256").update(`symlink\0${linkTarget}`).digest("hex") === record.sha256;
    }
    if (details.isSymbolicLink()) return false;
    return details.isFile() && (await hashFile(target)) === record.sha256;
  } catch {
    return false;
  }
}

async function main() {
  const runDir = path.resolve(argument("--run-dir") || path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  if (await exists(path.join(runDir, ".lock"))) throw new Error("Refusing recovery while the graph run is active");
  if (await exists(path.join(runDir, ".purging"))) throw new Error("Refusing recovery while the graph run is being purged");
  const before = await readJson(path.join(runDir, "workspace-before.json"));
  const after = await readJson(path.join(runDir, "workspace-after.json"));
  const metadata = await readJson(path.join(runDir, "recovery", "metadata.json"));
  const workspace = await realpath(path.resolve(metadata.workspace));
  if (!samePath(workspace, before.workspace) || !samePath(workspace, after.workspace)) {
    throw new Error("Recovery metadata and workspace manifests disagree");
  }
  const changed = changedFiles(before, after);

  const diverged = [];
  for (const relative of changed) {
    await assertNoLinkedParents(workspace, relative);
    if (!(await matchesRecord(workspacePath(workspace, relative), after.files?.[relative]))) diverged.push(relative);
  }
  if (diverged.length) {
    throw new Error(`Refusing to overwrite files changed after the graph report: ${diverged.join(", ")}`);
  }

  const backedUp = new Set(metadata.backed_up_files || []);
  for (const relative of changed) {
    await assertNoLinkedParents(workspace, relative);
    const target = workspacePath(workspace, relative);
    const beforeRecord = before.files?.[relative];
    if (!beforeRecord || beforeRecord.missing) {
      await rm(target, { force: true });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    if (beforeRecord.kind === "symlink") {
      await rm(target, { force: true });
      await symlink(beforeRecord.link_target, target, beforeRecord.link_type || undefined);
    } else if (backedUp.has(relative)) {
      const backup = path.join(runDir, "recovery", "pre-run-files", ...relative.split("/"));
      await copyFile(backup, target);
    } else if (metadata.git && metadata.head) {
      const restored = spawnSync(findExternalGit(workspace), ["-C", workspace, "show", `${metadata.head}:${relative}`], {
        encoding: null,
        windowsHide: true,
        maxBuffer: 512 * 1024 * 1024,
      });
      if (restored.status !== 0) throw new Error(`Could not restore ${relative} from ${metadata.head}`);
      await writeFile(target, restored.stdout);
    } else {
      throw new Error(`No pre-run content was retained for ${relative}`);
    }
    if (beforeRecord.mode && beforeRecord.kind !== "symlink") await chmod(target, beforeRecord.mode);
  }

  const failed = [];
  for (const relative of changed) {
    await assertNoLinkedParents(workspace, relative);
    if (!(await matchesRecord(workspacePath(workspace, relative), before.files?.[relative]))) failed.push(relative);
  }
  if (failed.length) throw new Error(`Recovery verification failed: ${failed.join(", ")}`);
  process.stdout.write(`${JSON.stringify({ status: "restored", run_dir: runDir, workspace, files_restored: changed })}\n`);
}

main().catch((error) => {
  console.error(`ERROR: ${error.message || error}`);
  process.exitCode = 1;
});
