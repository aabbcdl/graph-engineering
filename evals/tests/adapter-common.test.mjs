import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { evaluationStateRoot, graphRunnerArguments, isRepositoryFinding } from "../adapters/common.mjs";
import { resolveToolchainContract, validateManifest } from "../lib/pair-runner.mjs";

const COMMON_MODULE = pathToFileURL(path.resolve("evals/adapters/common.mjs")).href;

function probeStateRoot({ output, workspace, tmpdir, cwd, env = {} }) {
  const input = JSON.stringify({ output, workspace });
  const source = `import { evaluationStateRoot } from ${JSON.stringify(COMMON_MODULE)};
try {
  process.stdout.write(JSON.stringify({ value: evaluationStateRoot(${input}) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error.message }));
  process.exitCode = 2;
}`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env, TMPDIR: tmpdir, TMP: tmpdir, TEMP: tmpdir },
  });
  return { ...result, parsed: JSON.parse(result.stdout || "{}") };
}

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

test("Graph evaluation moves state outside a parent Git checkout when output is nested inside it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-eval-state-root-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, "results", "001", "graph-workspace");
  const output = path.join(root, "results", "001", "graph-result.json");
  await mkdir(workspace, { recursive: true });
  const initialized = spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);

  const stateRoot = evaluationStateRoot({ output, workspace });
  assert.notEqual(path.resolve(stateRoot), path.join(path.dirname(output), "graph-state"));
  assert.equal(path.resolve(stateRoot).startsWith(path.resolve(root) + path.sep), false);
});

test("Graph evaluation fails closed when TMPDIR is inside the source checkout", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-eval-unsafe-tmp-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const initialized = spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);

  const probe = probeStateRoot({
    output: path.join(root, "results", "result.json"),
    workspace,
    tmpdir: path.join(root, ".tmp"),
    cwd: root,
  });
  assert.equal(probe.status, 2);
  assert.match(probe.parsed.error, /outside the source checkout/);
});

test("Graph evaluation fails closed when TMPDIR is a relative path inside the checkout", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-eval-relative-tmp-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const initialized = spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);

  const probe = probeStateRoot({
    output: path.join(root, "results", "result.json"),
    workspace,
    tmpdir: ".tmp",
    cwd: root,
  });
  assert.equal(probe.status, 2);
  assert.match(probe.parsed.error, /outside the source checkout/);
});

test("Graph evaluation fails closed when TMPDIR resolves through a symlink into the checkout", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-eval-symlink-tmp-"));
  const linkParent = await mkdtemp(path.join(os.tmpdir(), "graph-eval-tmp-link-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(linkParent, { recursive: true, force: true }),
    ]);
  });
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const initialized = spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  const link = path.join(linkParent, "tmp");
  try {
    await (await import("node:fs/promises")).symlink(root, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EACCES", "EPERM", "ENOTSUP"].includes(error?.code)) {
      t.skip(`symlink unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const probe = probeStateRoot({
    output: path.join(root, "results", "result.json"),
    workspace,
    tmpdir: link,
    cwd: root,
  });
  assert.equal(probe.status, 2);
  assert.match(probe.parsed.error, /outside the source checkout/);
});

test("Graph evaluation ignores ambient Git redirectors when locating the source checkout", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-eval-git-env-"));
  const ambient = await mkdtemp(path.join(os.tmpdir(), "graph-eval-ambient-git-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(ambient, { recursive: true, force: true }),
    ]);
  });
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const initialized = spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" });
  const ambientInitialized = spawnSync("git", ["init", "--quiet", ambient], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(ambientInitialized.status, 0, ambientInitialized.stderr);

  const probe = probeStateRoot({
    output: path.join(root, "results", "result.json"),
    workspace,
    tmpdir: os.tmpdir(),
    cwd: root,
    env: {
      GIT_DIR: path.join(ambient, ".git"),
      GIT_WORK_TREE: ambient,
      GIT_INDEX_FILE: path.join(ambient, "index"),
    },
  });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.parsed.value.startsWith(path.resolve(root) + path.sep), false);
});

test("the pilot declares one hard aggregate budget contract for both arms", async () => {
  const manifest = JSON.parse(await readFile(path.resolve("evals/manifest.pilot-jobqueue.json"), "utf8"));
  assert.deepEqual(manifest.budget_contract, {
    token_scope: "aggregate",
    wall_time_scope: "aggregate",
    enforcement: "hard",
  });
});

test("toolchain declarations require an ecosystem and platform binding", () => {
  const base = {
    version: 1,
    model: "fixture-model",
    reasoning_effort: "high",
    token_budget: 1000,
    timeout_minutes: 180,
    fixtures: [{ id: "fixture", snapshot: "fixture", goal: "Audit fixture", truth_file: "truth.json", repetitions: 1 }],
    arms: {
      graph: { command: [process.execPath, "graph.mjs"] },
      baseline: { command: [process.execPath, "baseline.mjs"] },
    },
  };
  assert.throws(
    () => validateManifest({ ...base, toolchain: { version: "go1.27.0", binary_sha256: "a".repeat(64) } }),
    /toolchain must include ecosystem and platform/i,
  );
});

test("toolchain declarations resolve one pinned contract per host platform", () => {
  const toolchain = {
    ecosystem: "go",
    version: "go1.27.0",
    platforms: {
      "win32-x64": { binary_sha256: "a".repeat(64) },
      "linux-x64": { binary_sha256: "b".repeat(64) },
    },
  };
  assert.deepEqual(resolveToolchainContract(toolchain, { platform: "win32", arch: "x64" }), {
    ecosystem: "go",
    version: "go1.27.0",
    platform: "win32-x64",
    binary_sha256: "a".repeat(64),
  });
  assert.deepEqual(resolveToolchainContract(toolchain, { platform: "linux", arch: "x64" }), {
    ecosystem: "go",
    version: "go1.27.0",
    platform: "linux-x64",
    binary_sha256: "b".repeat(64),
  });
  assert.throws(
    () => resolveToolchainContract(toolchain, { platform: "darwin", arch: "arm64" }),
    /does not support darwin-arm64/i,
  );
});
