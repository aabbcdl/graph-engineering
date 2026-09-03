#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseProcessRecord,
  processRecordState,
} from "../skills/autonomous-engineering-graph/scripts/process-identity.mjs";
import {
  acquireRuntimeAdmission,
  runnerRegistryRoot,
  runtimeControlRoot,
} from "../skills/autonomous-engineering-graph/scripts/runtime-admission.mjs";
import {
  createInstallationMetadata,
  INSTALLATION_METADATA_FILE,
} from "../skills/autonomous-engineering-graph/scripts/version-info.mjs";

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE_SKILLS = path.join(PROJECT_ROOT, "skills");

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

async function filesRecursively(root, name) {
  const output = [];
  if (!(await exists(root))) return output;
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.name === name) output.push(target);
    }
  }
  await visit(root);
  return output;
}

async function jsonFilesRecursively(root) {
  const output = [];
  if (!(await exists(root))) return output;
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (/\.json$/i.test(entry.name)) output.push(target);
    }
  }
  await visit(root);
  return output;
}

async function activeRuntimeEvidence(
  codexHome,
  { stateRoots = [], controlRoot = runtimeControlRoot() } = {},
) {
  const active = [];
  const runRoots = [
    path.resolve(path.join(codexHome, "graph-runs")),
    ...(process.env.AEG_STATE_ROOT ? [path.resolve(process.env.AEG_STATE_ROOT)] : []),
    ...stateRoots.filter(Boolean).map((root) => path.resolve(root)),
  ].filter((value, index, values) => values.indexOf(value) === index);
  const ownerRecords = [];
  for (const runsRoot of runRoots) {
    ownerRecords.push(
      ...(await filesRecursively(runsRoot, ".lock")),
      ...(await filesRecursively(runsRoot, ".runner-owner.json")),
    );
  }
  for (const lock of ownerRecords) {
    const details = await stat(lock).catch(() => null);
    const record = parseProcessRecord(await readFile(lock, "utf8").catch(() => ""), details?.mtimeMs || null);
    const state = processRecordState(record, { expectedPath: record?.runner_path || "graph-runner.mjs", refresh: true });
    if (["match", "unknown"].includes(state)) {
      active.push({ type: "run_lock", pid: record.pid, path: lock, identity_status: state });
    }
  }
  const queueRoots = [
    path.resolve(process.env.AEG_MODEL_QUEUE_ROOT || path.join(os.homedir(), ".graph-engineering", "model-queue")),
    path.resolve(path.join(codexHome, "graph-runtime", "model-queue")),
  ].filter((value, index, values) => values.indexOf(value) === index);
  const registryRoots = [
    runnerRegistryRoot(controlRoot),
    ...queueRoots.map((queueRoot) => path.join(queueRoot, "runners")),
  ].filter((value, index, values) => values.indexOf(value) === index);
  for (const registryRoot of registryRoots) {
    for (const runnerRecord of await jsonFilesRecursively(registryRoot)) {
      const record = await readJson(runnerRecord).catch(() => null);
      const state = record ? processRecordState(record, {
        expectedPath: record.runner_path || "graph-runner.mjs",
        refresh: true,
      }) : "dead";
      if (record && ["match", "unknown"].includes(state)) {
        active.push({ type: "runner", pid: record.pid, path: runnerRecord, identity_status: state });
      }
    }
  }
  for (const queueRoot of queueRoots) {
    for (const lease of await filesRecursively(queueRoot, path.basename("placeholder.lease.json"))) {
      // Kept for compatibility with queue layouts that store a fixed lease name.
      const record = await readJson(lease).catch(() => null);
      const pid = record?.owner_pid || record?.pid;
      const state = record ? processRecordState({
        ...record,
        pid,
        record_time_ms: Date.parse(record.acquired_at || record.queued_at || "") || null,
      }, { expectedPath: record.runner_path || "graph-runner.mjs", refresh: true }) : "dead";
      if (record && ["match", "unknown"].includes(state)) {
        active.push({ type: "model_lease", pid, path: lease, identity_status: state });
      }
    }
    if (await exists(queueRoot)) {
      async function visitLeases(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const target = path.join(directory, entry.name);
          if (entry.isDirectory()) await visitLeases(target);
          else if (/\.json$/i.test(entry.name) && /[\\/]leases[\\/]/i.test(target)) {
            const record = await readJson(target).catch(() => null);
            const pid = record?.owner_pid || record?.runner_pid || record?.pid;
            const state = record ? processRecordState({
              ...record,
              pid,
              record_time_ms: Date.parse(record.acquired_at || record.queued_at || "") || null,
            }, { expectedPath: record.runner_path || "graph-runner.mjs", refresh: true }) : "dead";
            if (record && ["match", "unknown"].includes(state)) {
              active.push({ type: "model_lease", pid, path: target, identity_status: state });
            }
          }
        }
      }
      await visitLeases(queueRoot);
    }
  }
  return active;
}

function npmGlobalBinDirectory() {
  const configuredPrefix = process.env.npm_config_prefix;
  if (configuredPrefix) {
    const prefix = path.resolve(configuredPrefix);
    return process.platform === "win32" ? prefix : path.join(prefix, "bin");
  }

  const resolved = process.platform === "win32"
    ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm.cmd prefix --global"], {
        encoding: "utf8",
        windowsHide: true,
      })
    : spawnSync("npm", ["prefix", "--global"], {
        encoding: "utf8",
      });
  if (resolved.status !== 0 || !resolved.stdout.trim()) return null;
  const prefix = path.resolve(resolved.stdout.trim());
  return process.platform === "win32" ? prefix : path.join(prefix, "bin");
}

function defaultBinDirectory(codexHome) {
  return (
    npmGlobalBinDirectory() ||
    (process.platform === "win32"
      ? path.join(process.env.APPDATA || codexHome, "npm")
      : path.join(os.homedir(), ".local", "bin"))
  );
}

async function writeLauncher(binDir, codexHome) {
  const launchers = [];
  if (process.platform === "win32") {
    const cmd = `@echo off\r\nsetlocal\r\nnode "${path.join(codexHome, "skills", "autonomous-engineering-graph", "scripts", "graph-runner.mjs")}" %*\r\nexit /b %ERRORLEVEL%\r\n`;
    const ps1 = `#!/usr/bin/env pwsh\r\nnode "${path.join(codexHome, "skills", "autonomous-engineering-graph", "scripts", "graph-runner.mjs")}" @args\r\nexit $LASTEXITCODE\r\n`;
    launchers.push(
      { name: "graph-engineering.cmd", contents: cmd, mode: null },
      { name: "graph-engineering.ps1", contents: ps1, mode: null },
    );
  } else {
    const launcher = `#!/bin/sh\nexec node '${path.join(codexHome, "skills", "autonomous-engineering-graph", "scripts", "graph-runner.mjs").replace(/'/g, `'\\''`)}' "$@"\n`;
    launchers.push({ name: "graph-engineering", contents: launcher, mode: 0o755 });
  }
  return launchers.map((launcher) => ({ ...launcher, target: path.join(binDir, launcher.name) }));
}

async function installGraph({
  codexHome: requestedCodexHome,
  binDir: requestedBinDir,
  stateRoots = [],
  controlRoot: requestedControlRoot = null,
  hooks = {},
} = {}) {
  const codexHome = path.resolve(requestedCodexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const binDir = path.resolve(requestedBinDir || defaultBinDirectory(codexHome));
  const controlRoot = path.resolve(requestedControlRoot || runtimeControlRoot());
  const releaseAdmission = await acquireRuntimeAdmission(controlRoot, { purpose: "install_graph_runtime" });
  try {
    return await installGraphUnderAdmission({ codexHome, binDir, stateRoots, hooks, controlRoot });
  } finally {
    await releaseAdmission();
  }
}

async function installGraphUnderAdmission({ codexHome, binDir, stateRoots, hooks, controlRoot }) {
  const targetRoot = path.join(codexHome, "skills");
  const active = await activeRuntimeEvidence(codexHome, { stateRoots, controlRoot });
  if (active.length) {
    throw new Error(`Refusing to update Graph while a runner or model lease is active:\n${active.map((item) => `${item.type} pid=${item.pid} ${item.path}`).join("\n")}`);
  }
  if (hooks.afterRuntimeScan) await hooks.afterRuntimeScan({ controlRoot });
  await mkdir(targetRoot, { recursive: true });
  const transaction = `${Date.now()}-${process.pid}`;
  const stage = path.join(targetRoot, `.graph-engineering-stage-${transaction}`);
  const backup = path.join(targetRoot, `.graph-engineering-backup-${transaction}`);
  const names = (await readdir(SOURCE_SKILLS, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  let installMetadata = null;
  try {
    await cp(SOURCE_SKILLS, stage, { recursive: true, force: false, errorOnExist: true });
    const validate = spawnSync(process.execPath, [path.join(stage, "autonomous-engineering-graph", "scripts", "validate-specialist-pack.mjs"), "--json"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (validate.status !== 0) {
      throw new Error(`Staged Graph validation failed: ${validate.stderr || validate.stdout}`);
    }
    installMetadata = await createInstallationMetadata({
      projectRoot: PROJECT_ROOT,
      skillsRoot: stage,
      skillNames: names,
    });
    await writeFile(
      path.join(stage, "autonomous-engineering-graph", INSTALLATION_METADATA_FILE),
      `${JSON.stringify(installMetadata, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  const launchers = await writeLauncher(binDir, codexHome);
  try {
    await mkdir(binDir, { recursive: true });
    for (const launcher of launchers) {
      launcher.staged = path.join(binDir, `.${launcher.name}.stage-${transaction}`);
      launcher.backup = path.join(binDir, `.${launcher.name}.backup-${transaction}`);
      await writeFile(
        launcher.staged,
        launcher.contents,
        launcher.mode === null ? "utf8" : { encoding: "utf8", mode: launcher.mode },
      );
      if ((await readFile(launcher.staged, "utf8")) !== launcher.contents) {
        throw new Error(`Staged launcher validation failed: ${launcher.name}`);
      }
    }
    await mkdir(backup, { recursive: true });
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    await rm(backup, { recursive: true, force: true }).catch(() => {});
    for (const launcher of launchers) {
      if (launcher.staged) await rm(launcher.staged, { force: true }).catch(() => {});
    }
    throw error;
  }
  const moved = [];
  const installed = [];
  const launcherBackups = [];
  const launchersInstalled = [];
  try {
    for (const name of names) {
      const target = path.join(targetRoot, name);
      if (await exists(target)) {
        await rename(target, path.join(backup, name));
        moved.push(name);
      }
    }
    for (const name of names) {
      await rename(path.join(stage, name), path.join(targetRoot, name));
      installed.push(name);
    }
    for (let index = 0; index < launchers.length; index += 1) {
      const launcher = launchers[index];
      if (await exists(launcher.target)) {
        await rename(launcher.target, launcher.backup);
        launcherBackups.push(launcher);
      }
      await rename(launcher.staged, launcher.target);
      launchersInstalled.push(launcher);
      if (hooks.afterLauncherInstalled) await hooks.afterLauncherInstalled({ launcher, index });
    }
  } catch (error) {
    const rollbackFailures = [];
    for (const launcher of [...launchersInstalled].reverse()) {
      await rm(launcher.target, { force: true }).catch((cause) => rollbackFailures.push(`${launcher.name}: ${cause.message || cause}`));
    }
    for (const launcher of [...launcherBackups].reverse()) {
      await rename(launcher.backup, launcher.target).catch((cause) => rollbackFailures.push(`${launcher.name}: ${cause.message || cause}`));
    }
    for (const name of [...installed].reverse()) {
      await rm(path.join(targetRoot, name), { recursive: true, force: true }).catch((cause) => rollbackFailures.push(`${name}: ${cause.message || cause}`));
    }
    for (const name of [...moved].reverse()) {
      await rename(path.join(backup, name), path.join(targetRoot, name)).catch((cause) => rollbackFailures.push(`${name}: ${cause.message || cause}`));
    }
    if (!rollbackFailures.length) {
      await rm(stage, { recursive: true, force: true }).catch(() => {});
      await rm(backup, { recursive: true, force: true }).catch(() => {});
      for (const launcher of launchers) {
        await rm(launcher.staged, { force: true }).catch(() => {});
        await rm(launcher.backup, { force: true }).catch(() => {});
      }
      throw error;
    }
    throw new Error(
      `${error.message || error}; installer rollback incomplete: ${rollbackFailures.join("; ")}. ` +
      `Recovery artifacts remain under ${backup} and ${binDir}`,
    );
  }
  const cleanupWarnings = [];
  for (const target of [stage, backup, ...launchers.flatMap((launcher) => [launcher.staged, launcher.backup])]) {
    await rm(target, { recursive: target === stage || target === backup, force: true })
      .catch((cause) => cleanupWarnings.push(`${target}: ${cause.message || cause}`));
  }
  return {
    status: "installed",
    package: installMetadata.package_name,
    version: installMetadata.package_version,
    source: installMetadata.source,
    installed_at: installMetadata.installed_at,
    codex_home: codexHome,
    skills: names,
    bin_dir: binDir,
    install_metadata: path.join(targetRoot, "autonomous-engineering-graph", INSTALLATION_METADATA_FILE),
    ...(cleanupWarnings.length ? { cleanup_warnings: cleanupWarnings } : {}),
  };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const modulePath = path.resolve(fileURLToPath(import.meta.url));
    const invokedPath = path.resolve(realpathSync(process.argv[1]));
    return process.platform === "win32"
      ? modulePath.toLowerCase() === invokedPath.toLowerCase()
      : modulePath === invokedPath;
  } catch {
    return false;
  }
}

export { activeRuntimeEvidence, installGraph };

if (isMainModule()) {
  installGraph({
    codexHome: argument("--codex-home"),
    binDir: argument("--bin-dir"),
    stateRoots: [argument("--state-root")].filter(Boolean),
  })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      console.error(`ERROR: ${error.message || error}`);
      process.exitCode = 1;
    });
}
