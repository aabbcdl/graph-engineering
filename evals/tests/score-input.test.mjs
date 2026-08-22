import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCORE = path.resolve(TEST_DIR, "..", "score.mjs");

test("scorer rejects score input whose declared truth hash differs from hidden truth", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-score-truth-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const truth = { defects: [{ id: "defect-1" }] };
  const content = {
    fixtures: [{
      id: "fixture",
      truth,
      truth_sha256: "0".repeat(64),
    }],
    pairs: [],
  };
  const input = path.join(root, "score-input.json");
  const output = path.join(root, "report.json");
  await writeFile(input, JSON.stringify(content, null, 2) + "\n", "utf8");
  const result = spawnSync(process.execPath, [SCORE, "--input", input, "--output", output], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(String(result.stderr || "") + "\n" + String(result.stdout || ""), /truth SHA-256 differs from score input/);
  await assert.rejects(readFile(output, "utf8"));
  assert.notEqual(
    createHash("sha256").update(JSON.stringify(truth)).digest("hex"),
    content.fixtures[0].truth_sha256,
  );
});
