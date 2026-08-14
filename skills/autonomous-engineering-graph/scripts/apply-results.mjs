#!/usr/bin/env node

import { createHash } from "node:crypto";
import { access, copyFile, lstat, mkdir, readFile, readlink, realpath, rm, symlink } from "node:fs/promises";
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

async function hashFile(target) {
  const hash = createHash("sha256");
  hash.update(await readFile(target));
  return hash.digest("hex");
}

function inside(root, relative) {
  const target = path.resolve(root, ...relative.split("/"));
  const relation = path.relative(root, target);
  if (relation.startsWith("..") || path.isAbsolute(relation)) throw new Error(`Result path escapes workspace: ${relative}`);
  return target;
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
    if (!(await exists(current))) continue;
    const details = await lstat(current);
    if (details.isSymbolicLink()) throw new Error(`Result path has a linked parent: ${relative}`);
    const resolved = await realpath(current);
    if (!pathIsInside(workspace, resolved)) throw new Error(`Result path resolves outside workspace: ${relative}`);
  }
}

async function matches(target, record) {
  if (!record || record.missing) return !(await exists(target));
  try {
    const details = await lstat(target);
    if (record.kind === "symlink") {
      if (!details.isSymbolicLink()) return false;
      const linkTarget = await readlink(target);
      return linkTarget === record.link_target;
    }
    return details.isFile() && !details.isSymbolicLink() && (await hashFile(target)) === record.sha256;
  } catch {
    return false;
  }
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const resultDir = path.resolve(argument("--result-dir") || scriptDir);
  const metadata = JSON.parse(await readFile(path.join(resultDir, "metadata.json"), "utf8"));
  const workspace = await realpath(path.resolve(argument("--workspace") || metadata.source_workspace));
  const conflicts = [];
  for (const file of metadata.changed_files || []) {
    await assertNoLinkedParents(workspace, file);
    if (!(await matches(inside(workspace, file), metadata.source_records?.[file]))) conflicts.push(file);
  }
  if (conflicts.length) {
    throw new Error(`Refusing to overwrite source files changed since Graph started: ${conflicts.join(", ")}`);
  }
  for (const file of metadata.changed_files || []) {
    await assertNoLinkedParents(workspace, file);
    const target = inside(workspace, file);
    const finalRecord = metadata.result_records?.[file];
    if (!finalRecord || finalRecord.missing) {
      await rm(target, { recursive: true, force: true });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    if (finalRecord.kind === "symlink") {
      await rm(target, { recursive: true, force: true });
      await symlink(finalRecord.link_target, target, process.platform === "win32" ? finalRecord.link_type || "file" : null);
    } else {
      await copyFile(inside(path.join(resultDir, "files"), file), target);
    }
  }
  const failed = [];
  for (const file of metadata.changed_files || []) {
    if (!(await matches(inside(workspace, file), metadata.result_records?.[file]))) failed.push(file);
  }
  if (failed.length) throw new Error(`Result verification failed after apply: ${failed.join(", ")}`);
  process.stdout.write(`${JSON.stringify({ status: "applied", run_id: metadata.run_id, workspace, files_applied: metadata.changed_files })}\n`);
}

main().catch((error) => {
  console.error(`ERROR: ${error.message || error}`);
  process.exitCode = 1;
});
