#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { access, cp, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseProcessRecord,
  processMatchesRecord,
} from "../skills/autonomous-engineering-graph/scripts/process-identity.mjs";

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

async function activeRuntimeEvidence(codexHome) {
  const active = [];
  const runsRoot = path.join(codexHome, "graph-runs");
  for (const lock of await filesRecursively(runsRoot, ".lock")) {
    const details = await stat(lock).catch(() => null);
    const record = parseProcessRecord(await readFile(lock, "utf8").catch(() => ""), details?.mtimeMs || null);
    if (processMatchesRecord(record, { expectedPath: record?.runner_path || "graph-runner.mjs", refresh: true })) {
      active.push({ type: "run_lock", pid: record.pid, path: lock });
    }
  }
  const queueRoot = path.join(codexHome, "graph-runtime", "model-queue");
  for (const lease of await filesRecursively(queueRoot, path.basename("placeholder.lease.json"))) {
    // Kept for compatibility with queue layouts that store a fixed lease name.
    const record = await readJson(lease).catch(() => null);
    const pid = record?.owner_pid || record?.pid;
    if (record && processMatchesRecord({
      ...record,
      pid,
      record_time_ms: Date.parse(record.acquired_at || record.queued_at || "") || null,
    }, { expectedPath: record.runner_path || "graph-runner.mjs", refresh: true })) {
      active.push({ type: "model_lease", pid, path: lease });
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
          if (record && processMatchesRecord({
            ...record,
            pid,
            record_time_ms: Date.parse(record.acquired_at || record.queued_at || "") || null,
          }, { expectedPath: record.runner_path || "graph-runner.mjs", refresh: true })) {
            active.push({ type: "model_lease", pid, path: target });
          }
        }
      }
    }
    await visitLeases(queueRoot);
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
  await mkdir(binDir, { recursive: true });
  if (process.platform === "win32") {
    const cmd = `@echo off\r\nsetlocal\r\nnode "${path.join(codexHome, "skills", "autonomous-engineering-graph", "scripts", "graph-runner.mjs")}" %*\r\nexit /b %ERRORLEVEL%\r\n`;
    const ps1 = `#!/usr/bin/env pwsh\r\nnode "${path.join(codexHome, "skills", "autonomous-engineering-graph", "scripts", "graph-runner.mjs")}" @args\r\nexit $LASTEXITCODE\r\n`;
    await writeFile(path.join(binDir, "graph-engineering.cmd"), cmd, "utf8");
    await writeFile(path.join(binDir, "graph-engineering.ps1"), ps1, "utf8");
  } else {
    const launcher = `#!/bin/sh\nexec node '${path.join(codexHome, "skills", "autonomous-engineering-graph", "scripts", "graph-runner.mjs").replace(/'/g, `'\\''`)}' "$@"\n`;
    await writeFile(path.join(binDir, "graph-engineering"), launcher, { encoding: "utf8", mode: 0o755 });
  }
}

async function main() {
  const codexHome = path.resolve(argument("--codex-home") || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const targetRoot = path.join(codexHome, "skills");
  const binDir = path.resolve(argument("--bin-dir") || defaultBinDirectory(codexHome));
  const active = await activeRuntimeEvidence(codexHome);
  if (active.length) {
    throw new Error(`Refusing to update Graph while a runner or model lease is active:\n${active.map((item) => `${item.type} pid=${item.pid} ${item.path}`).join("\n")}`);
  }
  await mkdir(targetRoot, { recursive: true });
  const transaction = `${Date.now()}-${process.pid}`;
  const stage = path.join(targetRoot, `.graph-engineering-stage-${transaction}`);
  const backup = path.join(targetRoot, `.graph-engineering-backup-${transaction}`);
  await cp(SOURCE_SKILLS, stage, { recursive: true, force: false, errorOnExist: true });
  const validate = spawnSync(process.execPath, [path.join(stage, "autonomous-engineering-graph", "scripts", "validate-specialist-pack.mjs"), "--json"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (validate.status !== 0) {
    await rm(stage, { recursive: true, force: true });
    throw new Error(`Staged Graph validation failed: ${validate.stderr || validate.stdout}`);
  }
  const names = (await readdir(SOURCE_SKILLS, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  await mkdir(backup, { recursive: true });
  const moved = [];
  const installed = [];
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
    await writeLauncher(binDir, codexHome);
    await rm(stage, { recursive: true, force: true });
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    for (const name of installed.reverse()) await rm(path.join(targetRoot, name), { recursive: true, force: true });
    for (const name of moved.reverse()) await rename(path.join(backup, name), path.join(targetRoot, name));
    await rm(stage, { recursive: true, force: true });
    await rm(backup, { recursive: true, force: true });
    throw error;
  }
  process.stdout.write(`${JSON.stringify({ status: "installed", codex_home: codexHome, skills: names, bin_dir: binDir })}\n`);
}

main().catch((error) => {
  console.error(`ERROR: ${error.message || error}`);
  process.exitCode = 1;
});
