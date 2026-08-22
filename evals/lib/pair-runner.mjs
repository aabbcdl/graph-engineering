import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { access, cp, lstat, mkdir, open, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RUN_VERSION } from "../../skills/autonomous-engineering-graph/scripts/graph-runner.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Cannot hash undefined JSON value");
    return encoded;
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  }
  return "{" + Object.keys(value).sort()
    .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key]))
    .join(",") + "}";
}

function canonicalJsonSha256(value) {
  return sha256(canonicalJson(value) + "\n");
}

function sha256Hex(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function hashTree(root) {
  const hash = createHash("sha256");
  async function visit(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    if (!entries.length) hash.update(`directory\0${relativeDirectory.replaceAll("\\", "/")}\0`);
    for (const entry of entries) {
      const relative = path.join(relativeDirectory, entry.name);
      const portable = relative.replaceAll("\\", "/");
      const target = path.join(directory, entry.name);
      const details = await lstat(target);
      if (details.isSymbolicLink()) {
        hash.update(`symlink\0${portable}\0${await readlink(target)}\0`);
      } else if (details.isDirectory()) {
        hash.update(`directory\0${portable}\0`);
        await visit(target, relative);
      } else if (details.isFile()) {
        hash.update(`file\0${portable}\0`);
        hash.update(await readFile(target));
        hash.update("\0");
      } else {
        throw new Error(`Unsupported fixture entry: ${target}`);
      }
    }
  }
  await visit(root);
  return hash.digest("hex");
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function validateManifest(manifest) {
  if (!manifest || manifest.version !== 1) throw new Error("Evaluation manifest version must be 1");
  requiredString(manifest.model, "model");
  requiredString(manifest.reasoning_effort, "reasoning_effort");
  if (!Number.isSafeInteger(manifest.token_budget) || manifest.token_budget <= 0) throw new Error("token_budget must be a positive integer");
  if (!Number.isSafeInteger(manifest.timeout_minutes) || manifest.timeout_minutes <= 0) {
    throw new Error("timeout_minutes must be a positive integer");
  }
  if (!Array.isArray(manifest.fixtures) || !manifest.fixtures.length) throw new Error("fixtures must not be empty");
  for (const arm of ["graph", "baseline"]) {
    if (!Array.isArray(manifest.arms?.[arm]?.command) || !manifest.arms[arm].command.length) {
      throw new Error(`arms.${arm}.command must be a non-empty argv array`);
    }
    manifest.arms[arm].command.forEach((item) => requiredString(item, `arms.${arm}.command item`));
  }
  for (const fixture of manifest.fixtures) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(fixture.id || "")) throw new Error(`Invalid fixture id: ${fixture.id}`);
    requiredString(fixture.snapshot, `fixture ${fixture.id} snapshot`);
    requiredString(fixture.goal, `fixture ${fixture.id} goal`);
    requiredString(fixture.truth_file, `fixture ${fixture.id} truth_file`);
    if (fixture.truth_sha256 !== undefined && !sha256Hex(fixture.truth_sha256)) {
      throw new Error("fixture " + fixture.id + " truth_sha256 must be a SHA-256 hex string");
    }
    if (!Number.isInteger(fixture.repetitions) || fixture.repetitions <= 0) {
      throw new Error(`fixture ${fixture.id} repetitions must be a positive integer`);
    }
  }
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

async function runProcess(argv, options) {
  const stdout = await open(options.stdoutPath, "wx");
  const stderr = await open(options.stderrPath, "wx");
  const started = Date.now();
  let timedOut = false;
  let child;
  try {
    child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", stdout.fd, stderr.fd],
    });
  } catch (error) {
    await Promise.allSettled([stdout.close(), stderr.close()]);
    throw error;
  }
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        child.kill();
      }, options.timeoutMs)
    : null;
  const outcome = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(async () => {
    if (timer) clearTimeout(timer);
    await Promise.allSettled([stdout.close(), stderr.close()]);
  });
  return { ...outcome, timed_out: timedOut, wall_ms: Date.now() - started };
}

function adapterErrors(raw, expected) {
  const errors = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ["result is not an object"];
  if (raw.model !== expected.model) errors.push(`actual model ${raw.model ?? "missing"} does not match ${expected.model}`);
  if (raw.reasoning_effort !== expected.reasoningEffort) {
    errors.push(`actual reasoning effort ${raw.reasoning_effort ?? "missing"} does not match ${expected.reasoningEffort}`);
  }
  if (raw.token_budget !== expected.tokenBudget) {
    errors.push(`reported token budget ${raw.token_budget ?? "missing"} does not match ${expected.tokenBudget}`);
  }
  if (raw.timeout_minutes !== expected.timeoutMinutes) {
    errors.push(`reported timeout minutes ${raw.timeout_minutes ?? "missing"} does not match ${expected.timeoutMinutes}`);
  }
  if (!raw.usage || !Number.isFinite(raw.usage.input_tokens) || !Number.isFinite(raw.usage.output_tokens)) {
    errors.push("backend-reported input and output token usage is required");
  }
  if (!Array.isArray(raw.findings)) errors.push("findings must be an array");
  if (!Array.isArray(raw.regression_checks)) errors.push("regression_checks must be an array");
  if (typeof raw.completed_gates !== "boolean") errors.push("completed_gates must be boolean");
  return errors;
}

async function runArm({
  arm,
  command,
  frozenSnapshot,
  pairDirectory,
  manifestDirectory,
  fixture,
  repetition,
  fixtureSha,
  manifest,
  harnessPath,
}) {
  const workspace = path.join(pairDirectory, `${arm}-workspace`);
  await cp(frozenSnapshot, workspace, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
  if ((await hashTree(workspace)) !== fixtureSha) throw new Error(`Failed to reproduce frozen snapshot for ${arm}`);
  const output = path.join(pairDirectory, `${arm}-result.json`);
  const stdoutPath = path.join(pairDirectory, `${arm}.stdout.log`);
  const stderrPath = path.join(pairDirectory, `${arm}.stderr.log`);
  const goalFile = path.join(pairDirectory, "goal.txt");
  const argv = [
    ...command,
    "--workspace", workspace,
    "--goal-file", goalFile,
    "--output", output,
    "--model", manifest.model,
    "--reasoning-effort", manifest.reasoning_effort,
    "--token-budget", String(manifest.token_budget),
    "--harness-file", harnessPath,
    "--arm", arm,
    "--fixture-id", fixture.id,
    "--repetition", String(repetition),
  ];
  if (Number.isFinite(manifest.timeout_minutes) && manifest.timeout_minutes > 0) {
    argv.push("--timeout-minutes", String(manifest.timeout_minutes));
  }
  const processResult = await runProcess(argv, {
    cwd: manifestDirectory,
    stdoutPath,
    stderrPath,
    timeoutMs: Number.isFinite(manifest.timeout_minutes) ? manifest.timeout_minutes * 60_000 : null,
    env: {
      ...process.env,
      GRAPH_EVAL_ARM: arm,
      GRAPH_EVAL_FIXTURE_ID: fixture.id,
      GRAPH_EVAL_REPETITION: String(repetition),
    },
  });
  let raw = null;
  let readError = null;
  try {
    raw = JSON.parse(await readFile(output, "utf8"));
  } catch (error) {
    readError = `adapter result unavailable: ${error.message}`;
  }
  const errors = raw ? adapterErrors(raw, {
    model: manifest.model,
    reasoningEffort: manifest.reasoning_effort,
    tokenBudget: manifest.token_budget,
    timeoutMinutes: manifest.timeout_minutes,
  }) : [readError];
  if (processResult.code !== 0) errors.push(`adapter exited with code ${processResult.code ?? "null"}`);
  if (processResult.timed_out) errors.push("adapter timed out");
  return {
    ...(raw || {}),
    status: errors.length ? "invalid" : raw.status,
    fixture_sha256: fixtureSha,
    goal_sha256: sha256(fixture.goal),
    wall_ms: processResult.wall_ms,
    harness_errors: errors.filter(Boolean),
    adapter_exit_code: processResult.code,
    adapter_signal: processResult.signal,
    logs: {
      stdout: path.relative(pairDirectory, stdoutPath).replaceAll("\\", "/"),
      stderr: path.relative(pairDirectory, stderrPath).replaceAll("\\", "/"),
    },
  };
}

async function prepareFrozenFixture({ fixture, manifestDirectory, outputDirectory }) {
  const source = path.resolve(manifestDirectory, fixture.snapshot);
  const sourceBefore = await hashTree(source);
  const target = path.join(outputDirectory, "snapshots", fixture.id);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
  const [sourceAfter, frozenHash] = await Promise.all([hashTree(source), hashTree(target)]);
  if (sourceBefore !== sourceAfter) throw new Error(`Fixture changed while freezing: ${fixture.id}`);
  if (sourceBefore !== frozenHash) throw new Error(`Frozen fixture does not match its source: ${fixture.id}`);
  return { target, sha256: frozenHash };
}

async function sha256File(target) {
  return createHash("sha256").update(await readFile(target)).digest("hex");
}

async function harnessIdentity({ manifestSha256 = null } = {}) {
  const runnerPath = path.join(PROJECT_ROOT, "skills", "autonomous-engineering-graph", "scripts", "graph-runner.mjs");
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf8" });
  return {
    revision: revision.status === 0 ? revision.stdout.trim() : null,
    runner_sha256: await sha256File(runnerPath),
    runtime_sha256: await hashTree(path.join(PROJECT_ROOT, "skills", "autonomous-engineering-graph", "scripts", "runtime")),
    evals_lib_sha256: await hashTree(path.join(PROJECT_ROOT, "evals", "lib")),
    adapters_sha256: await hashTree(path.join(PROJECT_ROOT, "evals", "adapters")),
    manifest_sha256: manifestSha256,
    graph_run_version_expected: RUN_VERSION,
    environment: { node: process.version, platform: process.platform, arch: process.arch },
  };
}

async function runPairedEvaluation({ manifestPath, outputDirectory }) {
  const resolvedManifest = path.resolve(manifestPath);
  const manifestDirectory = path.dirname(resolvedManifest);
  const manifestContent = await readFile(resolvedManifest, "utf8");
  const manifest = JSON.parse(manifestContent);
  validateManifest(manifest);
  const manifestSha256 = sha256(manifestContent);
  const harness = await harnessIdentity({ manifestSha256 });
  const resolvedOutput = path.resolve(outputDirectory);
  if (await exists(resolvedOutput)) throw new Error(`Output directory already exists: ${resolvedOutput}`);
  await mkdir(resolvedOutput, { recursive: true });
  const harnessPath = path.join(resolvedOutput, "harness.json");
  await writeFile(harnessPath, `${JSON.stringify(harness, null, 2)}\n`, "utf8");
  const results = {
    version: 1,
    manifest: resolvedManifest,
    manifest_sha256: manifestSha256,
    harness,
    generated_at: new Date().toISOString(),
    minimum_pairs_for_claim: manifest.minimum_pairs_for_claim || 5,
    fixtures: [],
    pairs: [],
  };
  const hiddenTruth = new Map();
  for (const fixture of manifest.fixtures) {
    const truth = JSON.parse(await readFile(path.resolve(manifestDirectory, fixture.truth_file), "utf8"));
    const truthSha256 = canonicalJsonSha256(truth);
    if (fixture.truth_sha256 && fixture.truth_sha256.toLowerCase() !== truthSha256) {
      throw new Error("Fixture " + fixture.id + " truth SHA-256 differs from manifest");
    }
    hiddenTruth.set(fixture.id, { truth, truth_sha256: truthSha256 });
    const frozen = await prepareFrozenFixture({ fixture, manifestDirectory, outputDirectory: resolvedOutput });
    results.fixtures.push({ id: fixture.id, fixture_sha256: frozen.sha256, truth_sha256: truthSha256 });
    for (let repetition = 1; repetition <= fixture.repetitions; repetition += 1) {
      const pairDirectory = path.join(resolvedOutput, "runs", fixture.id, String(repetition).padStart(3, "0"));
      await mkdir(pairDirectory, { recursive: true });
      await writeFile(path.join(pairDirectory, "goal.txt"), `${fixture.goal}\n`, "utf8");
      const order = repetition % 2 === 1 ? ["graph", "baseline"] : ["baseline", "graph"];
      const pair = { fixture_id: fixture.id, repetition, arm_order: order };
      for (const arm of order) {
        pair[arm] = await runArm({
          arm,
          command: manifest.arms[arm].command,
          frozenSnapshot: frozen.target,
          pairDirectory,
          manifestDirectory,
          fixture,
          repetition,
          fixtureSha: frozen.sha256,
          manifest,
          harnessPath,
        });
      }
      if ((await hashTree(frozen.target)) !== frozen.sha256) throw new Error(`Adapter modified frozen fixture: ${fixture.id}`);
      results.pairs.push(pair);
      await writeFile(path.join(pairDirectory, "pair.json"), `${JSON.stringify(pair, null, 2)}\n`, "utf8");
      await writeFile(path.join(resolvedOutput, "pairs.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
    }
  }
  const scoreInput = {
    ...results,
    fixtures: results.fixtures.map((fixture) => ({ ...fixture, truth: hiddenTruth.get(fixture.id).truth })),
  };
  const scoreInputPath = path.join(resolvedOutput, "score-input.json");
  await writeFile(scoreInputPath, `${JSON.stringify(scoreInput, null, 2)}\n`, "utf8");
  return {
    output_directory: resolvedOutput,
    pairs_path: path.join(resolvedOutput, "pairs.json"),
    score_input_path: scoreInputPath,
    ...results,
  };
}

export { adapterErrors, argumentValue, canonicalJsonSha256, harnessIdentity, hashTree, runPairedEvaluation, validateManifest };
