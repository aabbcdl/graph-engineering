#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scanPackagedFiles, validateReleaseDocuments } from "./package-content-policy.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageJsonPath = path.join(projectRoot, "package.json");
const placeholderPattern = /<repository-url>|<owner>|<repo>/i;
const deniedPatterns = [
  /^evals(?:\/|$)/i,
  /^skills\/[^/]+\/scripts\/tests(?:\/|$)/i,
  /^\.workbuddy(?:\/|$)/i,
  /^\.tmp(?:\/|$)/i,
  /^node_modules(?:\/|$)/i,
  /^\.git(?:\/|$)/i,
  /(?:^|\/).*\.log$/i,
  /(?:^|\/).*\.tmp$/i,
  /^scripts\/(?:package-smoke|validate-package|windows-[^/]+)\.mjs$/i,
];

function validSemver(value) {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
    String(value || ""),
  );
}

function repositoryValue(repository) {
  if (typeof repository === "string") return repository.trim();
  if (repository && typeof repository.url === "string") return repository.url.trim();
  return "";
}

function isRealGitHubRepository(value) {
  const normalized = String(value || "").replace(/^git\+/, "");
  if (/^git@github\.com:[^/]+\/[^/]+(?:\.git)?$/i.test(normalized)) {
    return !placeholderPattern.test(normalized);
  }
  try {
    const parsed = new URL(normalized);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname.toLowerCase() === "github.com" &&
      parts.length === 2 &&
      !placeholderPattern.test(normalized)
    );
  } catch {
    return false;
  }
}

function runNpmPack() {
  const args = ["pack", "--dry-run", "--json"];
  const result = process.platform === "win32"
    ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm.cmd " + args.join(" ")], {
        cwd: projectRoot,
        encoding: "utf8",
        windowsHide: true,
      })
    : spawnSync("npm", args, {
        cwd: projectRoot,
        encoding: "utf8",
        windowsHide: true,
      });
  if (result.error) throw new Error("Unable to invoke npm: " + result.error.message);
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "npm pack --dry-run failed");
  }
  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout || ""));
  } catch (error) {
    throw new Error("npm pack --dry-run returned invalid JSON: " + (error.message || error));
  }
  const report = Array.isArray(parsed) ? parsed.at(-1) : parsed;
  return {
    files: (report?.files || []).map((entry) => String(entry.path || entry).replaceAll("\\", "/")),
    unpackedSize: report?.unpackedSize,
  };
}

async function main() {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const blockers = [];
  const warnings = [];
  const addBlocker = (condition, message) => {
    if (condition) blockers.push(message);
  };

  addBlocker(packageJson.name !== "graph-engineering", "package name must be graph-engineering");
  addBlocker(!validSemver(packageJson.version), "package version is not valid semver");
  addBlocker(!String(packageJson.engines?.node || "").match(/^>=\s*20(?:\.|$)/), "package must require Node.js 20 or newer");

  const repository = repositoryValue(packageJson.repository);
  addBlocker(!isRealGitHubRepository(repository), "package.json.repository.url must be the real HTTPS GitHub repository URL");

  const bins = packageJson.bin && typeof packageJson.bin === "object" ? packageJson.bin : {};
  addBlocker(
    bins["graph-engineering"] !== "skills/autonomous-engineering-graph/scripts/graph-runner.mjs",
    "graph-engineering bin must point to the packaged graph runner",
  );
  addBlocker(
    bins["graph-engineering-install"] !== "scripts/install.mjs",
    "graph-engineering-install bin must point to the explicit installer",
  );

  for (const relative of ["README.md", "README.zh-CN.md", "docs/usage.md", "docs/marketing-kit.md"]) {
    const content = await readFile(path.join(projectRoot, relative), "utf8");
    addBlocker(placeholderPattern.test(content), relative + " still contains a repository placeholder");
  }

  const packed = runNpmPack();
  const violations = packed.files.filter((file) => deniedPatterns.some((pattern) => pattern.test(file)));
  addBlocker(violations.length > 0, "package contains denied paths: " + violations.join(", "));
  const contentViolations = await scanPackagedFiles({ projectRoot, files: packed.files });
  addBlocker(
    contentViolations.length > 0,
    "package contains private content: " + contentViolations.map((item) => `${item.path} [${item.rule}]`).join(", "),
  );
  const releaseDocumentViolations = await validateReleaseDocuments({
    projectRoot,
    files: packed.files,
    packageJson,
  });
  addBlocker(
    releaseDocumentViolations.length > 0,
    "release documents are incomplete: " +
      releaseDocumentViolations.map((item) => `${item.path} [${item.rule}]`).join(", "),
  );

  const required = [
    "package.json",
    "README.md",
    "README.zh-CN.md",
    "LICENSE",
    "SECURITY.md",
    "docs/release-runbook.md",
    "生命周期扩展/统一工作流契约.md",
    "scripts/install.mjs",
    "skills/autonomous-engineering-graph/scripts/graph-runner.mjs",
    "skills/autonomous-engineering-graph/references/specialist-pack.json",
  ];
  for (const relative of required) {
    addBlocker(!packed.files.includes(relative), "package is missing required path: " + relative);
  }

  if (packageJson.version.startsWith("0.")) {
    warnings.push("version is still 0.x; treat the first public package as an explicitly pre-1.0 release");
  }
  if (packageJson.dependencies || packageJson.optionalDependencies) {
    warnings.push("runtime dependencies are present; verify the clean-machine install path before publishing");
  }
  if (packed.unpackedSize && packed.unpackedSize > 5_000_000) {
    warnings.push("unpacked package size is above 5 MB; review the tarball before publishing");
  }

  const report = {
    status: blockers.length ? "blocked" : "ready",
    package: packageJson.name,
    version: packageJson.version,
    host: os.platform() + "-" + os.arch(),
    files: packed.files.length,
    unpacked_size: packed.unpackedSize ?? null,
    blockers,
    warnings,
  };
  process.stdout.write(JSON.stringify(report) + "\n");
  if (blockers.length) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write("release check failed: " + (error.stack || error) + "\n");
  process.exitCode = 1;
});
