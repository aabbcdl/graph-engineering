import assert from "node:assert/strict";
import test from "node:test";

import { graphRunnerArguments, isRepositoryFinding } from "../adapters/common.mjs";

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
