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
  runPublicChecks as runJobqueuePublicChecks,
  runEvaluationChecks,
  toolchainContractForPlatform,
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

test("jobqueue evaluator binds the official binary for each CI platform", () => {
  assert.deepEqual(toolchainContractForPlatform("win32", "x64"), {
    ecosystem: "go",
    version: "go1.27.0",
    platform: "win32-x64",
    binary_sha256: "7d828191ba32519a9c9361789ab647486236ed45c660889196c7770a8ff1985c",
  });
  assert.deepEqual(toolchainContractForPlatform("linux", "x64"), {
    ecosystem: "go",
    version: "go1.27.0",
    platform: "linux-x64",
    binary_sha256: "1db869c560a193573a71be466a34e0d4abb7792d78165c6102cdda069276a3a8",
  });
  assert.deepEqual(toolchainContractForPlatform("darwin", "arm64"), {
    ecosystem: "go",
    version: "go1.27.0",
    platform: "darwin-arm64",
    binary_sha256: "a19a71df81715c12d9a7e81bab036c12696fec1ddbd4258b48a2131a9080b267",
  });
});

test("jobqueue evaluator completes public checks before hidden observation", async () => {
  const phases = [];
  let active = 0;
  let maximumActive = 0;
  const enter = (name) => {
    phases.push(`${name}:start`);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    return () => {
      active -= 1;
      phases.push(`${name}:end`);
    };
  };
  const result = await runEvaluationChecks("fixture", "go", {
    runPublicChecks() {
      const leave = enter("public");
      leave();
      return {
        build: { status: "pass", detail: "" },
        tests: { status: "pass", detail: "" },
      };
    },
    observeDefects: async () => {
      const leave = enter("hidden");
      await Promise.resolve();
      leave();
      return [];
    },
  });
  assert.equal(maximumActive, 1);
  assert.deepEqual(phases, ["public:start", "public:end", "hidden:start", "hidden:end"]);
  assert.deepEqual(result.defects, []);
});

test("jobqueue public build is independent of parent Git VCS stamping", () => {
  const commands = [];
  const result = runJobqueuePublicChecks("go", "fixture", (command, args, workspace) => {
    commands.push({ command, args, workspace });
    return { status: "pass", detail: "" };
  });
  assert.deepEqual(commands[0], {
    command: "go",
    args: ["build", "-buildvcs=false", "./..."],
    workspace: "fixture",
  });
  assert.equal(result.build.status, "pass");
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
    ["go-toolchain", "pass"],
    ["go-build", "pass"],
    ["go-test", "pass"],
  ]);
  assert.deepEqual(result.toolchain_contract, toolchainContractForPlatform());
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
  assert.deepEqual(manifest.budget_contract, {
    token_scope: "aggregate",
    wall_time_scope: "aggregate",
    enforcement: "hard",
  });
  assert.equal(manifest.toolchain.version, "go1.27.0");
  assert.deepEqual(manifest.toolchain.platforms, {
    "win32-x64": {
      binary_sha256: "7d828191ba32519a9c9361789ab647486236ed45c660889196c7770a8ff1985c",
    },
    "linux-x64": {
      binary_sha256: "1db869c560a193573a71be466a34e0d4abb7792d78165c6102cdda069276a3a8",
    },
    "darwin-arm64": {
      binary_sha256: "a19a71df81715c12d9a7e81bab036c12696fec1ddbd4258b48a2131a9080b267",
    },
  });
});

test("the npm package does not ship hidden evaluation truth or hidden tests", async () => {
  const packageJson = JSON.parse(await readFile(path.resolve(TEST_DIR, "..", "..", "package.json"), "utf8"));
  assert.equal(packageJson.files.includes("evals/fixtures"), false);
  assert.equal(packageJson.files.some((entry) => /hidden|truth|manifest\.pilot-jobqueue/.test(entry)), false);
  assert.equal(packageJson.files.some((entry) => entry === "evals/lib" || entry.startsWith("evals/")), false);
  const npmIgnore = await readFile(path.resolve(TEST_DIR, "..", "..", ".npmignore"), "utf8");
  assert.match(npmIgnore, /skills\/\*\*\/scripts\/tests\//);
});

test("CI provisions the pinned Go toolchain before evaluation tests", async () => {
  const workflow = await readFile(path.resolve(TEST_DIR, "..", "..", ".github", "workflows", "ci.yml"), "utf8");
  const setupIndex = workflow.indexOf("uses: actions/setup-go@v5");
  const evaluationIndex = workflow.indexOf("run: npm run test:eval");
  assert.ok(setupIndex >= 0, "CI must install the pinned Go toolchain");
  assert.ok(evaluationIndex > setupIndex, "Go setup must run before evaluation tests");
  assert.match(workflow, /go-version:\s*["']?1\.27\.0["']?/);
});

test("CI enforces release documents, package policy, and the committed diff", async () => {
  const workflow = await readFile(path.resolve(TEST_DIR, "..", "..", ".github", "workflows", "ci.yml"), "utf8");
  assert.match(workflow, /os:\s*\[ubuntu-latest, macos-14\]/);
  for (const command of [
    "npm run test:package-policy",
    "npm run validate:package",
    "npm run test:package-smoke",
    "npm run release:check",
    "git diff-tree --check --root --no-commit-id -r HEAD",
  ]) {
    assert.equal(workflow.includes(`run: ${command}`), true, `CI is missing: ${command}`);
  }
});
