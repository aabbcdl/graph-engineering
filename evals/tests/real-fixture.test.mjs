import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluate, gradeFindings, observedDefects } from "../fixtures/booking-ledger.evaluator.mjs";
import {
  DEFINITIONS as JOBQUEUE_DEFINITIONS,
  assertHiddenTemplatesPresent,
  evaluate as evaluateJobqueue,
  gradeFindings as gradeJobqueueFindings,
  parseTestResults,
} from "../fixtures/jobqueue.evaluator.mjs";
import { canonicalJsonSha256, hashTree } from "../lib/pair-runner.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(TEST_DIR, "..", "fixtures", "booking-ledger");
const JOBQUEUE_FIXTURE = path.resolve(TEST_DIR, "..", "fixtures", "jobqueue");
const JOBQUEUE_TRUTH = path.resolve(TEST_DIR, "..", "fixtures", "jobqueue.truth.json");

test("jobqueue evaluator parses Go JSON test records separated by real newlines", () => {
  const output = [
    JSON.stringify({ Test: "TestHiddenQueueFIFO", Action: "pass" }),
    "ordinary go test output",
    JSON.stringify({ Test: "TestHiddenQueuePriority", Action: "fail" }),
  ].join("\n");
  const results = parseTestResults(output);
  assert.equal(results.get("TestHiddenQueueFIFO"), "pass");
  assert.equal(results.get("TestHiddenQueuePriority"), "fail");
});

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

test("fixture graders do not credit matching claims that were not validated", () => {
  const booking = gradeFindings(
    [{ title: "Cross-tenant appointment leak", validated: false, fixed: false }],
    [{ id: "tenant-isolation", repaired: false }],
  );
  const jobqueue = gradeJobqueueFindings(
    [{ title: "Higher priority work can run after lower priority work", validated: false, fixed: false }],
    JOBQUEUE_DEFINITIONS.map((definition) => ({ id: definition.id, repaired: false })),
  );
  assert.deepEqual(booking, []);
  assert.deepEqual(jobqueue, []);
});

test("jobqueue hides 23 frozen defects behind passing Go public checks without workspace residue", async () => {
  const before = await hashTree(JOBQUEUE_FIXTURE);
  const result = await evaluateJobqueue(JOBQUEUE_FIXTURE, []);
  const after = await hashTree(JOBQUEUE_FIXTURE);
  assert.equal(after, before);
  assert.deepEqual(result.regression_checks.map((check) => [check.id, check.status]), [
    ["go-build", "pass"],
    ["go-test", "pass"],
  ]);
  assert.equal(result.defects.length, 23);
  assert.ok(result.defects.every((defect) => defect.repaired === false));
  assert.ok(result.defects.every((defect) => defect.observed === true));
  assert.ok(result.defects.every((defect) => !defect.detail.includes("did not produce a passing test record")));
  assert.ok(result.defects.every((defect) => /"Action":"fail"/.test(defect.detail)));
  const categories = JOBQUEUE_DEFINITIONS.reduce((counts, definition) => {
    counts[definition.category] = (counts[definition.category] || 0) + 1;
    return counts;
  }, {});
  assert.deepEqual(categories, {
    concurrency: 5,
    error_handling: 4,
    boundary: 4,
    cross_module_contract: 4,
    resource_leak: 3,
    semantic_documentation: 3,
  });
  const truth = JSON.parse(await readFile(JOBQUEUE_TRUTH, "utf8"));
  assert.deepEqual(truth.defects.map((defect) => defect.id), JOBQUEUE_DEFINITIONS.map((definition) => definition.id));
  await assertHiddenTemplatesPresent();
  await assert.rejects(access(path.join(JOBQUEUE_FIXTURE, "zz_hidden_evaluator_test.go")));
});

test("jobqueue grader maps natural evidence without exposing its truth IDs to an agent", () => {
  const findings = gradeJobqueueFindings(
    [
      { title: "Higher priority work can run after lower priority work", validated: true, fixed: false },
      { title: "Unrelated claim", validated: true, fixed: true },
    ],
    JOBQUEUE_DEFINITIONS.map((definition) => ({ id: definition.id, repaired: false })),
  );
  assert.equal(findings[0].defect_id, "queue-priority-order");
  assert.equal(findings.at(-1).defect_id, null);
});

test("jobqueue grader does not turn one ambiguous finding into multiple truth defects", () => {
  const findings = gradeJobqueueFindings(
    [{ title: "Queue order is inconsistent", validated: true, fixed: false }],
    JOBQUEUE_DEFINITIONS.map((definition) => ({ id: definition.id, repaired: false })),
  );
  assert.deepEqual(findings.map((finding) => finding.defect_id), [null]);
});

test("jobqueue pilot binds the frozen truth file before any arm run", async () => {
  const manifest = JSON.parse(await readFile(
    path.resolve(TEST_DIR, "..", "manifest.pilot-jobqueue.json"),
    "utf8",
  ));
  const fixture = manifest.fixtures.find((item) => item.id === "jobqueue");
  const truth = JSON.parse(await readFile(JOBQUEUE_TRUTH, "utf8"));
  assert.equal(fixture.truth_sha256, canonicalJsonSha256(truth));
  assert.equal(fixture.repetitions, 5);
});
