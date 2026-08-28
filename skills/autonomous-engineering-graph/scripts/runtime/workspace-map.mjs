import { createHash } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const MODULE_MAP_VERSION = 1;
const MAX_PACKAGE_FILES = 256;
const MAX_RULE_FILES = 256;
const MAX_SCAN_DIRECTORIES = 4_000;
const MAX_SURFACE_ENTRIES = 50_000;
const MAX_CONTEXT_BYTES = 24_000;
const GRADLE_SETTINGS_NAMES = ["settings.gradle.kts", "settings.gradle"];
const GRADLE_BUILD_NAMES = ["build.gradle.kts", "build.gradle"];
const GRADLE_WRAPPER_NAMES = ["gradlew", "gradlew.bat"];
const GRADLE_WRAPPER_PROPERTIES = path.join("gradle", "wrapper", "gradle-wrapper.properties");
const NODE_LOCKFILE_NAMES = ["npm-shrinkwrap.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];
const RULE_FILE_NAMES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODEOWNERS",
]);
const ORIENTATION_SKIP_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".gradle",
  "build",
  "dist",
  "out",
  "coverage",
]);
const SOURCE_DIRECTORY_NAMES = ["src/main", "src/main/java", "src/main/kotlin", "src/main/resources"];
const TEST_DIRECTORY_NAMES = ["src/test", "src/test/java", "src/test/kotlin", "src/androidTest", "src/testFixtures"];

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

function relativePath(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (relative || ".").split(path.sep).join("/");
}

function sortStrings(values) {
  return [...new Set(values.filter(Boolean).map(String))].sort((left, right) => left.localeCompare(right));
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(stableObject(value))).digest("hex");
}

async function readText(target) {
  try {
    return await readFile(target, "utf8");
  } catch {
    return null;
  }
}

async function readJson(target) {
  const text = await readText(target);
  if (text === null) return { value: null, parse_error: null };
  try {
    return { value: JSON.parse(text), parse_error: null };
  } catch (error) {
    return { value: null, parse_error: error.message };
  }
}

function gradleProjectRelativePath(projectPath) {
  if (projectPath === ":" || !projectPath) return ".";
  return projectPath
    .replace(/^:/, "")
    .split(":")
    .filter(Boolean)
    .join("/");
}

function parseQuotedValues(text) {
  return [...String(text || "").matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

function parseGradleSettings(text) {
  const projects = new Set();
  const projectDirectories = {};
  const source = String(text || "");
  for (const match of source.matchAll(/\binclude\s*\(([^)]*)\)/g)) {
    for (const value of parseQuotedValues(match[1])) {
      if (value.startsWith(":")) projects.add(value);
    }
  }
  for (const match of source.matchAll(/\binclude\s+((?:['"][^'"]+['"]\s*,?\s*)+)/g)) {
    for (const value of parseQuotedValues(match[1])) {
      if (value.startsWith(":")) projects.add(value);
    }
  }
  for (const match of source.matchAll(/project\s*\(\s*['"](:[^'"]+)['"]\s*\)\s*\.projectDir\s*=\s*file\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    projects.add(match[1]);
    projectDirectories[match[1]] = match[2].split("\\").join("/");
  }
  return {
    projects: [...projects].sort((left, right) => left.localeCompare(right)),
    project_directories: Object.fromEntries(Object.keys(projectDirectories).sort().map((key) => [key, projectDirectories[key]])),
  };
}

function parseGradleTasks(text) {
  const tasks = new Set();
  const source = String(text || "");
  const patterns = [
    /\btasks?\s*\.\s*(?:register|create|named)\s*(?:<[^>]+>)?\s*\(\s*["']([A-Za-z0-9_.:-]+)["']/g,
    /\btask\s+([A-Za-z][A-Za-z0-9_.:-]*)\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) tasks.add(match[1]);
  }
  return [...tasks].sort((left, right) => left.localeCompare(right));
}

function hasAndroidPlugin(text) {
  return /com\.android\.(?:application|library|test|dynamic-feature)|com\.android\.tools\.build\.gradle/i.test(String(text || ""));
}

async function conventionalDirectories(root, names) {
  const found = [];
  for (const name of names) {
    if (await isDirectory(path.join(root, ...name.split("/")))) found.push(name);
  }
  return found;
}

async function buildGradleModule({ gradleRoot, projectPath, relativeDirectory, declared = true, root = false }) {
  const directory = path.resolve(gradleRoot, relativeDirectory);
  const directoryExists = await isDirectory(directory);
  const buildFiles = directoryExists
    ? (await Promise.all(GRADLE_BUILD_NAMES.map(async (name) => (await exists(path.join(directory, name)) ? name : null)))).filter(Boolean)
    : [];
  const buildTexts = await Promise.all(buildFiles.map((name) => readText(path.join(directory, name))));
  const buildText = buildTexts.filter(Boolean).join("\n");
  const android = hasAndroidPlugin(buildText);
  const sourceDirs = directoryExists ? await conventionalDirectories(directory, SOURCE_DIRECTORY_NAMES) : [];
  const testDirs = directoryExists ? await conventionalDirectories(directory, TEST_DIRECTORY_NAMES) : [];
  const manifestPath = "src/main/AndroidManifest.xml";
  const manifestExists = directoryExists && await exists(path.join(directory, ...manifestPath.split("/")));
  const missing = [];
  if (!directoryExists) missing.push("module_directory");
  else if (!buildFiles.length) missing.push("build_file");
  if (android && !manifestExists) missing.push("android_manifest");
  const status = !directoryExists ? "missing" : missing.length ? "gap" : "ready";
  return {
    project_path: projectPath,
    path: relativeDirectory || ".",
    declared,
    root,
    exists: directoryExists,
    build_files: buildFiles,
    android_plugin: android,
    source_dirs: sourceDirs,
    test_dirs: testDirs,
    manifest: { path: manifestPath, expected: android, exists: manifestExists },
    declared_tasks: parseGradleTasks(buildText),
    missing,
    status,
  };
}

async function findGradleRoot(workspace, repositoryRoot = workspace) {
  const resolvedWorkspace = path.resolve(workspace);
  const resolvedRepositoryRoot = path.resolve(repositoryRoot || workspace);
  const candidates = [];
  let current = resolvedWorkspace;
  while (true) {
    candidates.push(current);
    if (current === resolvedRepositoryRoot || current === path.dirname(current)) break;
    const parent = path.dirname(current);
    if (path.relative(resolvedRepositoryRoot, parent).startsWith("..")) break;
    current = parent;
  }
  candidates.push(resolvedRepositoryRoot);
  for (const candidate of [...new Set(candidates)]) {
    const settings = [];
    for (const name of GRADLE_SETTINGS_NAMES) {
      if (await exists(path.join(candidate, name))) settings.push(name);
    }
    if (settings.length) return { root: candidate, settings };
  }
  return null;
}

async function buildGradleMap(workspace, repositoryRoot = workspace) {
  const found = await findGradleRoot(workspace, repositoryRoot);
  if (!found) {
    return {
      detected: false,
      project_root: null,
      settings_files: [],
      wrapper: { path: null, exists: false, candidates: [] },
      wrapper_properties: { path: GRADLE_WRAPPER_PROPERTIES, exists: false },
      root_project: null,
      modules: [],
      missing_modules: [],
      declared_tasks: [],
    };
  }
  const settingsTexts = await Promise.all(found.settings.map((name) => readText(path.join(found.root, name))));
  const parsed = parseGradleSettings(settingsTexts.filter(Boolean).join("\n"));
  const rootProject = await buildGradleModule({
    gradleRoot: found.root,
    projectPath: ":",
    relativeDirectory: ".",
    declared: false,
    root: true,
  });
  const modules = [];
  for (const projectPath of parsed.projects) {
    const configuredPath = parsed.project_directories[projectPath];
    const relativeDirectory = configuredPath || gradleProjectRelativePath(projectPath);
    modules.push(await buildGradleModule({
      gradleRoot: found.root,
      projectPath,
      relativeDirectory,
      declared: true,
    }));
  }
  const wrapperCandidates = [];
  for (const name of GRADLE_WRAPPER_NAMES) {
    if (await exists(path.join(found.root, name))) wrapperCandidates.push(name);
  }
  const allModules = [rootProject, ...modules].sort((left, right) => left.path.localeCompare(right.path));
  const missingModules = modules
    .filter((module) => module.status !== "ready")
    .map((module) => ({
      project_path: module.project_path,
      path: module.path,
      missing: module.missing,
      status: module.status,
    }));
  const declaredTasks = allModules.flatMap((module) => module.declared_tasks.map((task) => ({
    project_path: module.project_path,
    path: module.path,
    task,
  }))).sort((left, right) => `${left.project_path}:${left.task}`.localeCompare(`${right.project_path}:${right.task}`));
  return {
    detected: true,
    project_root: relativePath(workspace, found.root),
    settings_files: found.settings,
    wrapper: {
      path: wrapperCandidates[0] ? relativePath(workspace, path.join(found.root, wrapperCandidates[0])) : null,
      exists: wrapperCandidates.length > 0,
      candidates: wrapperCandidates,
    },
    wrapper_properties: {
      path: relativePath(workspace, path.join(found.root, GRADLE_WRAPPER_PROPERTIES)),
      exists: await exists(path.join(found.root, GRADLE_WRAPPER_PROPERTIES)),
    },
    root_project: rootProject,
    modules: allModules,
    missing_modules: missingModules,
    declared_tasks: declaredTasks,
  };
}

function packageWorkspaces(manifest) {
  const workspaces = manifest?.workspaces;
  if (Array.isArray(workspaces)) return workspaces.map(String).sort((left, right) => left.localeCompare(right));
  if (workspaces && typeof workspaces === "object" && Array.isArray(workspaces.packages)) {
    return workspaces.packages.map(String).sort((left, right) => left.localeCompare(right));
  }
  return [];
}

function backendCandidate({ relative, manifest }) {
  const text = `${relative} ${manifest?.name || ""} ${Object.keys(manifest?.scripts || {}).join(" ")}`;
  return /(^|\/)(api|backend|server|worker|service)(\/|$)|\b(?:api|backend|server|worker|serve|start)\b/i.test(text);
}

async function collectNodePackages(root) {
  const packages = [];
  const stack = [{ directory: path.resolve(root), depth: 0 }];
  let scannedDirectories = 0;
  let truncated = false;
  while (stack.length) {
    const current = stack.pop();
    scannedDirectories += 1;
    if (scannedDirectories > MAX_SCAN_DIRECTORIES) {
      truncated = true;
      break;
    }
    const packagePath = path.join(current.directory, "package.json");
    if (await exists(packagePath)) {
      const parsed = await readJson(packagePath);
      const relative = relativePath(root, current.directory);
      if (packages.length < MAX_PACKAGE_FILES) {
        const manifest = parsed.value && typeof parsed.value === "object" ? parsed.value : {};
        packages.push({
          path: relative,
          manifest: "package.json",
          name: typeof manifest.name === "string" ? manifest.name : null,
          private: manifest.private === true,
          package_manager: typeof manifest.packageManager === "string" ? manifest.packageManager : null,
          workspaces: packageWorkspaces(manifest),
          scripts: sortStrings(Object.keys(manifest.scripts || {})),
          dependency_count: ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
            .reduce((count, key) => count + Object.keys(manifest[key] || {}).length, 0),
          backend_candidate: backendCandidate({ relative, manifest }),
          parse_error: parsed.parse_error,
        });
      } else {
        truncated = true;
        break;
      }
    }
    if (current.depth >= 5) continue;
    const entries = await readdir(current.directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => right.name.localeCompare(left.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (ORIENTATION_SKIP_DIRECTORIES.has(entry.name)) continue;
      stack.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
    }
  }
  packages.sort((left, right) => left.path.localeCompare(right.path));
  return { packages, scanned_directories: scannedDirectories, truncated };
}

async function collectRuleFiles(root) {
  const found = [];
  const stack = [{ directory: path.resolve(root), depth: 0 }];
  let scannedDirectories = 0;
  let truncated = false;
  while (stack.length) {
    const current = stack.pop();
    scannedDirectories += 1;
    if (scannedDirectories > MAX_SCAN_DIRECTORIES) {
      truncated = true;
      break;
    }
    const entries = await readdir(current.directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(current.directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.isSymbolicLink() && !ORIENTATION_SKIP_DIRECTORIES.has(entry.name) && current.depth < 5) {
          stack.push({ directory: target, depth: current.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile() || !RULE_FILE_NAMES.has(entry.name)) continue;
      if (found.length >= MAX_RULE_FILES) {
        truncated = true;
        break;
      }
      found.push(relativePath(root, target));
    }
    if (truncated) break;
  }
  return { files: sortStrings(found), scanned_directories: scannedDirectories, truncated };
}

async function collectNodeLocks(root, packages) {
  const locations = [".", ...packages.map((item) => item.path)];
  const locks = [];
  for (const location of sortStrings(locations)) {
    for (const name of NODE_LOCKFILE_NAMES) {
      const relative = location === "." ? name : `${location}/${name}`;
      if (await exists(path.join(root, ...relative.split("/")))) locks.push(relative);
    }
  }
  return sortStrings(locks);
}

export async function buildWorkspaceModuleMap(workspace, { repositoryRoot = workspace } = {}) {
  const resolvedWorkspace = path.resolve(workspace);
  const gradle = await buildGradleMap(resolvedWorkspace, repositoryRoot);
  const nodeResult = await collectNodePackages(resolvedWorkspace);
  const ruleResult = await collectRuleFiles(resolvedWorkspace);
  const node = {
    detected: nodeResult.packages.length > 0,
    packages: nodeResult.packages,
    lockfiles: await collectNodeLocks(resolvedWorkspace, nodeResult.packages),
    scanned_directories: nodeResult.scanned_directories,
    truncated: nodeResult.truncated,
  };
  const map = {
    version: MODULE_MAP_VERSION,
    repository_root: relativePath(resolvedWorkspace, repositoryRoot),
    gradle,
    node,
    rule_files: ruleResult.files,
    scan: {
      orientation_skip_directories: [...ORIENTATION_SKIP_DIRECTORIES].sort((left, right) => left.localeCompare(right)),
      rule_scan_directories: ruleResult.scanned_directories,
      rule_scan_truncated: ruleResult.truncated,
    },
  };
  return { ...map, fingerprint: fingerprint(map) };
}

// A bounded metadata-only surface snapshot for explicitly requested machine
// probes. Unlike the exact Graph snapshot, this also sees ignored/generated
// files so a Gradle configuration probe can report what it created or changed.
// It never changes the snapshot's inclusion rules.
export async function captureWorkspaceSurface(workspace, { maxEntries = MAX_SURFACE_ENTRIES } = {}) {
  const root = path.resolve(workspace);
  const files = {};
  const stack = [root];
  let truncated = false;
  while (stack.length) {
    const directory = stack.pop();
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".git") continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.isSymbolicLink()) stack.push(target);
        continue;
      }
      if (!entry.isFile() || files[relativePath(root, target)]) continue;
      if (Object.keys(files).length >= maxEntries) {
        truncated = true;
        break;
      }
      const details = await stat(target).catch(() => null);
      if (!details) continue;
      files[relativePath(root, target)] = {
        size: details.size,
        mtime_ms: details.mtimeMs,
        mode: details.mode & 0o777,
      };
    }
    if (truncated) break;
  }
  const sortedFiles = Object.fromEntries(Object.keys(files).sort((left, right) => left.localeCompare(right)).map((key) => [key, files[key]]));
  return {
    root: ".",
    files: sortedFiles,
    count: Object.keys(sortedFiles).length,
    truncated,
    fingerprint: fingerprint({ files: sortedFiles, truncated }),
  };
}

export function workspaceSurfaceDiff(before, after) {
  const left = before?.files || {};
  const right = after?.files || {};
  return sortStrings([...Object.keys(left), ...Object.keys(right)]).filter((file) => JSON.stringify(left[file] || null) !== JSON.stringify(right[file] || null));
}

function scoreModule(module, terms) {
  const haystack = `${module.path} ${module.project_path || ""} ${module.name || ""} ${module.backend_candidate ? "backend" : ""}`.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function trimContext(context, maxBytes) {
  const serialized = JSON.stringify(context, null, 2);
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return serialized;
  const reduced = {
    ...context,
    gradle: context.gradle
      ? { ...context.gradle, modules: context.gradle.modules.slice(0, 12), declared_tasks: context.gradle.declared_tasks.slice(0, 24) }
      : context.gradle,
    node: context.node ? { ...context.node, packages: context.node.packages.slice(0, 12) } : context.node,
    rule_files: context.rule_files.slice(0, 64),
    truncated: true,
  };
  const reducedText = JSON.stringify(reduced, null, 2);
  if (Buffer.byteLength(reducedText, "utf8") <= maxBytes) return reducedText;
  // Never return a sliced JSON document. Context is prompt input and must
  // remain machine-parseable even when a repository has thousands of modules.
  const emergency = {
    version: context.version || MODULE_MAP_VERSION,
    fingerprint: context.fingerprint || null,
    selection: context.selection || "bounded module boundaries",
    gradle: context.gradle
      ? {
          detected: context.gradle.detected,
          project_root: context.gradle.project_root,
          missing_modules: context.gradle.missing_modules?.slice(0, 8) || [],
        }
      : null,
    node: context.node
      ? { detected: context.node.detected, lockfiles: context.node.lockfiles || [] }
      : null,
    rule_files: [],
    context_truncated: true,
    note: context.note || "Orientation metadata only.",
  };
  const emergencyText = JSON.stringify(emergency, null, 2);
  if (Buffer.byteLength(emergencyText, "utf8") <= maxBytes) return emergencyText;
  return JSON.stringify({
    version: context.version || MODULE_MAP_VERSION,
    fingerprint: context.fingerprint || null,
    context_truncated: true,
  });
}

export function moduleMapContext(moduleMap, { focus = "", maxBytes = MAX_CONTEXT_BYTES } = {}) {
  const terms = sortStrings(String(focus || "").toLowerCase().split(/[^a-z0-9_:-]+/).filter((term) => term.length >= 3));
  const gradleModules = (moduleMap?.gradle?.modules || [])
    .map((module) => ({ module, score: scoreModule(module, terms) }))
    .sort((left, right) => right.score - left.score || left.module.path.localeCompare(right.module.path))
    .map(({ module }) => module);
  const nodePackages = (moduleMap?.node?.packages || [])
    .map((module) => ({ module, score: scoreModule(module, terms) }))
    .sort((left, right) => right.score - left.score || left.module.path.localeCompare(right.module.path))
    .map(({ module }) => module);
  return trimContext({
    version: moduleMap?.version || MODULE_MAP_VERSION,
    fingerprint: moduleMap?.fingerprint || null,
    selection: terms.length ? "focus-ranked module boundaries" : "all discovered module boundaries",
    gradle: moduleMap?.gradle
      ? {
          detected: moduleMap.gradle.detected,
          project_root: moduleMap.gradle.project_root,
          settings_files: moduleMap.gradle.settings_files,
          wrapper: moduleMap.gradle.wrapper,
          missing_modules: moduleMap.gradle.missing_modules,
          modules: gradleModules,
          declared_tasks: moduleMap.gradle.declared_tasks,
        }
      : null,
    node: moduleMap?.node
      ? {
          detected: moduleMap.node.detected,
          lockfiles: moduleMap.node.lockfiles,
          packages: nodePackages,
        }
      : null,
    rule_files: moduleMap?.rule_files || [],
    note: "Orientation metadata only. It does not alter the exact workspace snapshot or exclude source files from evidence.",
  }, maxBytes);
}

function gradleStaticGaps(gradle) {
  const gaps = [];
  for (const module of gradle?.modules || []) {
    if (module.status === "ready") continue;
    gaps.push({
      kind: "gradle-module",
      project_path: module.project_path,
      path: module.path,
      status: module.status,
      missing: module.missing,
      reason: `Declared Gradle module ${module.project_path} is not structurally ready: ${module.missing.join(", ")}.`,
    });
  }
  if (gradle?.detected && !gradle.wrapper.exists) {
    gaps.push({
      kind: "gradle-toolchain",
      status: "unavailable",
      reason: "Gradle project was detected but no checked-in gradlew/gradlew.bat wrapper was found.",
    });
  }
  if (gradle?.detected && !gradle.wrapper_properties.exists) {
    gaps.push({
      kind: "gradle-toolchain",
      status: "unavailable",
      reason: "Gradle project was detected but gradle/wrapper/gradle-wrapper.properties was not found.",
    });
  }
  return gaps;
}

export function staticMachinePreflight(moduleMap, { requested = false, requiredChecks = [] } = {}) {
  const gradle = moduleMap?.gradle || { detected: false };
  const gaps = gradle.detected ? gradleStaticGaps(gradle) : [];
  const environmentGaps = gaps.filter((gap) => gap.kind === "gradle-toolchain");
  const structuralGaps = gaps.filter((gap) => gap.kind !== "gradle-toolchain");
  const checks = [];
  if (gradle.detected) {
    checks.push({ id: "gradle-settings", status: "pass", evidence: gradle.settings_files.join(", ") });
    checks.push({ id: "gradle-wrapper", status: gradle.wrapper.exists ? "pass" : "gap", evidence: gradle.wrapper.path || "not found" });
    checks.push({ id: "gradle-wrapper-properties", status: gradle.wrapper_properties.exists ? "pass" : "gap", evidence: gradle.wrapper_properties.path || "not found" });
    for (const module of gradle.modules) {
      checks.push({
        id: `gradle-module:${module.project_path}`,
        status: module.status === "ready" ? "pass" : "gap",
        evidence: module.path,
        missing: module.missing,
      });
    }
  } else {
    checks.push({ id: "gradle-project", status: "not_applicable", evidence: "No settings.gradle or settings.gradle.kts found in the selected repository scope." });
  }
  const readiness = !gradle.detected
    ? "not_applicable"
    : structuralGaps.length
      ? "gaps"
      : environmentGaps.length
        ? "waiting_environment"
        : "ready";
  return {
    version: MODULE_MAP_VERSION,
    requested,
    status: "pass",
    readiness,
    ready: readiness === "ready" || readiness === "not_applicable",
    static: { status: "pass", checks, gaps },
    gaps,
    environment_gaps: environmentGaps,
    structural_gaps: structuralGaps,
    required_gradle_checks: requiredChecks
      .filter((check) => /gradlew(?:\.bat)?\b/i.test(String(check?.command || "")))
      .map((check) => ({ id: check.id || null, description: check.description || null, command: check.command || null })),
    commands: [],
    file_changes: [],
    probe: { requested: false, status: "not_requested" },
  };
}

export function gradleTasksFromChecks(requiredChecks = []) {
  const tasks = new Set();
  for (const check of requiredChecks) {
    const command = String(check?.command || "");
    if (/&&|\|\||[|;]/.test(command)) continue;
    const match = command.match(/(?:^|[\s/&])(?:\.\/)?gradlew(?:\.bat)?\b([\s\S]*)/i);
    if (!match || /&&|\|\||[|;]/.test(match[1])) continue;
    for (const token of match[1].trim().split(/\s+/)) {
      const cleaned = token.replace(/^['"]|['"]$/g, "");
      if (!cleaned || cleaned.startsWith("--")) continue;
      if (/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(cleaned) || /^:[A-Za-z0-9_.:-]+$/.test(cleaned)) tasks.add(cleaned);
    }
  }
  return [...tasks].sort((left, right) => left.localeCompare(right));
}

export const __test = {
  parseGradleSettings,
  parseGradleTasks,
  gradleProjectRelativePath,
  gradleTasksFromChecks,
  staticMachinePreflight,
  workspaceSurfaceDiff,
};
