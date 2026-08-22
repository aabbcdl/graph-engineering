#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const npmArgs = ["pack", "--dry-run", "--json"];
const result = process.platform === "win32"
  ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `npm.cmd ${npmArgs.join(" ")}`], {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true,
    })
  : spawnSync("npm", npmArgs, {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true,
    });
if (result.error) {
  process.stderr.write(`Unable to invoke npm: ${result.error.message}\n`);
  process.exit(1);
}
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || "npm pack --dry-run failed\n");
  process.exit(result.status || 1);
}
const report = JSON.parse(result.stdout).at(-1);
const files = (report?.files || []).map((entry) => String(entry.path || entry).replaceAll("\\", "/"));
const denied = /^(?:evals\/results(?:\/|$)|\.workbuddy(?:\/|$)|\.tmp(?:\/|$)|node_modules(?:\/|$)|\.git(?:\/|$)|.*\.log$|.*\.tmp$)/i;
const violations = files.filter((file) => denied.test(file));
if (violations.length) {
  throw new Error(`Package contains denied paths: ${violations.join(", ")}`);
}
const required = [
  "package.json",
  "skills/autonomous-engineering-graph/scripts/graph-runner.mjs",
  "skills/autonomous-engineering-graph/scripts/runtime/event-log.mjs",
  "skills/autonomous-engineering-graph/scripts/runtime/manifest.mjs",
];
for (const file of required) {
  if (!files.includes(file)) throw new Error(`Package is missing required path: ${file}`);
}
const mjsFiles = files.filter((file) => file.toLowerCase().endsWith(".mjs"));
const failures = [];
for (const relative of mjsFiles) {
  const check = spawnSync(process.execPath, ["--check", path.join(projectRoot, relative)], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (check.status !== 0) failures.push({ file: relative, error: check.stderr || check.stdout });
}
if (failures.length) {
  throw new Error(`Shipped .mjs syntax checks failed: ${failures.map((failure) => failure.file).join(", ")}`);
}
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
process.stdout.write(`${JSON.stringify({
  status: "pass",
  package: packageJson.name,
  version: packageJson.version,
  files: files.length,
  shipped_mjs: mjsFiles.length,
  denied_paths: 0,
  host: `${os.platform()}-${os.arch()}`,
})}\n`);
