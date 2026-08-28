#!/usr/bin/env node

import { COPYFILE_EXCL } from "node:constants";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { manifestPathMatches } from "./runtime/manifest.mjs";

import {
  acquireRuntimeAdmission,
  acquireWorkspaceAdmission,
  runtimeControlRoot,
} from "./runtime-admission.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function argumentsAfter(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values.length ? values : null;
}

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return false;
  }
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
  const workspaceBoundary = await realpath(workspace).catch(() => path.resolve(workspace));
  let current = workspace;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    if (!(await exists(current))) continue;
    const details = await lstat(current);
    if (details.isSymbolicLink()) throw new Error(`Result path has a linked parent: ${relative}`);
    const resolved = await realpath(current);
    if (!pathIsInside(workspaceBoundary, resolved)) throw new Error(`Result path resolves outside workspace: ${relative}`);
  }
}

async function assertUnlinkedLeaf(workspace, relative) {
  const target = inside(workspace, relative);
  try {
    const details = await lstat(target);
    if (details.isSymbolicLink()) throw new Error(`Result target is a linked path: ${relative}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function matches(target, record) {
  return manifestPathMatches(target, record);
}

async function assertRegularPayload(filesRoot, relative, record) {
  await assertNoLinkedParents(filesRoot, relative);
  const payload = inside(filesRoot, relative);
  const details = await lstat(payload);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`Result payload is not a regular file: ${relative}`);
  }
  const resolved = await realpath(payload);
  const filesBoundary = await realpath(filesRoot).catch(() => path.resolve(filesRoot));
  if (!pathIsInside(filesBoundary, resolved)) throw new Error(`Result payload resolves outside its package: ${relative}`);
  if (!(await matches(payload, record))) throw new Error(`Result payload does not match its recorded hash: ${relative}`);
}

function applicationChecksPassed(completion) {
  const evaluation = completion?.machine_check_evaluation;
  if (!evaluation || typeof evaluation !== "object") return false;
  if (typeof evaluation.application_pass === "boolean") return evaluation.application_pass;
  return evaluation.blocking_pass === true;
}

async function ensureTargetParent(workspace, target, createdDirectories) {
  const missing = [];
  let current = path.dirname(target);
  while (current !== workspace && pathIsInside(workspace, current) && !(await exists(current))) {
    missing.push(current);
    current = path.dirname(current);
  }
  await mkdir(path.dirname(target), { recursive: true });
  for (const directory of missing) createdDirectories.add(directory);
}

async function replaceWithStagedFile(staged, target, record, expectedRecord) {
  const temporary = `${target}.graph-apply-${process.pid}-${randomUUID()}.tmp`;
  try {
    await copyFile(staged, temporary, COPYFILE_EXCL);
    if (Number.isInteger(record.mode)) await chmod(temporary, record.mode);
    if (!(await matches(temporary, record))) {
      throw new Error(`Staged result verification failed before apply: ${target}`);
    }
    if (!(await matches(target, expectedRecord))) {
      throw new Error(`Target changed before staged replacement: ${target}`);
    }
    try {
      await rename(temporary, target);
    } catch (error) {
      if (
        !["EACCES", "EEXIST", "EPERM"].includes(error?.code) ||
        !(await matches(target, expectedRecord))
      ) {
        throw error;
      }
      await rm(target, { force: true });
      await rename(temporary, target);
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function rollbackTouchedFiles({
  workspace,
  backupRoot,
  touched,
  sourceRecords,
  resultRecords,
  createdDirectories,
}) {
  const failures = [];
  for (const file of [...touched].reverse()) {
    const target = inside(workspace, file);
    const sourceRecord = sourceRecords[file];
    const resultRecord = resultRecords[file];
    try {
      await assertNoLinkedParents(workspace, file);
      await assertUnlinkedLeaf(workspace, file);
      if (await matches(target, sourceRecord)) continue;
      const targetMissing = !(await exists(target));
      if (!targetMissing && !(await matches(target, resultRecord))) {
        throw new Error("target changed after Graph applied it");
      }
      if (sourceRecord.missing) {
        await rm(target, { force: true });
      } else {
        await ensureTargetParent(workspace, target, createdDirectories);
        await assertNoLinkedParents(workspace, file);
        await assertUnlinkedLeaf(workspace, file);
        await replaceWithStagedFile(
          inside(backupRoot, file),
          target,
          sourceRecord,
          targetMissing ? { missing: true } : resultRecord,
        );
      }
      if (!(await matches(target, sourceRecord))) throw new Error("restored source does not match its recorded state");
    } catch (error) {
      failures.push(`${file}: ${error.message || error}`);
    }
  }
  for (const directory of [...createdDirectories].sort((left, right) => right.length - left.length)) {
    try {
      await rmdir(directory);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) {
        failures.push(`${path.relative(workspace, directory) || "."}: ${error.message || error}`);
      }
    }
  }
  return failures;
}

async function applyResults({
  resultDir: resultDirectory,
  workspace: workspaceArgument,
  beforeApplyFile,
  admissionRoot = null,
  files: selectedFiles = null,
  dryRun = false,
} = {}) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const resultDir = path.resolve(resultDirectory || scriptDir);
  const metadata = JSON.parse(await readFile(path.join(resultDir, "metadata.json"), "utf8"));
  if (
    metadata.eligible_to_apply !== true ||
    metadata.terminal_status !== "completed" ||
    metadata.verification_passed !== true ||
    metadata.independent_review_passed !== true
  ) {
    throw new Error(
      `Refusing to apply incomplete Graph results: status=${metadata.terminal_status || "unknown"}, ` +
      `verification_passed=${Boolean(metadata.verification_passed)}, ` +
      `independent_review_passed=${Boolean(metadata.independent_review_passed)}`,
    );
  }
  const allChangedFiles = metadata.changed_files;
  if (
    !Array.isArray(allChangedFiles) ||
    allChangedFiles.some((file) => typeof file !== "string" || !file.trim()) ||
    new Set(allChangedFiles).size !== allChangedFiles.length
  ) {
    throw new Error("Refusing to apply results with an invalid changed-files manifest");
  }
  const changedFiles = selectedFiles === null || selectedFiles === undefined
    ? allChangedFiles
    : (Array.isArray(selectedFiles) ? selectedFiles : [selectedFiles]);
  if (changedFiles.length === 0) throw new Error("--file must select at least one result path");
  for (const file of changedFiles) {
    if (typeof file !== "string" || !file.trim() || file.includes("\\") || path.posix.normalize(file) !== file || file.startsWith("../") || file === ".." || path.posix.isAbsolute(file)) {
      throw new Error(`--file must be an exact relative result path: ${file}`);
    }
    if (!allChangedFiles.includes(file)) throw new Error(`Selected result path is not in the Run manifest: ${file}`);
  }
  const completionPath = path.join(resultDir, "..", "completion.json");
  const completion = JSON.parse(await readFile(completionPath, "utf8"));
  if (
    completion.run_id !== metadata.run_id ||
    completion.status !== "completed" ||
    !applicationChecksPassed(completion) ||
    completion.independent_review?.status !== "completed" ||
    completion.independent_review?.gate !== "pass"
  ) {
    throw new Error("Refusing to apply results without a matching completed verification and independent-review artifact");
  }
  const workspace = await realpath(path.resolve(workspaceArgument || metadata.source_workspace));
  if (dryRun) {
    return applyResultsUnderAdmission({ resultDir, workspace, metadata, beforeApplyFile, changedFiles, dryRun: true });
  }
  const controlRoot = path.resolve(admissionRoot || runtimeControlRoot());
  const releaseRuntimeAdmission = await acquireRuntimeAdmission(controlRoot, {
    purpose: `apply_graph_results:${metadata.run_id || "unknown"}`,
  });
  let releaseWorkspaceLock = null;
  try {
    releaseWorkspaceLock = await acquireWorkspaceAdmission(workspace, {
      controlRoot,
      purpose: `apply_graph_results:${metadata.run_id || "unknown"}`,
    });
    return await applyResultsUnderAdmission({ resultDir, workspace, metadata, beforeApplyFile, changedFiles });
  } finally {
    try {
      if (releaseWorkspaceLock) await releaseWorkspaceLock();
    } finally {
      await releaseRuntimeAdmission();
    }
  }
}

async function applyResultsUnderAdmission({ resultDir, workspace, metadata, beforeApplyFile, changedFiles = metadata.changed_files, dryRun = false }) {
  if (
    !Array.isArray(changedFiles) ||
    changedFiles.some((file) => typeof file !== "string" || !file.trim()) ||
    new Set(changedFiles).size !== changedFiles.length
  ) {
    throw new Error("Refusing to apply results with an invalid changed-files manifest");
  }
  const sourceRecords = metadata.source_records || {};
  const resultRecords = metadata.result_records || {};
  for (const file of changedFiles) {
    inside(workspace, file);
    if (!Object.hasOwn(sourceRecords, file) || !Object.hasOwn(resultRecords, file)) {
      throw new Error(`Refusing to apply results with a missing file record: ${file}`);
    }
    const sourceRecord = sourceRecords[file];
    const resultRecord = resultRecords[file];
    if (sourceRecord?.kind === "symlink") {
      throw new Error(`Refusing to apply results with a linked source record: ${file}`);
    }
    if (resultRecord?.kind === "symlink") {
      throw new Error(`Refusing to apply linked Graph results: ${file}`);
    }
    if (sourceRecord && !sourceRecord.missing && sourceRecord.kind !== "file") {
      throw new Error(`Refusing to apply an unsupported source record: ${file}`);
    }
    if (resultRecord && !resultRecord.missing && resultRecord.kind !== "file") {
      throw new Error(`Refusing to apply an unsupported result record: ${file}`);
    }
  }
  const conflicts = [];
  const filesRoot = path.join(resultDir, "files");
  for (const file of changedFiles) {
    await assertNoLinkedParents(workspace, file);
    await assertUnlinkedLeaf(workspace, file);
    if (!(await matches(inside(workspace, file), sourceRecords[file]))) conflicts.push(file);
    const finalRecord = resultRecords[file];
    if (!finalRecord.missing) await assertRegularPayload(filesRoot, file, finalRecord);
  }
  if (conflicts.length) {
    throw new Error(`Refusing to overwrite source files changed since Graph started: ${conflicts.join(", ")}`);
  }

  if (dryRun) {
    return {
      status: "dry-run",
      run_id: metadata.run_id,
      workspace,
      files_checked: changedFiles,
      writes: 0,
    };
  }

  const transactionRoot = await mkdtemp(path.join(resultDir, ".apply-transaction-"));
  const backupRoot = path.join(transactionRoot, "backup");
  const stagedRoot = path.join(transactionRoot, "staged");
  const touched = [];
  const createdDirectories = new Set();
  try {
    for (const file of changedFiles) {
      const target = inside(workspace, file);
      const sourceRecord = sourceRecords[file];
      const finalRecord = resultRecords[file];
      await assertNoLinkedParents(workspace, file);
      await assertUnlinkedLeaf(workspace, file);
      if (!(await matches(target, sourceRecord))) {
        throw new Error(`Source changed while preparing the apply transaction: ${file}`);
      }
      if (!sourceRecord.missing) {
        const backup = inside(backupRoot, file);
        await mkdir(path.dirname(backup), { recursive: true });
        await copyFile(target, backup, COPYFILE_EXCL);
        if (Number.isInteger(sourceRecord.mode)) await chmod(backup, sourceRecord.mode);
        if (!(await matches(backup, sourceRecord))) throw new Error(`Source backup verification failed: ${file}`);
      }
      if (!finalRecord.missing) {
        const staged = inside(stagedRoot, file);
        await mkdir(path.dirname(staged), { recursive: true });
        await copyFile(inside(filesRoot, file), staged, COPYFILE_EXCL);
        if (Number.isInteger(finalRecord.mode)) await chmod(staged, finalRecord.mode);
        if (!(await matches(staged, finalRecord))) throw new Error(`Result staging verification failed: ${file}`);
      }
    }

    for (const file of changedFiles) {
      if (!(await matches(inside(workspace, file), sourceRecords[file]))) {
        throw new Error(`Source changed before the apply transaction committed: ${file}`);
      }
    }

    for (let index = 0; index < changedFiles.length; index += 1) {
      const file = changedFiles[index];
      if (beforeApplyFile) await beforeApplyFile({ file, index, touched: [...touched] });
      await assertNoLinkedParents(workspace, file);
      await assertUnlinkedLeaf(workspace, file);
      const target = inside(workspace, file);
      if (!(await matches(target, sourceRecords[file]))) {
        throw new Error(`Source changed during the apply transaction: ${file}`);
      }
      const finalRecord = resultRecords[file];
      touched.push(file);
      if (finalRecord.missing) {
        await rm(target, { force: true });
      } else {
        await ensureTargetParent(workspace, target, createdDirectories);
        await assertNoLinkedParents(workspace, file);
        await assertUnlinkedLeaf(workspace, file);
        await replaceWithStagedFile(inside(stagedRoot, file), target, finalRecord, sourceRecords[file]);
      }
      if (!(await matches(target, finalRecord))) throw new Error(`Result verification failed during apply: ${file}`);
    }

    const failed = [];
    for (const file of changedFiles) {
      if (!(await matches(inside(workspace, file), resultRecords[file]))) failed.push(file);
    }
    if (failed.length) throw new Error(`Result verification failed after apply: ${failed.join(", ")}`);
  } catch (error) {
    if (!touched.length) {
      await rm(transactionRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    const rollbackFailures = await rollbackTouchedFiles({
      workspace,
      backupRoot,
      touched,
      sourceRecords,
      resultRecords,
      createdDirectories,
    });
    if (rollbackFailures.length) {
      throw new Error(
        `${error.message || error}; rollback incomplete: ${rollbackFailures.join("; ")}. ` +
        `Backups preserved at ${backupRoot}`,
      );
    }
    const cleanupError = await rm(transactionRoot, { recursive: true, force: true }).then(() => null, (cause) => cause);
    throw new Error(
      `${error.message || error}; source workspace rollback completed` +
      (cleanupError ? `; transaction cleanup failed at ${transactionRoot}: ${cleanupError.message || cleanupError}` : ""),
    );
  }
  const cleanupError = await rm(transactionRoot, { recursive: true, force: true }).then(() => null, (cause) => cause);
  return {
    status: "applied",
    run_id: metadata.run_id,
    workspace,
    files_applied: changedFiles,
    ...(cleanupError ? { cleanup_warning: `Transaction cleanup failed at ${transactionRoot}: ${cleanupError.message || cleanupError}` } : {}),
  };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const modulePath = realpathSync(fileURLToPath(import.meta.url));
  const invokedPath = realpathSync(process.argv[1]);
  return process.platform === "win32" ? modulePath.toLowerCase() === invokedPath.toLowerCase() : modulePath === invokedPath;
}

export { applyResults };

if (isMainModule()) {
  applyResults({
    resultDir: argument("--result-dir"),
    workspace: argument("--workspace"),
    files: argumentsAfter("--file"),
    dryRun: process.argv.includes("--dry-run"),
  })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      console.error(`ERROR: ${error.message || error}`);
      process.exitCode = 1;
    });
}
