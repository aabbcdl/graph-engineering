#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scanPackagedFiles, validateReleaseDocuments } from "./package-content-policy.mjs";

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
const denied = /^(?:evals(?:\/|$)|skills\/[^/]+\/scripts\/tests(?:\/|$)|\.workbuddy(?:\/|$)|\.tmp(?:\/|$)|node_modules(?:\/|$)|\.git(?:\/|$)|.*\.log$|.*\.tmp$)/i;
const deniedDevelopmentScripts = /^scripts\/(?:package-smoke|validate-package|windows-[^/]+)\.mjs$/i;
const violations = files.filter((file) => denied.test(file));
violations.push(...files.filter((file) => deniedDevelopmentScripts.test(file)));
if (violations.length) {
  throw new Error(`Package contains denied paths: ${violations.join(", ")}`);
}
const contentViolations = await scanPackagedFiles({ projectRoot, files });
if (contentViolations.length) {
  throw new Error(
    `Package contains private content: ${contentViolations.map((item) => `${item.path} [${item.rule}]`).join(", ")}`,
  );
}
const required = [
  "package.json",
  "README.md",
  "LICENSE",
  "SECURITY.md",
  "docs/release-runbook.md",
  "生命周期扩展/统一工作流契约.md",
  "scripts/install.mjs",
  "skills/autonomous-engineering-graph/scripts/graph-runner.mjs",
  "skills/autonomous-engineering-graph/scripts/runtime/event-log.mjs",
  "skills/autonomous-engineering-graph/scripts/runtime/manifest.mjs",
  "skills/autonomous-engineering-graph/references/specialist-pack.json",
];
const specialistPack = JSON.parse(await readFile(
  path.join(projectRoot, "skills", "autonomous-engineering-graph", "references", "specialist-pack.json"),
  "utf8",
));
for (const reference of specialistPack.shared_references || []) {
  required.push(`skills/autonomous-engineering-graph/${reference.target}`);
}
for (const skill of specialistPack.skills || []) {
  required.push(`skills/${skill.name}/agents/openai.yaml`);
  for (const reference of skill.references || []) {
    required.push(`skills/${skill.name}/${reference.target}`);
  }
}
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
const releaseDocumentViolations = await validateReleaseDocuments({ projectRoot, files, packageJson });
if (releaseDocumentViolations.length) {
  throw new Error(
    `Release documents are incomplete: ${releaseDocumentViolations.map((item) => `${item.path} [${item.rule}]`).join(", ")}`,
  );
}
if (packageJson.bin?.["graph-engineering"] !== "skills/autonomous-engineering-graph/scripts/graph-runner.mjs") {
  throw new Error("package bin is missing the graph-engineering runner");
}
if (packageJson.bin?.["graph-engineering-install"] !== "scripts/install.mjs") {
  throw new Error("package bin is missing the graph-engineering-install installer");
}
process.stdout.write(`${JSON.stringify({
  status: "pass",
  package: packageJson.name,
  version: packageJson.version,
  files: files.length,
  shipped_mjs: mjsFiles.length,
  denied_paths: 0,
  host: `${os.platform()}-${os.arch()}`,
})}\n`);
