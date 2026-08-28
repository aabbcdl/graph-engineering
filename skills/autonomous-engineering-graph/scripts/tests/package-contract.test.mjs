import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, "..", "..", "..", "..");

function packedFiles() {
  const command = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "npm.cmd pack --dry-run --json"]
    : ["pack", "--dry-run", "--json"];
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout).at(-1).files.map((entry) => entry.path.replaceAll("\\", "/"));
}

test("npm package retains runtime references and agent metadata", () => {
  const files = packedFiles();
  for (const required of [
    "README.md",
    "LICENSE",
    "SECURITY.md",
    "scripts/install.mjs",
    "skills/autonomous-engineering-graph/references/specialist-pack.json",
    "skills/autonomous-engineering-graph/references/node-runtime-contract.md",
    "skills/graph-engineering-quality/agents/openai.yaml",
    "skills/graph-release-assurance/references/release-gate.md",
  ]) {
    assert.ok(files.includes(required), `package is missing ${required}`);
  }
  for (const excluded of [
    "scripts/package-smoke.mjs",
    "scripts/validate-package.mjs",
    "scripts/windows-codex-write-smoke.mjs",
    "scripts/windows-codex-readonly-smoke.mjs",
    "scripts/windows-claude-readonly-smoke.mjs",
  ]) {
    assert.ok(!files.includes(excluded), `package must exclude source-only tooling ${excluded}`);
  }
});

test("installed npm bin exercises the core control-plane commands", { timeout: 120_000 }, () => {
  const result = spawnSync(process.execPath, [path.join(projectRoot, "scripts", "package-smoke.mjs")], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.entrypoint, "npm-bin");
  assert.equal(report.commands.help.status, "pass");
  assert.equal(report.commands.preview.status, "preview");
  assert.equal(report.commands.preview.mode, "audit");
  assert.equal(report.commands.preview.creates_state, false);
  assert.ok(["ready", "blocked"].includes(report.commands.doctor.status));
  assert.ok([0, 2].includes(report.commands.doctor.exit_code));
  assert.ok(["ready", "blocked"].includes(report.commands.validate.status));
  assert.ok([0, 2].includes(report.commands.validate.exit_code));
  assert.ok(report.commands.validate.skills_discovered >= 7);
});
