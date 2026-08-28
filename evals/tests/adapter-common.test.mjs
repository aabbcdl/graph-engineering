import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { graphRunnerArguments, isRepositoryFinding } from "../adapters/common.mjs";
import { resolveToolchainContract, validateManifest } from "../lib/pair-runner.mjs";

test("Graph evaluation excludes runner-control lineage but keeps repository findings", () => {
  assert.equal(
    isRepositoryFinding({
      observations: [
        { id: "RUNNER-EVIDENCE-GAP", node: "verification-r0" },
        { id: "RUNNER-EVIDENCE-GAP", node: "correction-r1" },
      ],
    }),
    false,
  );
  assert.equal(
    isRepositoryFinding({
      observations: [
        { id: "RUNNER-EVIDENCE-GAP", node: "verification-r0" },
        { id: "REV-007", node: "independent-review-r2" },
      ],
    }),
    true,
  );
  assert.equal(isRepositoryFinding({ observations: [] }), true);
});

test("Graph evaluation passes its declared token and wall-time budgets to the runner", () => {
  const args = graphRunnerArguments({
    runner: "runner.mjs",
    workspace: "workspace",
    goal: "Audit fixture",
    model: "fixture-model",
    reasoningEffort: "high",
    tokenBudget: 2_500_000,
    timeoutMinutes: 180,
    maxCorrections: "2",
    stateRoot: "state-root",
  });
  const valueAfter = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(valueAfter("--max-run-tokens"), "2500000");
  assert.equal(valueAfter("--max-run-minutes"), "180");
  assert.equal(valueAfter("--max-corrections"), "2");
});

test("the pilot declares one hard aggregate budget contract for both arms", async () => {
  const manifest = JSON.parse(await readFile(path.resolve("evals/manifest.pilot-jobqueue.json"), "utf8"));
  assert.deepEqual(manifest.budget_contract, {
    token_scope: "aggregate",
    wall_time_scope: "aggregate",
    enforcement: "hard",
  });
});

test("toolchain declarations require an ecosystem and platform binding", () => {
  const base = {
    version: 1,
    model: "fixture-model",
    reasoning_effort: "high",
    token_budget: 1000,
    timeout_minutes: 180,
    fixtures: [{ id: "fixture", snapshot: "fixture", goal: "Audit fixture", truth_file: "truth.json", repetitions: 1 }],
    arms: {
      graph: { command: [process.execPath, "graph.mjs"] },
      baseline: { command: [process.execPath, "baseline.mjs"] },
    },
  };
  assert.throws(
    () => validateManifest({ ...base, toolchain: { version: "go1.27.0", binary_sha256: "a".repeat(64) } }),
    /toolchain must include ecosystem and platform/i,
  );
});

test("toolchain declarations resolve one pinned contract per host platform", () => {
  const toolchain = {
    ecosystem: "go",
    version: "go1.27.0",
    platforms: {
      "win32-x64": { binary_sha256: "a".repeat(64) },
      "linux-x64": { binary_sha256: "b".repeat(64) },
    },
  };
  assert.deepEqual(resolveToolchainContract(toolchain, { platform: "win32", arch: "x64" }), {
    ecosystem: "go",
    version: "go1.27.0",
    platform: "win32-x64",
    binary_sha256: "a".repeat(64),
  });
  assert.deepEqual(resolveToolchainContract(toolchain, { platform: "linux", arch: "x64" }), {
    ecosystem: "go",
    version: "go1.27.0",
    platform: "linux-x64",
    binary_sha256: "b".repeat(64),
  });
  assert.throws(
    () => resolveToolchainContract(toolchain, { platform: "darwin", arch: "arm64" }),
    /does not support darwin-arm64/i,
  );
});
