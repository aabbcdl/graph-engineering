import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { adapterErrors, canonicalJsonSha256, hashTree, runPairedEvaluation, validateManifest } from "../lib/pair-runner.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ARM = path.join(TEST_DIR, "fake-arm.mjs");
const RUNNER = path.resolve(TEST_DIR, "..", "..", "skills", "autonomous-engineering-graph", "scripts", "graph-runner.mjs");

test("paired harness freezes one fixture and gives both arms independent copies with identical constraints", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-eval-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const fixture = path.join(root, "fixture");
  await mkdir(fixture);
  await writeFile(path.join(fixture, "fixture.txt"), "frozen input\n", "utf8");
  const originalHash = await hashTree(fixture);
  await writeFile(path.join(root, "truth.json"), `${JSON.stringify({ defects: [{ id: "defect-1" }] })}\n`, "utf8");
  const manifest = {
    version: 1,
    model: "fixture-model",
    reasoning_effort: "high",
    token_budget: 1000,
    timeout_minutes: 180,
    minimum_pairs_for_claim: 5,
    fixtures: [{ id: "fixture", snapshot: "fixture", goal: "Audit fixture", truth_file: "truth.json", repetitions: 2 }],
    arms: {
      graph: { command: [process.execPath, FAKE_ARM, "--defect-id", "defect-1", "--assert-no-truth"] },
      baseline: { command: [process.execPath, FAKE_ARM, "--assert-no-truth"] },
    },
  };
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const outputDirectory = path.join(root, "results");
  const result = await runPairedEvaluation({ manifestPath, outputDirectory });
  assert.equal(result.pairs.length, 2);
  assert.deepEqual(result.pairs.map((item) => item.arm_order), [["graph", "baseline"], ["baseline", "graph"]]);
  assert.equal(await hashTree(fixture), originalHash);
  assert.equal(result.pairs[0].graph.fixture_sha256, result.pairs[0].baseline.fixture_sha256);
  assert.equal(result.pairs[0].graph.goal_sha256, result.pairs[0].baseline.goal_sha256);
  assert.equal(result.pairs[0].graph.model, "fixture-model");
  assert.equal(result.pairs[0].baseline.reasoning_effort, "high");
  assert.equal(result.pairs[0].graph.status, "completed");
  assert.equal(result.pairs[0].baseline.status, "completed");
  assert.equal(result.pairs[0].graph.timeout_minutes, 180);
  assert.equal(result.pairs[0].baseline.timeout_minutes, 180);
  assert.equal(result.pairs[0].graph.findings[0].defect_id, "defect-1");
  assert.equal(result.pairs[0].baseline.findings.length, 0);
  assert.equal(result.pairs[0].graph.harness_identity.runner_sha256, result.harness.runner_sha256);
  assert.equal(result.pairs[0].graph.harness_identity.runtime_sha256, result.harness.runtime_sha256);
  assert.equal(result.pairs[0].graph.harness_identity.manifest_sha256, result.harness.manifest_sha256);
  assert.equal(result.pairs[0].graph.harness_identity.run_version, result.harness.graph_run_version_expected);
  assert.equal(JSON.parse(await readFile(result.pairs_path, "utf8")).pairs.length, 2);
  assert.equal(JSON.parse(await readFile(result.pairs_path, "utf8")).fixtures[0].truth, undefined);
  assert.deepEqual(JSON.parse(await readFile(path.join(outputDirectory, "harness.json"), "utf8")), result.harness);
  assert.deepEqual(JSON.parse(await readFile(result.score_input_path, "utf8")).fixtures[0].truth, {
    defects: [{ id: "defect-1" }],
  });
  assert.notEqual(
    path.resolve(outputDirectory, "runs", "fixture", "001", "graph-workspace"),
    path.resolve(outputDirectory, "runs", "fixture", "001", "baseline-workspace"),
  );
});

test("every evaluation records the harness fingerprint that produced it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-eval-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const fixture = path.join(root, "fixture");
  await mkdir(fixture);
  await writeFile(path.join(fixture, "fixture.txt"), "frozen input\n", "utf8");
  await writeFile(path.join(root, "truth.json"), `${JSON.stringify({ defects: [{ id: "defect-1" }] })}\n`, "utf8");
  const manifest = {
    version: 1,
    model: "fixture-model",
    reasoning_effort: "high",
    token_budget: 1000,
    timeout_minutes: 180,
    fixtures: [{ id: "fixture", snapshot: "fixture", goal: "Audit fixture", truth_file: "truth.json", repetitions: 1 }],
    arms: {
      graph: { command: [process.execPath, FAKE_ARM] },
      baseline: { command: [process.execPath, FAKE_ARM] },
    },
  };
  const manifestPath = path.join(root, "manifest.json");
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(manifestPath, manifestText, "utf8");
  const result = await runPairedEvaluation({ manifestPath, outputDirectory: path.join(root, "results") });
  const runnerSha256 = createHash("sha256").update(await readFile(RUNNER)).digest("hex");
  assert.equal(result.harness.runner_sha256, runnerSha256);
  assert.equal(result.harness.graph_run_version_expected, 3);
  assert.match(String(result.harness.runtime_sha256), /^[0-9a-f]{64}$/);
  assert.match(String(result.harness.evals_lib_sha256), /^[0-9a-f]{64}$/);
  assert.match(String(result.harness.adapters_sha256), /^[0-9a-f]{64}$/);
  assert.equal(result.harness.environment.node, process.version);
  assert.equal(result.harness.environment.platform, process.platform);
  assert.equal(
    result.manifest_sha256,
    createHash("sha256").update(manifestText).digest("hex"),
  );
  assert.equal(result.harness.manifest_sha256, result.manifest_sha256);
  const persisted = JSON.parse(await readFile(result.score_input_path, "utf8"));
  assert.equal(persisted.harness.runner_sha256, runnerSha256);
  assert.equal(persisted.manifest_sha256, result.manifest_sha256);
});

test("evaluation manifests require one positive shared wall-time budget", () => {
  const manifest = {
    version: 1,
    model: "fixture-model",
    reasoning_effort: "high",
    token_budget: 1000,
    fixtures: [{ id: "fixture", snapshot: "fixture", goal: "Audit fixture", truth_file: "truth.json", repetitions: 1 }],
    arms: {
      graph: { command: [process.execPath, FAKE_ARM] },
      baseline: { command: [process.execPath, FAKE_ARM] },
    },
  };
  assert.throws(() => validateManifest(manifest), /timeout_minutes must be a positive integer/);
  assert.throws(() => validateManifest({ ...manifest, timeout_minutes: 180.5 }), /timeout_minutes must be a positive integer/);
  assert.doesNotThrow(() => validateManifest({ ...manifest, timeout_minutes: 180 }));
  assert.throws(
    () => validateManifest({
      ...manifest,
      timeout_minutes: 180,
      fixtures: [{ ...manifest.fixtures[0], truth_sha256: "not-a-sha" }],
    }),
    /truth_sha256 must be a SHA-256 hex string/,
  );
});

test("truth hashing is stable across JSON whitespace and object key order", () => {
  assert.equal(
    canonicalJsonSha256({ b: 2, a: { d: 4, c: 3 } }),
    canonicalJsonSha256({ a: { c: 3, d: 4 }, b: 2 }),
  );
});

test("a declared truth hash fails closed before either arm runs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-eval-truth-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const fixture = path.join(root, "fixture");
  await mkdir(fixture);
  await writeFile(path.join(fixture, "fixture.txt"), "frozen input\n", "utf8");
  const truth = { defects: [{ id: "defect-1" }] };
  await writeFile(path.join(root, "truth.json"), JSON.stringify(truth) + "\n", "utf8");
  const manifest = {
    version: 1,
    model: "fixture-model",
    reasoning_effort: "high",
    token_budget: 1000,
    timeout_minutes: 180,
    fixtures: [{
      id: "fixture",
      snapshot: "fixture",
      goal: "Audit fixture",
      truth_file: "truth.json",
      truth_sha256: "0".repeat(64),
      repetitions: 1,
    }],
    arms: {
      graph: { command: [process.execPath, FAKE_ARM] },
      baseline: { command: [process.execPath, FAKE_ARM] },
    },
  };
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await assert.rejects(
    runPairedEvaluation({ manifestPath, outputDirectory: path.join(root, "results") }),
    /truth SHA-256 differs from manifest/,
  );
  assert.notEqual(canonicalJsonSha256(truth), manifest.fixtures[0].truth_sha256);
});

test("adapter contract rejects a changed declared wall-time budget", () => {
  const errors = adapterErrors({
    model: "fixture-model",
    reasoning_effort: "high",
    token_budget: 1000,
    timeout_minutes: 90,
    usage: { input_tokens: 10, output_tokens: 20 },
    findings: [],
    regression_checks: [],
    completed_gates: true,
  }, {
    model: "fixture-model",
    reasoningEffort: "high",
    tokenBudget: 1000,
    timeoutMinutes: 180,
  });
  assert.ok(errors.some((error) => /reported timeout minutes 90 does not match 180/.test(error)));
});
