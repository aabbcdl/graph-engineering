import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hashTree, runPairedEvaluation } from "../lib/pair-runner.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ARM = path.join(TEST_DIR, "fake-arm.mjs");

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
  assert.equal(result.pairs[0].graph.findings[0].defect_id, "defect-1");
  assert.equal(result.pairs[0].baseline.findings.length, 0);
  assert.equal(JSON.parse(await readFile(result.pairs_path, "utf8")).pairs.length, 2);
  assert.equal(JSON.parse(await readFile(result.pairs_path, "utf8")).fixtures[0].truth, undefined);
  assert.deepEqual(JSON.parse(await readFile(result.score_input_path, "utf8")).fixtures[0].truth, {
    defects: [{ id: "defect-1" }],
  });
  assert.notEqual(
    path.resolve(outputDirectory, "runs", "fixture", "001", "graph-workspace"),
    path.resolve(outputDirectory, "runs", "fixture", "001", "baseline-workspace"),
  );
});
