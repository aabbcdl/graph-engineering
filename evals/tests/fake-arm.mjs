#!/usr/bin/env node

import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { harnessIdentity } from "../lib/pair-runner.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const workspace = argument("--workspace");
const output = argument("--output");
const goal = (await readFile(argument("--goal-file"), "utf8")).trim();
const fixture = (await readFile(`${workspace}/fixture.txt`, "utf8")).trim();
const defectId = argument("--defect-id");
const expectedHarness = JSON.parse(await readFile(argument("--harness-file"), "utf8"));
const executionHarness = await harnessIdentity({
  manifestSha256: expectedHarness.manifest_sha256,
  budgetContract: expectedHarness.budget_contract || null,
  toolchain: expectedHarness.toolchain_contract || expectedHarness.toolchain || null,
});
if (process.argv.includes("--assert-no-truth")) {
  const outputRoot = path.resolve(path.dirname(output), "..", "..", "..");
  const pairsPath = path.join(outputRoot, "pairs.json");
  try {
    await access(pairsPath);
    const visible = JSON.parse(await readFile(pairsPath, "utf8"));
    if ((visible.fixtures || []).some((item) => Object.hasOwn(item, "truth"))) {
      throw new Error("hidden truth was visible to an evaluation arm");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const result = {
  status: "completed",
  model: argument("--model"),
  reasoning_effort: argument("--reasoning-effort"),
  token_budget: Number.parseInt(argument("--token-budget"), 10),
  timeout_minutes: Number.parseFloat(argument("--timeout-minutes")),
  usage: { input_tokens: 100, output_tokens: 50 },
  harness_identity: {
    ...executionHarness,
    ...(argument("--arm") === "graph"
      ? {
          run_version: executionHarness.graph_run_version_expected,
          run_budget: {
            max_tokens: Number.parseInt(argument("--token-budget"), 10),
            max_minutes: Number.parseFloat(argument("--timeout-minutes")),
          },
        }
      : { arm_contract: "fake" }),
  },
  findings: defectId
    ? [{ defect_id: defectId, validated: true, fixed: true, repair_verified: true, title: `${goal}: ${fixture}` }]
    : [],
  regression_checks: [{ id: "fixture", status: "pass" }],
  completed_gates: true,
  queue_ms: 0,
};
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
