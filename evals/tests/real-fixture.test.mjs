import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluate, gradeFindings, observedDefects } from "../fixtures/booking-ledger.evaluator.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(TEST_DIR, "..", "fixtures", "booking-ledger");

test("booking-ledger fixture hides six behavioral defects behind passing public tests", async () => {
  const result = await evaluate(FIXTURE, []);
  assert.equal(result.regression_checks[0].status, "pass");
  assert.deepEqual((await observedDefects(FIXTURE)).map((item) => [item.id, item.repaired]), [
    ["tenant-isolation", false],
    ["list-input-mutation", false],
    ["token-history-loss", false],
    ["expiry-boundary", false],
    ["csv-formula-injection", false],
    ["refunded-revenue", false],
  ]);
});

test("fixture grader maps evidence without exposing defect ids to an agent", () => {
  const findings = gradeFindings(
    [
      { title: "Cross-tenant appointment leak", validated: true, fixed: false },
      { title: "Unrelated claim", validated: true, fixed: true },
    ],
    [
      { id: "tenant-isolation", repaired: false },
      { id: "list-input-mutation", repaired: false },
      { id: "token-history-loss", repaired: false },
      { id: "expiry-boundary", repaired: false },
      { id: "csv-formula-injection", repaired: false },
      { id: "refunded-revenue", repaired: false },
    ],
  );
  assert.equal(findings[0].defect_id, "tenant-isolation");
  assert.equal(findings.at(-1).defect_id, null);
});
