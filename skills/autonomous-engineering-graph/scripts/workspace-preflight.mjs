import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, realpath, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const DEPENDENCY_INSTALL_POLICY = "sandbox-deferred-or-explicit-host-v2";
const LOCKFILE_CANDIDATES = [
  { file: "npm-shrinkwrap.json", manager: "npm" },
  { file: "package-lock.json", manager: "npm" },
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "bun.lock", manager: "bun" },
  { file: "bun.lockb", manager: "bun" },
];
const SUPPORTED_PACKAGE_MANAGERS = new Set(LOCKFILE_CANDIDATES.map((candidate) => candidate.manager));
const DEFAULT_PREFLIGHT_ENV_KEYS = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "USERNAME",
  "LANG",
  "LC_ALL",
  "TERM",
  "NO_COLOR",
  "COREPACK_HOME",
  "PLAYWRIGHT_BROWSERS_PATH",
  "AEG_AUTO_PREPARE_BROWSERS",
  "AEG_PLAYWRIGHT_BROWSERS",
  "AEG_ALLOW_HOST_DEPENDENCY_PREPARE",
  "AEG_ALLOW_HOST_BROWSER_PREPARE",
]);

export function preflightEnvironment(source = process.env) {
  const requested = String(source.AEG_PREFLIGHT_ENV_KEYS || "")
    .split(/[;,\s]+/)
    .map((key) => key.trim())
    .filter((key) => /^[A-Za-z_][A-Za-z0-9_()]*$/.test(key));
  const allowed = new Set([...DEFAULT_PREFLIGHT_ENV_KEYS, ...requested.map((key) => key.toUpperCase())]);
  const environment = { NO_COLOR: "1" };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (allowed.has(key.toUpperCase()) || /^LC_/i.test(key)) environment[key] = value;
  }
  return environment;
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function pathEntries(env = process.env) {
  return String(env.PATH || env.Path || "")
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

async function findCommand(names, workspace, env = process.env) {
  const candidates = process.platform === "win32"
    ? names.flatMap((name) => (path.extname(name) ? [name] : [`${name}.cmd`, `${name}.exe`, name]))
    : names;
  const workspaceRoot = path.resolve(workspace);
  const insideWorkspace = (target) => {
    const relative = path.relative(workspaceRoot, path.resolve(target));
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  const trustedDirectories = [];
  for (const rawDirectory of pathEntries(env)) {
    // Relative PATH entries resolve against the child cwd, which is the
    // repository snapshot. Reject them instead of allowing `.` to select a
    // repository-local shim.
    if (!path.isAbsolute(rawDirectory)) continue;
    const directory = path.resolve(rawDirectory);
    if (insideWorkspace(directory)) continue;
    const realDirectory = await realpath(directory).catch(() => directory);
    if (insideWorkspace(realDirectory)) continue;
    trustedDirectories.push(directory);
  }
  // Package managers are host tools. A repository-local npm.cmd/pnpm script
  // must never be selected as a pre-model executable merely because it shares
  // the package manager's name or appears later in PATH.
  for (const directory of trustedDirectories) {
    for (const name of candidates) {
      const candidate = path.resolve(directory, name);
      if (!(await exists(candidate))) continue;
      const realCandidate = await realpath(candidate).catch(() => candidate);
      if (!insideWorkspace(realCandidate)) return candidate;
    }
  }
  return null;
}

function appendBounded(current, chunk) {
  const combined = Buffer.concat([current, Buffer.from(chunk)]);
  return combined.length <= MAX_CAPTURE_BYTES ? combined : combined.subarray(combined.length - MAX_CAPTURE_BYTES);
}

function quoteCmdArgument(value) {
  const text = String(value);
  if (!/[\s"&|<>^()]/.test(text)) return text;
  return `"${text.replace(/(["^&|<>])/g, "^$1")}"`;
}

function portableInvocation(command, args) {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command)) return { command, args };
  const comspec = process.env.ComSpec || path.join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "cmd.exe");
  const commandLine = [command, ...args].map(quoteCmdArgument).join(" ");
  return { command: comspec, args: ["/d", "/s", "/c", commandLine] };
}

function terminateProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    const taskkill = path.join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "taskkill.exe");
    spawnSync(taskkill, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, encoding: "utf8" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The preparation process already exited.
    }
  }
}

async function runCommand(command, args, { workspace, timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
  const invocation = portableInvocation(command, args);
  const startedAt = Date.now();
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let timedOut = false;
  const child = spawn(invocation.command, invocation.args, {
    cwd: workspace,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  child.stdout.on("data", (chunk) => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = appendBounded(stderr, chunk);
  });
  const timer = setTimeout(() => {
    timedOut = true;
    terminateProcessTree(child);
  }, timeoutMs);
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  return {
    command,
    args,
    exit_code: exit.code,
    signal: exit.signal,
    timed_out: timedOut,
    duration_ms: Date.now() - startedAt,
    stdout: stdout.toString("utf8"),
    stderr: stderr.toString("utf8"),
  };
}

async function fileFingerprint(target) {
  const contents = await readFile(target);
  return createHash("sha256").update(contents).digest("hex");
}

function dependencyCount(manifest) {
  return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
    .reduce((count, key) => count + Object.keys(manifest?.[key] || {}).length, 0);
}

function declaredBrowserTool(manifest) {
  const dependencyNames = [
    ...Object.keys(manifest?.dependencies || {}),
    ...Object.keys(manifest?.devDependencies || {}),
    ...Object.keys(manifest?.optionalDependencies || {}),
    ...Object.keys(manifest?.peerDependencies || {}),
  ];
  const scripts = Object.values(manifest?.scripts || {}).join("\n");
  if (dependencyNames.some((name) => ["playwright", "@playwright/test"].includes(name)) || /\bplaywright\b/i.test(scripts)) {
    return "playwright";
  }
  if (dependencyNames.includes("puppeteer") || /\bpuppeteer\b/i.test(scripts)) return "puppeteer";
  if (dependencyNames.includes("agent-browser") || /\bagent-browser\b/i.test(scripts)) return "agent-browser";
  return null;
}

function browserNames(env = process.env) {
  const requested = String(env.AEG_PLAYWRIGHT_BROWSERS || "chromium")
    .split(/[\s,]+/)
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const allowed = new Set(["chromium", "firefox", "webkit"]);
  const names = [...new Set(requested.filter((name) => allowed.has(name)))];
  return names.length ? names : ["chromium"];
}

async function browserPreparationPlan(workspace, manifest, env = process.env, { requested = false } = {}) {
  if (declaredBrowserTool(manifest) !== "playwright") return null;
  const executable = path.join(
    workspace,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "playwright.cmd" : "playwright",
  );
  const browsers = browserNames(env);
  const setting = String(env.AEG_AUTO_PREPARE_BROWSERS || "auto").trim().toLowerCase();
  const disabled = ["0", "false", "off", "no"].includes(setting);
  const explicitlyEnabled = ["1", "true", "on", "yes"].includes(setting);
  const enabled = !disabled && (requested || explicitlyEnabled);
  return {
    kind: "browser",
    tool: "playwright",
    action: enabled ? "install" : (disabled ? "disabled" : "deferred"),
    browsers,
    command: executable,
    args: ["install", ...browsers],
    available: await exists(executable),
    reason: enabled
      ? "The run requires browser evidence; Graph can prepare the selected local browser revisions in the isolated execution workspace."
      : disabled
        ? "Automatic browser preparation was disabled by AEG_AUTO_PREPARE_BROWSERS."
        : "Playwright is declared by the project, but no browser check has been selected yet; preparation is deferred until the normalized plan requires it.",
  };
}

function enabledSetting(value) {
  return ["1", "true", "on", "yes"].includes(String(value || "").trim().toLowerCase());
}

function packageManagerDeclaration(manifest = {}) {
  const raw = String(manifest.packageManager || "").trim();
  if (!raw) return null;
  const match = raw.match(/^([^@\s]+)(?:@[^\s]+)?$/);
  const manager = match?.[1]?.toLowerCase() || null;
  if (!manager || !SUPPORTED_PACKAGE_MANAGERS.has(manager)) {
    const error = new Error(
      `package.json packageManager must name one of ${[...SUPPORTED_PACKAGE_MANAGERS].join(", ")}; received ${JSON.stringify(raw)}`,
    );
    error.code = "DEPENDENCY_MANAGER_UNSUPPORTED";
    throw error;
  }
  return { manager, raw };
}

async function selectNodeLockfile(workspace, manifest = {}) {
  const present = [];
  for (const candidate of LOCKFILE_CANDIDATES) {
    const target = path.join(workspace, candidate.file);
    if (await exists(target)) present.push({ ...candidate, target });
  }
  const declaration = packageManagerDeclaration(manifest);
  if (declaration) {
    const matching = present.filter((candidate) => candidate.manager === declaration.manager);
    if (matching.length) return { ...matching[0], package_manager: declaration.raw };
    if (present.length) {
      const error = new Error(
        `package.json declares ${declaration.raw}, but the available lockfiles belong to ${[
          ...new Set(present.map((candidate) => candidate.manager)),
        ].join(", ")}: ${present.map((candidate) => candidate.file).join(", ")}`,
      );
      error.code = "DEPENDENCY_LOCK_MISMATCH";
      throw error;
    }
    return null;
  }
  const managers = [...new Set(present.map((candidate) => candidate.manager))];
  if (managers.length > 1) {
    const error = new Error(
      `Multiple package-manager lockfiles are present (${present.map((candidate) => candidate.file).join(", ")}); ` +
        "set package.json packageManager or remove stale lockfiles before Graph prepares dependencies",
    );
    error.code = "DEPENDENCY_LOCK_AMBIGUOUS";
    throw error;
  }
  return present[0] || null;
}

async function nodePreparationPlan(workspace, env = process.env, { requiredEnvironmentKinds = [] } = {}) {
  const packagePath = path.join(workspace, "package.json");
  if (!(await exists(packagePath))) return null;
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  const dependencies = dependencyCount(manifest);
  const selected = await selectNodeLockfile(workspace, manifest);
  const packageHash = await fileFingerprint(packagePath);
  const browser = await browserPreparationPlan(workspace, manifest, env, {
    requested: requiredEnvironmentKinds.includes("browser"),
  });
  const browserFingerprint = browser
    ? { tool: browser.tool, action: browser.action, browsers: browser.browsers, command: browser.command }
    : null;
  if (dependencies === 0 && !selected) {
    const dependencyFingerprint = createHash("sha256").update(`${packageHash}:node:none`).digest("hex");
    return {
      ecosystem: "node",
      action: "none",
      reason: "package.json declares no external dependencies",
      dependency_fingerprint: dependencyFingerprint,
      fingerprint: createHash("sha256").update(`${dependencyFingerprint}:${JSON.stringify(browserFingerprint)}`).digest("hex"),
      browser,
    };
  }
  if (!selected) {
    const error = new Error("package.json declares dependencies but no supported lockfile is present");
    error.code = "DEPENDENCY_LOCK_MISSING";
    throw error;
  }
  const lockHash = await fileFingerprint(selected.target);
  const managerVersion = String(manifest.packageManager || "");
  let args;
  if (selected.manager === "npm") args = ["ci", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"];
  else if (selected.manager === "pnpm") args = ["install", "--frozen-lockfile", "--ignore-scripts", "--prefer-offline"];
  else if (selected.manager === "yarn") {
    args = /yarn@(0|1)\./i.test(managerVersion) || (!managerVersion && !(await exists(path.join(workspace, ".yarnrc.yml"))))
      ? ["install", "--frozen-lockfile", "--ignore-scripts"]
      : ["install", "--immutable", "--mode=skip-builds"];
  } else args = ["install", "--frozen-lockfile", "--ignore-scripts"];
  const dependencyFingerprint = createHash("sha256")
    .update(`${packageHash}:${lockHash}:${selected.manager}:${selected.package_manager || "undeclared"}:${DEPENDENCY_INSTALL_POLICY}`)
    .digest("hex");
  return {
    ecosystem: "node",
    action: "install",
    manager: selected.manager,
    lockfile: selected.file,
    package_manager: selected.package_manager || null,
    args,
    lifecycle_scripts: "disabled",
    dependency_fingerprint: dependencyFingerprint,
    fingerprint: createHash("sha256").update(`${dependencyFingerprint}:${JSON.stringify(browserFingerprint)}`).digest("hex"),
    browser,
  };
}

const ECOSYSTEM_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".venv",
  "venv",
  "target",
  "bin",
  "obj",
  "build",
  "dist",
  "out",
  ".gradle",
]);

function posixRelative(root, target) {
  return path.relative(root, target).split(path.sep).join("/") || ".";
}

async function projectDirectories(root, maxDepth = 3) {
  const resolved = path.resolve(root);
  const output = [resolved];
  async function visit(directory, depth) {
    if (depth >= maxDepth) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || ECOSYSTEM_EXCLUDED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) continue;
      const child = path.join(directory, entry.name);
      output.push(child);
      await visit(child, depth + 1);
    }
  }
  await visit(resolved, 0);
  return [...new Set(output)].sort();
}

async function presentFiles(directory, names) {
  const present = [];
  for (const name of names) {
    if (await exists(path.join(directory, name))) present.push(name);
  }
  return present;
}

function pinnedRequirements(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  return lines.length > 0 && lines.every((line) => /^[A-Za-z0-9_.-]+(?:\[[^\]]+\])?\s*===?\s*[^\s]+(?:\s+--hash=[^\s]+)*$/.test(line));
}

function adapterPlan({ ecosystem, directory, manifests, locks, manager, args, status = "ready", reason = null }) {
  return {
    ecosystem,
    project_root: directory,
    project_relative: ".",
    manifest_files: manifests,
    lockfiles: locks,
    trusted_lock: status === "ready",
    manager: manager || null,
    action: status === "ready" ? "install" : "environment_gap",
    args: args || [],
    lifecycle_scripts: "disabled-by-default",
    status,
    reason,
  };
}

async function planPythonProject(directory) {
  const manifests = await presentFiles(directory, ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"]);
  if (!manifests.length) return null;
  const lockCandidates = [];
  if (await exists(path.join(directory, "uv.lock")) && manifests.includes("pyproject.toml")) {
    lockCandidates.push({ manager: "uv", locks: ["pyproject.toml", "uv.lock"], args: ["sync", "--frozen"] });
  }
  if (await exists(path.join(directory, "poetry.lock")) && manifests.includes("pyproject.toml")) {
    lockCandidates.push({ manager: "poetry", locks: ["pyproject.toml", "poetry.lock"], args: ["install", "--no-interaction", "--no-ansi"] });
  }
  if (await exists(path.join(directory, "Pipfile.lock")) && manifests.includes("Pipfile")) {
    lockCandidates.push({ manager: "pipenv", locks: ["Pipfile", "Pipfile.lock"], args: ["sync"] });
  }
  if (manifests.includes("requirements.txt")) {
    const requirements = await readFile(path.join(directory, "requirements.txt"), "utf8");
    if (pinnedRequirements(requirements)) {
      lockCandidates.push({ manager: "python", locks: ["requirements.txt"], args: ["-m", "pip", "install", "--requirement", "requirements.txt"] });
    }
  }
  if (lockCandidates.length > 1) {
    return adapterPlan({
      ecosystem: "python",
      directory,
      manifests,
      locks: lockCandidates.flatMap((candidate) => candidate.locks),
      status: "ambiguous",
      reason: "Multiple Python dependency lock strategies are present; choose one explicitly before preparation.",
    });
  }
  const selected = lockCandidates[0];
  return adapterPlan({
    ecosystem: "python",
    directory,
    manifests,
    locks: selected?.locks || [],
    manager: selected?.manager,
    args: selected?.args,
    status: selected ? "ready" : "missing-lock",
    reason: selected ? null : "Python project detected without one trusted lock input (uv.lock, poetry.lock, Pipfile.lock, or fully pinned requirements.txt).",
  });
}

async function planGoProject(directory) {
  if (!(await exists(path.join(directory, "go.mod")))) return null;
  const hasSum = await exists(path.join(directory, "go.sum"));
  return adapterPlan({
    ecosystem: "go",
    directory,
    manifests: ["go.mod"],
    locks: hasSum ? ["go.sum"] : [],
    manager: "go",
    args: ["mod", "download"],
    status: hasSum ? "ready" : "missing-lock",
    reason: hasSum ? null : "Go project detected without go.sum; Graph will not guess a dependency restore mode.",
  });
}

async function planRustProject(directory) {
  if (!(await exists(path.join(directory, "Cargo.toml")))) return null;
  const hasLock = await exists(path.join(directory, "Cargo.lock"));
  return adapterPlan({
    ecosystem: "rust",
    directory,
    manifests: ["Cargo.toml"],
    locks: hasLock ? ["Cargo.lock"] : [],
    manager: "cargo",
    args: ["fetch", "--locked"],
    status: hasLock ? "ready" : "missing-lock",
    reason: hasLock ? null : "Rust project detected without Cargo.lock; Graph will not guess a dependency restore mode.",
  });
}

async function planJavaProject(directory) {
  const maven = await exists(path.join(directory, "pom.xml"));
  const gradle = (await exists(path.join(directory, "build.gradle"))) || (await exists(path.join(directory, "build.gradle.kts")));
  if (!maven && !gradle) return null;
  if (maven && gradle) {
    return adapterPlan({
      ecosystem: "java",
      directory,
      manifests: ["pom.xml", "build.gradle", "build.gradle.kts"].filter((name, index, values) => values.indexOf(name) === index),
      status: "ambiguous",
      reason: "Both Maven and Gradle project manifests are present; Graph will not choose a Java build tool.",
    });
  }
  if (maven) {
    const wrapper = await exists(path.join(directory, "mvnw")) || await exists(path.join(directory, "mvnw.cmd"));
    const wrapperLock = await exists(path.join(directory, ".mvn", "wrapper", "maven-wrapper.properties"));
    return adapterPlan({
      ecosystem: "java",
      directory,
      manifests: ["pom.xml"],
      locks: wrapper && wrapperLock ? [".mvn/wrapper/maven-wrapper.properties"] : [],
      manager: "maven-wrapper",
      args: ["-B", "-ntp", "dependency:go-offline"],
      status: wrapper && wrapperLock ? "ready" : "missing-lock",
      reason: wrapper && wrapperLock ? null : "Maven project requires a checked-in Maven wrapper and wrapper properties before preparation.",
    });
  }
  const wrapper = await exists(path.join(directory, "gradlew")) || await exists(path.join(directory, "gradlew.bat"));
  const wrapperLock = await exists(path.join(directory, "gradle", "wrapper", "gradle-wrapper.properties"));
  const dependencyLock = await exists(path.join(directory, "gradle.lockfile"));
  return adapterPlan({
    ecosystem: "java",
    directory,
    manifests: [await exists(path.join(directory, "build.gradle")) ? "build.gradle" : "build.gradle.kts"],
    locks: wrapper && wrapperLock && dependencyLock ? ["gradle/wrapper/gradle-wrapper.properties", "gradle.lockfile"] : [],
    manager: "gradle-wrapper",
    args: ["--no-daemon", "--offline", "dependencies"],
    status: wrapper && wrapperLock && dependencyLock ? "ready" : "missing-lock",
    reason: wrapper && wrapperLock && dependencyLock ? null : "Gradle project requires a checked-in wrapper and dependency lockfile before preparation.",
  });
}

async function planDotnetProject(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const manifests = entries.filter((entry) => entry.isFile() && /\.(?:sln|csproj|fsproj|vbproj)$/i.test(entry.name)).map((entry) => entry.name);
  if (!manifests.length) return null;
  const lock = await exists(path.join(directory, "packages.lock.json"));
  return adapterPlan({
    ecosystem: "dotnet",
    directory,
    manifests,
    locks: lock ? ["packages.lock.json"] : [],
    manager: "dotnet",
    args: ["restore", "--locked-mode"],
    status: lock ? "ready" : "missing-lock",
    reason: lock ? null : ".NET project detected without packages.lock.json; Graph will not guess restore inputs.",
  });
}

async function fingerprintAdapterPlan(plan) {
  const files = [...plan.manifest_files, ...plan.lockfiles];
  const hashes = [];
  for (const relative of files) {
    const target = path.join(plan.project_root, ...relative.split("/"));
    hashes.push(`${relative}:${await fileFingerprint(target)}`);
  }
  return createHash("sha256")
    .update(`${plan.ecosystem}:${plan.status}:${DEPENDENCY_INSTALL_POLICY}:${hashes.sort().join("|")}`)
    .digest("hex");
}

async function prepareAdapterPlan(plan) {
  return {
    kind: "dependencies",
    ecosystem: plan.ecosystem,
    manager: plan.manager,
    action: plan.action,
    args: plan.args,
    lockfiles: plan.lockfiles,
    status: plan.status === "ready" ? "deferred" : "environment_gap",
    host_execution_authorized: false,
    reason: plan.status === "ready"
      ? "Dependency preparation for this ecosystem is deferred to an isolated node sandbox; Graph does not execute project code on the host."
      : plan.reason,
  };
}

const ECOSYSTEM_ADAPTERS = [
  { ecosystem: "python", detect: planPythonProject, plan: planPythonProject, fingerprint: fingerprintAdapterPlan, prepare: prepareAdapterPlan },
  { ecosystem: "go", detect: planGoProject, plan: planGoProject, fingerprint: fingerprintAdapterPlan, prepare: prepareAdapterPlan },
  { ecosystem: "rust", detect: planRustProject, plan: planRustProject, fingerprint: fingerprintAdapterPlan, prepare: prepareAdapterPlan },
  { ecosystem: "java", detect: planJavaProject, plan: planJavaProject, fingerprint: fingerprintAdapterPlan, prepare: prepareAdapterPlan },
  { ecosystem: "dotnet", detect: planDotnetProject, plan: planDotnetProject, fingerprint: fingerprintAdapterPlan, prepare: prepareAdapterPlan },
];

async function detectEcosystemPlans(workspace, repositoryRoot = workspace) {
  const roots = [...new Set([path.resolve(repositoryRoot), path.resolve(workspace)])];
  const directories = [...new Set((await Promise.all(roots.map((root) => projectDirectories(root))).then((groups) => groups.flat())))]
    .sort((left, right) => left.length - right.length || left.localeCompare(right));
  const plans = [];
  for (const directory of directories) {
    for (const adapter of ECOSYSTEM_ADAPTERS) {
      const detected = await adapter.detect(directory);
      if (!detected) continue;
      const plan = await adapter.plan(directory);
      plan.project_relative = posixRelative(path.resolve(repositoryRoot), directory);
      plan.fingerprint = await adapter.fingerprint(plan);
      plans.push({ ...plan, adapter: adapter.ecosystem });
    }
  }
  return plans;
}

function multiEcosystemRecord({ workspace, plans, preparations = [], commands = [] }) {
  const gaps = plans.filter((plan) => plan.status !== "ready").map((plan) => ({
    kind: "dependencies",
    ecosystem: plan.ecosystem,
    project_root: plan.project_root,
    status: plan.status,
    reason: plan.reason,
  }));
  const dependencyFingerprint = createHash("sha256").update(plans.map((plan) => plan.fingerprint).sort().join("|")).digest("hex");
  return {
    version: 3,
    status: "pass",
    workspace: path.resolve(workspace),
    checked_at: new Date().toISOString(),
    dependency_fingerprint: dependencyFingerprint,
    fingerprint: createHash("sha256").update(`${dependencyFingerprint}:${JSON.stringify(plans)}`).digest("hex"),
    cache_reused: false,
    host: `${os.platform()}-${os.arch()}`,
    plans,
    commands,
    preparations,
    preparation_gaps: gaps,
    environment_gaps: gaps,
  };
}

function dependencyPreparationEnvironment(env) {
  return {
    ...env,
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    YARN_ENABLE_SCRIPTS: "false",
  };
}

async function commandForPlan(plan, workspace, env) {
  const direct = await findCommand([plan.manager], workspace, env);
  if (direct) return { command: direct, args: plan.args };
  if (["pnpm", "yarn"].includes(plan.manager)) {
    const corepack = await findCommand(["corepack"], workspace, env);
    if (corepack) return { command: corepack, args: [plan.manager, ...plan.args] };
  }
  const error = new Error(`${plan.manager} is required by ${plan.lockfile} but was not found on PATH`);
  error.code = "DEPENDENCY_TOOL_MISSING";
  throw error;
}

async function prepareBrowser(browser, workspace, timeoutMs, env, { allowHostExecution = false } = {}) {
  if (!browser) return { status: "not_applicable" };
  if (browser.action === "disabled") {
    return { ...browser, status: "disabled", reason: browser.reason };
  }
  if (browser.action === "deferred") {
    return { ...browser, status: "deferred", reason: browser.reason };
  }
  if (!allowHostExecution) {
    return {
      ...browser,
      status: "deferred",
      host_execution_authorized: false,
      reason:
        "Graph did not execute the project-local Playwright CLI with host privileges. " +
        "Install the requested browser revisions inside an implementation or verification node sandbox, " +
        "or explicitly set AEG_ALLOW_HOST_BROWSER_PREPARE=1 for a trusted repository.",
    };
  }
  const executable = await exists(browser.command) ? browser.command : null;
  if (!executable) {
    return {
      ...browser,
      status: "unavailable",
      reason: "The project declares Playwright, but its local CLI is unavailable after dependency preparation; verification will report the browser environment gap.",
    };
  }
  const result = await runCommand(executable, browser.args, {
    workspace,
    timeoutMs,
    env: { ...env, PLAYWRIGHT_BROWSERS_PATH: env.PLAYWRIGHT_BROWSERS_PATH || "0" },
  });
  return {
    ...browser,
    host_execution_authorized: true,
    status: result.exit_code === 0 && !result.timed_out ? "pass" : "fail",
    command_result: result,
  };
}

function sameBrowserSpec(left, right) {
  if (!left || !right) return left === right;
  return left.tool === right.tool &&
    left.action === right.action &&
    left.command === right.command &&
    JSON.stringify(left.browsers || []) === JSON.stringify(right.browsers || []);
}

function browserPreparationMatches(preparations, browser, { allowHostExecution = false } = {}) {
  const candidates = (preparations || []).filter((preparation) => preparation?.kind === "browser");
  if (!browser) return candidates.length === 0;
  const preparation = candidates.find((candidate) => sameBrowserSpec(candidate, browser));
  if (!preparation) return false;
  if (browser.action === "disabled") return preparation.status === "disabled";
  if (browser.action === "deferred") return preparation.status === "deferred";
  return allowHostExecution ? preparation.status === "pass" : preparation.status === "deferred";
}

function preparationRecord({ plan, workspace, commands, preparations, cacheReused = false }) {
  const browserGaps = (preparations || []).filter((item) => ["fail", "unavailable"].includes(item.status));
  return {
    version: 2,
    status: "pass",
    workspace,
    checked_at: new Date().toISOString(),
    dependency_fingerprint: plan.dependency_fingerprint || null,
    fingerprint: plan.fingerprint,
    cache_reused: cacheReused,
    host: `${os.platform()}-${os.arch()}`,
    plans: [plan],
    commands,
    preparations,
    preparation_gaps: browserGaps.map((item) => ({
      kind: item.kind || "tool",
      tool: item.tool || null,
      status: item.status,
      reason: item.reason || "tool preparation was unavailable",
    })),
  };
}

async function prepareNodeExecutionWorkspace({
  workspace,
  isolated = true,
  previous = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = preflightEnvironment(process.env),
  requiredEnvironmentKinds = [],
  allowHostDependencyPreparation = enabledSetting(env.AEG_ALLOW_HOST_DEPENDENCY_PREPARE),
  allowHostBrowserPreparation = enabledSetting(env.AEG_ALLOW_HOST_BROWSER_PREPARE),
} = {}) {
  const resolved = path.resolve(workspace);
  const plan = await nodePreparationPlan(resolved, env, { requiredEnvironmentKinds });
  if (!plan) {
    return { version: 1, status: "not_applicable", workspace: resolved, checked_at: new Date().toISOString(), plans: [] };
  }
  const browserPreparation = async ({ allowHostExecution = allowHostBrowserPreparation } = {}) => {
    const preparation = await prepareBrowser(plan.browser, resolved, timeoutMs, env, {
      allowHostExecution,
    });
    return {
      preparation,
      commands: preparation.command_result ? [preparation.command_result] : [],
    };
  };
  const currentHost = `${os.platform()}-${os.arch()}`;
  const dependencyCacheMatches = previous?.status === "pass" &&
    previous?.host === currentHost &&
    previous?.dependency_fingerprint === plan.dependency_fingerprint;
  if (dependencyCacheMatches) {
    const dependencyDirectory = path.join(resolved, "node_modules");
    const previousPreparations = Array.isArray(previous.preparations) ? previous.preparations : [];
    const dependenciesReady = plan.action === "none" || (await exists(dependencyDirectory));
    const dependenciesReusable = dependenciesReady && (!isolated || plan.action === "none");
    const browserMatches = previous.fingerprint === plan.fingerprint && browserPreparationMatches(
      previousPreparations,
      plan.browser,
      { allowHostExecution: allowHostBrowserPreparation },
    );
    if (dependenciesReusable && browserMatches) {
      return { ...previous, reused_at: new Date().toISOString(), cache_reused: true };
    }
    if (dependenciesReusable) {
      const browser = await browserPreparation();
      return preparationRecord({
        plan,
        workspace: resolved,
        commands: [...(previous.commands || []), ...browser.commands],
        preparations: [browser.preparation],
        cacheReused: true,
      });
    }
  }
  if (plan.action === "none") {
    const browser = await browserPreparation();
    return preparationRecord({
      plan,
      workspace: resolved,
      commands: browser.commands,
      preparations: browser.preparation.status === "not_applicable" ? [] : [browser.preparation],
    });
  }
  if (!isolated && (await exists(path.join(resolved, "node_modules")))) {
    const browser = await browserPreparation();
    return preparationRecord({
      plan: { ...plan, action: "reuse_existing" },
      workspace: resolved,
      commands: browser.commands,
      preparations: browser.preparation.status === "not_applicable" ? [] : [browser.preparation],
      cacheReused: true,
    });
  }
  if (!allowHostDependencyPreparation) {
    if (isolated) await rm(path.join(resolved, "node_modules"), { recursive: true, force: true });
    const browser = await browserPreparation({ allowHostExecution: false });
    return {
      ...preparationRecord({
      plan,
      workspace: resolved,
      commands: browser.commands,
      preparations: [
        {
          kind: "dependencies",
          ecosystem: plan.ecosystem,
          manager: plan.manager,
          lockfile: plan.lockfile,
          action: plan.action,
          args: plan.args,
          lifecycle_scripts: plan.lifecycle_scripts,
          status: "deferred",
          host_execution_authorized: false,
          reason:
            "Graph did not execute a repository-selected package manager with host privileges. " +
            "Restore locked dependencies inside an implementation or verification node sandbox, " +
            "or explicitly set AEG_ALLOW_HOST_DEPENDENCY_PREPARE=1 for a trusted repository.",
        },
        ...(browser.preparation.status === "not_applicable" ? [] : [browser.preparation]),
      ],
      }),
      dependency_directory_present: false,
    };
  }
  const invocation = await commandForPlan(plan, resolved, env);
  if (isolated) await rm(path.join(resolved, "node_modules"), { recursive: true, force: true });
  const result = await runCommand(invocation.command, invocation.args, {
    workspace: resolved,
    timeoutMs,
    env: dependencyPreparationEnvironment(env),
  });
  const record = {
    version: 2,
    status: result.exit_code === 0 && !result.timed_out ? "pass" : "fail",
    workspace: resolved,
    checked_at: new Date().toISOString(),
    dependency_fingerprint: plan.dependency_fingerprint || null,
    fingerprint: plan.fingerprint,
    cache_reused: false,
    host: `${os.platform()}-${os.arch()}`,
    plans: [plan],
    commands: [result],
  };
  if (record.status !== "pass") {
    const error = new Error(
      `Workspace dependency preparation failed before model execution: ${path.basename(invocation.command)} ${invocation.args.join(" ")} ` +
      `(exit=${result.exit_code}, timeout=${result.timed_out})`,
    );
    error.code = "WORKSPACE_PREPARATION_FAILED";
    error.preflight = record;
    throw error;
  }
  const browser = await browserPreparation();
  const dependencyDetails = await stat(path.join(resolved, "node_modules")).catch(() => null);
  return {
    ...record,
    preparations: browser.preparation.status === "not_applicable" ? [] : [browser.preparation],
    preparation_gaps: browser.preparation.status === "fail" || browser.preparation.status === "unavailable"
      ? [{ kind: browser.preparation.kind || "tool", tool: browser.preparation.tool || null, status: browser.preparation.status, reason: browser.preparation.reason }]
      : [],
    commands: [...record.commands, ...browser.commands],
    dependency_directory_present: Boolean(dependencyDetails?.isDirectory()),
  };
}

export async function prepareExecutionWorkspace({
  workspace,
  repositoryRoot = workspace,
  ...options
} = {}) {
  const resolved = path.resolve(workspace);
  const ecosystemPlans = await detectEcosystemPlans(resolved, repositoryRoot);
  const genericPlans = ecosystemPlans.filter((plan) => plan.ecosystem !== "node");
  const base = await prepareNodeExecutionWorkspace({ workspace: resolved, ...options });
  if (!genericPlans.length) return base;
  const genericPreparations = await Promise.all(genericPlans.map(async (plan) => {
    const adapter = ECOSYSTEM_ADAPTERS.find((candidate) => candidate.ecosystem === plan.ecosystem);
    return adapter.prepare(plan);
  }));
  const nodePlans = base.plans || [];
  if (base.status !== "not_applicable" || nodePlans.length) {
    const plans = [...nodePlans, ...genericPlans];
    const dependencyFingerprint = createHash("sha256").update(plans.map((plan) => plan.dependency_fingerprint || plan.fingerprint || "").sort().join("|")).digest("hex");
    return {
      ...base,
      version: 3,
      plans,
      preparations: [...(base.preparations || []), ...genericPreparations],
      preparation_gaps: [...(base.preparation_gaps || []), ...genericPlans.filter((plan) => plan.status !== "ready").map((plan) => ({
        kind: "dependencies",
        ecosystem: plan.ecosystem,
        project_root: plan.project_root,
        status: plan.status,
        reason: plan.reason,
      }))],
      environment_gaps: genericPlans.filter((plan) => plan.status !== "ready").map((plan) => ({
        ecosystem: plan.ecosystem,
        project_root: plan.project_root,
        status: plan.status,
        reason: plan.reason,
      })),
      dependency_fingerprint: dependencyFingerprint,
      fingerprint: createHash("sha256").update(`${dependencyFingerprint}:${JSON.stringify(plans)}`).digest("hex"),
    };
  }
  return multiEcosystemRecord({
    workspace: resolved,
    plans: genericPlans,
    preparations: genericPreparations,
  });
}

export const __test = {
  browserPreparationMatches,
  browserNames,
  browserPreparationPlan,
  declaredBrowserTool,
  enabledSetting,
  findCommand,
  nodePreparationPlan,
  packageManagerDeclaration,
  portableInvocation,
  preflightEnvironment,
  quoteCmdArgument,
  selectNodeLockfile,
  detectEcosystemPlans,
  planPythonProject,
  planGoProject,
  planRustProject,
  planJavaProject,
  planDotnetProject,
  ECOSYSTEM_ADAPTERS,
};
