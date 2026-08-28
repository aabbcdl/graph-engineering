import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, cp, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const HIDDEN_TEST_DIRECTORY = path.join(FIXTURE_DIRECTORY, "jobqueue-hidden-tests");
const GO_TOOLCHAIN_CONTRACT = Object.freeze({
  ecosystem: "go",
  version: "go1.27.0",
  binary_sha256_by_platform: Object.freeze({
    "win32-x64": "7d828191ba32519a9c9361789ab647486236ed45c660889196c7770a8ff1985c",
    "linux-x64": "1db869c560a193573a71be466a34e0d4abb7792d78165c6102cdda069276a3a8",
    "darwin-arm64": "71c4991041d8e44975c882e4f72005719c958013d3340dc665a3808b72ddf702",
  }),
});
const GO_COMMAND_TIMEOUT_MS = 60_000;
const GO_HIDDEN_COMMAND_TIMEOUT_MS = 60_000;

const DEFINITIONS = [
  { id: "config-storage-path", category: "cross_module_contract", package: ".", tests: ["TestHiddenConfigStoragePath"], pattern: /storage.{0,40}(?:path|file)|config.{0,40}(?:store|persist)/i },
  { id: "config-invalid-json", category: "error_handling", package: ".", tests: ["TestHiddenConfigInvalidJSON"], pattern: /config.{0,40}(?:json|parse|invalid)|invalid.{0,40}config/i },
  { id: "events-callback-deadlock", category: "concurrency", package: ".", tests: ["TestHiddenEventCallbacksCanUnsubscribe"], pattern: /event.{0,40}(?:deadlock|callback|subscriber|unsubscribe)|callback.{0,40}(?:lock|deadlock)/i },
  { id: "queue-fifo-order", category: "semantic_documentation", package: ".", tests: ["TestHiddenQueueFIFO"], pattern: /(?:fifo|queue order|same.priority|first.in)/i },
  { id: "queue-priority-order", category: "cross_module_contract", package: ".", tests: ["TestHiddenQueuePriority"], pattern: /(?:priority|higher.priority|queue order)/i },
  { id: "queue-empty-wait", category: "boundary", package: ".", tests: ["TestHiddenQueueEmptyWaitsForContext"], pattern: /(?:empty queue|dequeue).{0,40}(?:wait|context|cancel|block)/i },
  { id: "queue-close-wakeup", category: "concurrency", package: ".", tests: ["TestHiddenQueueCloseWakesBlockedProducer"], pattern: /(?:queue|producer|close).{0,40}(?:wake|block|wait|deadlock)/i },
  { id: "retry-first-delay", category: "boundary", package: ".", tests: ["TestHiddenRetryFirstDelay"], pattern: /(?:retry|backoff).{0,40}(?:first|initial|delay|off.by.one)/i },
  { id: "retry-attempt-limit", category: "boundary", package: ".", tests: ["TestHiddenRetryLimit"], pattern: /(?:retry|attempt).{0,40}(?:limit|max|off.by.one)/i },
  { id: "retry-delay-cap", category: "boundary", package: ".", tests: ["TestHiddenRetryCap"], pattern: /(?:retry|backoff).{0,40}(?:cap|max|overflow|delay)/i },
  { id: "store-rename-error", category: "error_handling", package: ".", tests: ["TestHiddenStoreRenameError"], pattern: /(?:store|persist|snapshot).{0,40}(?:rename|replace|write).{0,40}error/i },
  { id: "store-corruption-error", category: "error_handling", package: ".", tests: ["TestHiddenStoreCorruption"], pattern: /(?:store|snapshot|persist).{0,40}(?:corrupt|decode|json|error)/i },
  { id: "store-corrupt-read-close", category: "resource_leak", package: "./store", tests: ["TestHiddenStoreCorruptReadClosesHandle"], pattern: /(?:store|snapshot|file).{0,40}(?:close|handle|leak|descriptor)/i },
  { id: "store-recovery-order", category: "semantic_documentation", package: ".", tests: ["TestHiddenStoreRestoresOrder"], pattern: /(?:store|recover|snapshot).{0,40}(?:order|fifo|reverse)/i },
  { id: "scheduler-retry-units", category: "cross_module_contract", package: ".", tests: ["TestHiddenSchedulerPreservesRetryDuration"], pattern: /(?:scheduler|retry).{0,40}(?:duration|millisecond|unit|delay)/i },
  { id: "scheduler-double-start", category: "concurrency", package: "./scheduler", tests: ["TestHiddenSchedulerRejectsSecondStart"], pattern: /scheduler.{0,40}(?:start|concurrent|twice|duplicate)/i },
  { id: "scheduler-ticker-stop", category: "resource_leak", package: "./scheduler", tests: ["TestHiddenSchedulerStopsTicker"], pattern: /(?:scheduler|ticker).{0,40}(?:stop|leak|resource)/i },
  { id: "scheduler-location", category: "semantic_documentation", package: ".", tests: ["TestHiddenSchedulerPreservesLocation"], pattern: /(?:scheduler|daily|time.?zone|dst|location)/i },
  { id: "worker-retry-after-stop", category: "resource_leak", package: ".", tests: ["TestHiddenWorkerRetryDoesNotSurviveStop"], pattern: /(?:worker|retry|shutdown).{0,40}(?:stop|cancel|enqueue|leak)/i },
  { id: "worker-stop-wait", category: "concurrency", package: "./worker", tests: ["TestHiddenWorkerStopWaitsForOutstandingRetries"], pattern: /(?:worker|pool|shutdown).{0,40}(?:wait|retry|stop|goroutine)/i },
  { id: "api-ack-unknown", category: "error_handling", package: ".", tests: ["TestHiddenAckUnknownJob"], pattern: /(?:ack|acknowledg).{0,40}(?:unknown|missing|error|in.flight)/i },
  { id: "api-ack-event-order", category: "concurrency", package: ".", tests: ["TestHiddenAckEventOrder"], pattern: /(?:ack|acknowledg|event).{0,40}(?:order|in.flight|observer)/i },
  { id: "api-stats-utilization", category: "cross_module_contract", package: ".", tests: ["TestHiddenStatsUtilization"], pattern: /(?:stats|utilization|capacity|queued).{0,40}(?:ratio|count|formula)/i },
];

function goExecutable() {
  if (process.env.JOBQUEUE_GO_BINARY) return process.env.JOBQUEUE_GO_BINARY;
  const local = path.resolve(FIXTURE_DIRECTORY, "..", "..", ".tmp", "go-toolchain", "bin", process.platform === "win32" ? "go.exe" : "go");
  if (existsSync(local)) return local;
  const command = process.platform === "win32" ? "where.exe" : "which";
  const resolved = spawnSync(command, [process.platform === "win32" ? "go.exe" : "go"], { encoding: "utf8", windowsHide: true });
  const executable = resolved.status === 0 ? resolved.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) : null;
  return executable || (process.platform === "win32" ? "go.exe" : "go");
}

function toolchainContractForPlatform(platform = process.platform, arch = process.arch) {
  const platformKey = `${platform}-${arch}`;
  const binarySha256 = GO_TOOLCHAIN_CONTRACT.binary_sha256_by_platform[platformKey];
  if (!binarySha256) return null;
  return {
    ecosystem: GO_TOOLCHAIN_CONTRACT.ecosystem,
    version: GO_TOOLCHAIN_CONTRACT.version,
    platform: platformKey,
    binary_sha256: binarySha256,
  };
}

function verifyGoToolchain() {
  const contract = toolchainContractForPlatform();
  if (!contract) {
    return { status: "fail", detail: `unsupported JobQueue toolchain platform ${process.platform}-${process.arch}` };
  }
  const executable = goExecutable();
  const version = spawnSync(executable, ["version"], { encoding: "utf8", windowsHide: true });
  const versionText = [version.stdout, version.stderr].filter(Boolean).join(" ").trim();
  if (version.status !== 0 || !new RegExp(`\\b${GO_TOOLCHAIN_CONTRACT.version.replaceAll(".", "\\.")}\\b`).test(versionText)) {
    return { status: "fail", detail: `expected ${GO_TOOLCHAIN_CONTRACT.version}; observed ${versionText || "toolchain unavailable"}` };
  }
  let binarySha256 = null;
  try {
    binarySha256 = createHash("sha256").update(readFileSync(executable)).digest("hex");
  } catch (error) {
    return { status: "fail", detail: `cannot hash Go toolchain: ${error.message || error}` };
  }
  if (binarySha256.toLowerCase() !== contract.binary_sha256) {
    return { status: "fail", detail: `Go binary SHA-256 ${binarySha256} does not match pinned ${contract.binary_sha256}` };
  }
  return {
    status: "pass",
    detail: `${versionText}; sha256=${binarySha256}`,
    executable,
    version: versionText,
    binary_sha256: binarySha256,
    toolchain_contract: contract,
  };
}


function commandResult(command, argumentsList, cwd) {
  const result = spawnSync(command, argumentsList, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: GO_COMMAND_TIMEOUT_MS,
  });
  const output = [result.stdout, result.stderr, result.error && String(result.error.message || result.error)]
    .filter(Boolean)
    .join("\n")
    .trim();
  return { status: result.status === 0 ? "pass" : "fail", detail: output.slice(-4000) };
}

function runPublicChecks(command, cwd, runner = commandResult) {
  return {
    // Evaluation fixtures are source snapshots, not release binaries. Disable
    // VCS stamping so an unrelated parent Git ownership/configuration cannot
    // turn a valid compile into infrastructure noise.
    build: runner(command, ["build", "-buildvcs=false", "./..."], cwd),
    tests: runner(command, ["test", "./..."], cwd),
  };
}

async function makeHiddenWorkspace(workspace) {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobqueue-evaluator-"));
  const target = path.join(root, "workspace");
  await cp(workspace, target, {
    recursive: true,
    filter(source) {
      const relative = path.relative(workspace, source);
      return !relative.split(path.sep).includes(".git");
    },
  });
  await cp(path.join(HIDDEN_TEST_DIRECTORY, "hidden_root_test.go"), path.join(target, "zz_hidden_evaluator_test.go"));
  for (const packageName of ["store", "scheduler", "worker"]) {
    await cp(
      path.join(HIDDEN_TEST_DIRECTORY, packageName, "hidden_" + packageName + "_test.go"),
      path.join(target, packageName, "zz_hidden_evaluator_test.go"),
    );
  }
  return { root, target };
}

function parseTestResults(detail) {
  const results = new Map();
  for (const line of detail.split(/\r?\n/)) {
    try {
      const entry = JSON.parse(line);
      if (entry.Test && (entry.Action === "pass" || entry.Action === "fail")) {
        results.set(entry.Test, entry.Action);
      }
    } catch {
      // Go can interleave ordinary package output with JSON records.
    }
  }
  return results;
}

function runHiddenPackage(workspace, packagePath) {
  const result = spawnSync(goExecutable(), ["test", "-json", "-count=1", "-timeout=3s", packagePath], {
    cwd: workspace,
    encoding: "utf8",
    windowsHide: true,
    timeout: GO_HIDDEN_COMMAND_TIMEOUT_MS,
  });
  const output = [result.stdout, result.stderr, result.error && String(result.error.message || result.error)]
    .filter(Boolean)
    .join("\n")
    .trim();
  return { results: parseTestResults(output), detail: output.slice(-8000) };
}

async function observedDefects(workspace) {
  const toolchain = verifyGoToolchain();
  if (toolchain.status !== "pass") throw new Error(`JobQueue evaluator toolchain contract failed: ${toolchain.detail}`);
  const hidden = await makeHiddenWorkspace(workspace);
  try {
    const packageRuns = new Map();
    for (const packagePath of new Set(DEFINITIONS.map((definition) => definition.package))) {
      packageRuns.set(packagePath, runHiddenPackage(hidden.target, packagePath));
    }
    return DEFINITIONS.map((definition) => {
      const run = packageRuns.get(definition.package);
      const observed = definition.tests.every((name) => {
        const status = run.results.get(name);
        return status === "pass" || status === "fail";
      });
      const repaired = observed && definition.tests.every((name) => run.results.get(name) === "pass");
      return {
        id: definition.id,
        observed,
        repaired,
        detail: repaired
          ? "hidden acceptance passed"
          : observed
            ? run.detail || "hidden acceptance failed"
            : "hidden acceptance did not produce a pass/fail test record",
      };
    });
  } finally {
    await rm(hidden.root, { recursive: true, force: true });
  }
}

async function runEvaluationChecks(workspace, command, options = {}) {
  const publicRunner = options.runPublicChecks || ((go, cwd) => runPublicChecks(go, cwd));
  const defectRunner = options.observeDefects || observedDefects;
  const publicChecks = publicRunner(command, workspace);
  const defects = await defectRunner(workspace);
  return { defects, ...publicChecks };
}

function findingText(finding) {
  return [
    finding?.title,
    finding?.summary,
    finding?.evidence,
    ...(Array.isArray(finding?.files) ? finding.files : []),
  ].filter(Boolean).join("\n");
}

function gradeFindings(rawFindings, defects) {
  const unmatched = new Set((rawFindings || []).map((_, index) => index));
  const matchedByDefinition = new Map(DEFINITIONS.map((definition) => [definition.id, []]));
  (rawFindings || []).forEach((finding, index) => {
    if (finding?.validated !== true) return;
    const matches = DEFINITIONS.filter((definition) => definition.pattern.test(findingText(finding)));
    if (matches.length !== 1) return;
    matchedByDefinition.get(matches[0].id).push(finding);
    unmatched.delete(index);
  });
  const findings = [];
  for (const definition of DEFINITIONS) {
    const matching = matchedByDefinition.get(definition.id);
    const repaired = defects.find((defect) => defect.id === definition.id)?.repaired === true;
    if (matching.length || repaired) {
      findings.push({
        defect_id: definition.id,
        title: matching[0]?.title || definition.id,
        validated: true,
        fixed: repaired,
        repair_verified: repaired,
      });
    }
  }
  for (const index of unmatched) {
    const finding = rawFindings[index];
    if (finding?.validated !== true) continue;
    findings.push({
      defect_id: null,
      title: finding.title || "Unmapped validated finding",
      validated: true,
      fixed: finding.fixed === true,
      repair_verified: false,
    });
  }
  return findings;
}

async function evaluate(workspace, rawFindings = []) {
  const go = goExecutable();
  const toolchain = verifyGoToolchain();
  const checks = toolchain.status === "pass"
    ? await runEvaluationChecks(workspace, go)
    : {
        defects: DEFINITIONS.map((definition) => ({ id: definition.id, observed: false, repaired: false, detail: toolchain.detail })),
        build: { status: "fail", detail: `skipped: ${toolchain.detail}` },
        tests: { status: "fail", detail: `skipped: ${toolchain.detail}` },
      };
  return {
    defects: checks.defects,
    toolchain_contract: toolchain.toolchain_contract || null,
    findings: gradeFindings(rawFindings, checks.defects),
    regression_checks: [
      { id: "go-toolchain", ...toolchain },
      { id: "go-build", ...checks.build },
      { id: "go-test", ...checks.tests },
    ],
  };
}

async function assertHiddenTemplatesPresent() {
  await Promise.all([
    access(path.join(HIDDEN_TEST_DIRECTORY, "hidden_root_test.go")),
    access(path.join(HIDDEN_TEST_DIRECTORY, "store", "hidden_store_test.go")),
    access(path.join(HIDDEN_TEST_DIRECTORY, "scheduler", "hidden_scheduler_test.go")),
    access(path.join(HIDDEN_TEST_DIRECTORY, "worker", "hidden_worker_test.go")),
  ]);
}

export {
  DEFINITIONS,
  GO_TOOLCHAIN_CONTRACT,
  assertHiddenTemplatesPresent,
  evaluate,
  gradeFindings,
  goExecutable,
  observedDefects,
  parseTestResults,
  runPublicChecks,
  runEvaluationChecks,
  toolchainContractForPlatform,
  verifyGoToolchain,
};
