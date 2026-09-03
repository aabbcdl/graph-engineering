import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";

const PACKAGE_NAME = "graph-engineering";
const INSTALLATION_METADATA_FILE = ".graph-engineering-install.json";
const CANONICAL_REPOSITORY = "https://github.com/aabbcdl/graph-engineering.git";
const GITHUB_MAIN_ENDPOINT = "https://api.github.com/repos/aabbcdl/graph-engineering/commits/main";
const NPM_LATEST_ENDPOINT = "https://registry.npmjs.org/graph-engineering/latest";
const DEFAULT_CHECK_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function skillsFingerprint(skillsRoot, skillNames) {
  const records = [];
  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === INSTALLATION_METADATA_FILE || entry.name === ".DS_Store") continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.join(relativeDirectory, entry.name).split(path.sep).join("/");
      const details = await lstat(absolute);
      if (details.isDirectory()) {
        await visit(absolute, relative);
      } else if (details.isFile()) {
        records.push(`file\0${relative}\0${await fileSha256(absolute)}`);
      } else if (details.isSymbolicLink()) {
        records.push(`link\0${relative}\0${await readlink(absolute)}`);
      } else {
        records.push(`other\0${relative}`);
      }
    }
  }
  for (const name of [...skillNames].sort()) await visit(path.join(skillsRoot, name), name);
  return sha256(records.join("\n"));
}

async function fileSha256(target) {
  return sha256(await readFile(target));
}

function normalizedRepositoryUrl(value) {
  const raw = String(value || "").trim().replace(/^git\+/, "");
  const ssh = raw.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (ssh) return `https://github.com/${ssh[1]}/${ssh[2].replace(/\.git$/i, "")}.git`;
  try {
    const parsed = new URL(raw);
    const https = parsed.protocol === "https:" && !parsed.username && !parsed.password;
    const sshUrl = parsed.protocol === "ssh:" && parsed.username === "git" && !parsed.password;
    if (
      (!https && !sshUrl)
      || parsed.hostname.toLowerCase() !== "github.com"
      || parsed.search
      || parsed.hash
      || parsed.port
    ) return null;
    const parts = parsed.pathname.replace(/\.git$/i, "").split("/").filter(Boolean);
    if (parts.length !== 2) return null;
    return `https://github.com/${parts[0]}/${parts[1]}.git`;
  } catch {
    return null;
  }
}

function gitEnvironment(source = process.env) {
  const environment = { ...source };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) {
    delete environment[key];
  }
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function runGit(projectRoot, args) {
  return spawnSync(
    process.platform === "win32" ? "git.exe" : "git",
    [
      "-C",
      projectRoot,
      "--no-pager",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "diff.external=",
      ...args,
    ],
    {
      encoding: "utf8",
      env: gitEnvironment(),
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    },
  );
}

function sourceIdentity(projectRoot, repository) {
  const topLevel = runGit(projectRoot, ["rev-parse", "--show-toplevel"]);
  if (topLevel.status !== 0 || !String(topLevel.stdout || "").trim()) return { type: "package", repository };
  if (path.resolve(String(topLevel.stdout).trim()) !== path.resolve(projectRoot)) return { type: "package", repository };

  const head = runGit(projectRoot, ["rev-parse", "HEAD"]);
  const branch = runGit(projectRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const origin = runGit(projectRoot, ["remote", "get-url", "origin"]);
  const tracked = runGit(projectRoot, [
    "diff",
    "--quiet",
    "--no-ext-diff",
    "HEAD",
    "--",
    "package.json",
    "scripts/install.mjs",
    "skills",
  ]);
  const untracked = runGit(projectRoot, ["ls-files", "--others", "--exclude-standard", "--", "skills"]);
  const relevantUntracked = untracked.status === 0
    ? String(untracked.stdout || "")
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => entry && !/(?:^|\/)\.DS_Store$/.test(entry))
    : null;
  const modified = tracked.status === 0 && relevantUntracked !== null
    ? relevantUntracked.length > 0
    : tracked.status === 1
      ? true
      : null;
  const headValue = String(head.stdout || "").trim();
  const branchValue = String(branch.stdout || "").trim();
  const normalizedOrigin = origin.status === 0 ? normalizedRepositoryUrl(String(origin.stdout || "").trim()) : null;
  return {
    type: "git",
    repository,
    canonical_repository: normalizedOrigin === CANONICAL_REPOSITORY,
    root: path.resolve(projectRoot),
    commit: /^[0-9a-f]{40}$/i.test(headValue) ? headValue.toLowerCase() : null,
    branch: branch.status === 0 && branchValue ? branchValue : null,
    modified,
  };
}

async function readPackageManifest(projectRoot) {
  const parsed = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  if (parsed.name !== PACKAGE_NAME || !SEMVER.test(String(parsed.version || ""))) {
    throw new Error(`Expected ${PACKAGE_NAME} with a valid semantic version in ${path.join(projectRoot, "package.json")}`);
  }
  const repositoryValue = typeof parsed.repository === "string" ? parsed.repository : parsed.repository?.url;
  const repository = normalizedRepositoryUrl(repositoryValue);
  if (repository !== CANONICAL_REPOSITORY) {
    throw new Error(`Expected canonical repository ${CANONICAL_REPOSITORY}`);
  }
  return { name: parsed.name, version: parsed.version, repository };
}

async function createInstallationMetadata({ projectRoot, skillsRoot, skillNames, installedAt = new Date().toISOString() }) {
  const manifest = await readPackageManifest(projectRoot);
  const runner = path.join(skillsRoot, "autonomous-engineering-graph", "scripts", "graph-runner.mjs");
  const names = [...new Set((skillNames || []).map(String))].sort();
  if (!names.includes("autonomous-engineering-graph")) throw new Error("Graph installation is missing the control-plane Skill");
  return {
    schema_version: 1,
    package_name: manifest.name,
    package_version: manifest.version,
    installed_at: installedAt,
    source: sourceIdentity(projectRoot, manifest.repository),
    runner_sha256: await fileSha256(runner),
    skill_names: names,
    skills_sha256: await skillsFingerprint(skillsRoot, names),
  };
}

function validInstallationMetadata(value) {
  return Boolean(
    value
      && value.schema_version === 1
      && value.package_name === PACKAGE_NAME
      && SEMVER.test(String(value.package_version || ""))
      && typeof value.installed_at === "string"
      && ["git", "package"].includes(value.source?.type)
      && value.source?.repository === CANONICAL_REPOSITORY
      && /^[0-9a-f]{64}$/i.test(String(value.runner_sha256 || ""))
      && Array.isArray(value.skill_names)
      && value.skill_names.includes("autonomous-engineering-graph")
      && value.skill_names.every((name) => /^[a-z0-9-]+$/.test(String(name)))
      && /^[0-9a-f]{64}$/i.test(String(value.skills_sha256 || "")),
  );
}

function normalizedMetadata(value) {
  if (!validInstallationMetadata(value)) return null;
  const source = {
    type: value.source.type,
    repository: CANONICAL_REPOSITORY,
    canonical_repository: value.source.type === "git" ? value.source.canonical_repository === true : null,
    root: value.source.type === "git" && path.isAbsolute(String(value.source.root || ""))
      ? path.resolve(value.source.root)
      : null,
    commit: /^[0-9a-f]{40}$/i.test(String(value.source.commit || ""))
      ? String(value.source.commit).toLowerCase()
      : null,
    branch: typeof value.source.branch === "string" && value.source.branch.trim()
      ? value.source.branch.trim()
      : null,
    modified: typeof value.source.modified === "boolean" ? value.source.modified : null,
  };
  return {
    schema_version: 1,
    package_name: PACKAGE_NAME,
    package_version: value.package_version,
    installed_at: value.installed_at,
    source,
    runner_sha256: value.runner_sha256.toLowerCase(),
    skill_names: [...new Set(value.skill_names.map(String))].sort(),
    skills_sha256: value.skills_sha256.toLowerCase(),
  };
}

async function localVersionIdentity({ skillDir, runnerSha256 }) {
  const metadataPath = path.join(skillDir, INSTALLATION_METADATA_FILE);
  const saved = await readFile(metadataPath, "utf8")
    .then((content) => normalizedMetadata(JSON.parse(content)))
    .catch(() => null);
  if (saved) {
    const currentSkillsSha256 = await skillsFingerprint(path.dirname(skillDir), saved.skill_names).catch(() => null);
    const runnerMatches = saved.runner_sha256 === runnerSha256;
    const skillsMatch = saved.skills_sha256 === currentSkillsSha256;
    return {
      package_name: PACKAGE_NAME,
      package_version: saved.package_version,
      installed_at: saved.installed_at,
      install_metadata: "recorded",
      install_metadata_path: metadataPath,
      source: saved.source,
      runtime: {
        runner_sha256: runnerSha256,
        recorded_runner_sha256: saved.runner_sha256,
        skills_sha256: currentSkillsSha256,
        recorded_skills_sha256: saved.skills_sha256,
        skill_names: saved.skill_names,
        integrity: runnerMatches && skillsMatch ? "verified" : currentSkillsSha256 ? "modified" : "unreadable",
      },
    };
  }

  const projectRoot = path.resolve(skillDir, "..", "..");
  const manifest = await readPackageManifest(projectRoot).catch(() => null);
  if (manifest) {
    const names = (await readdir(path.dirname(skillDir), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && (entry.name === "autonomous-engineering-graph" || entry.name.startsWith("graph-")))
      .map((entry) => entry.name)
      .sort();
    return {
      package_name: PACKAGE_NAME,
      package_version: manifest.version,
      installed_at: null,
      install_metadata: "not-installed-copy",
      install_metadata_path: null,
      source: sourceIdentity(projectRoot, manifest.repository),
      runtime: {
        runner_sha256: runnerSha256,
        recorded_runner_sha256: null,
        skills_sha256: await skillsFingerprint(path.dirname(skillDir), names).catch(() => null),
        recorded_skills_sha256: null,
        skill_names: names,
        integrity: "unrecorded",
      },
    };
  }

  return {
    package_name: PACKAGE_NAME,
    package_version: null,
    installed_at: null,
    install_metadata: "legacy-missing",
    install_metadata_path: null,
    source: { type: "legacy", repository: CANONICAL_REPOSITORY },
    runtime: {
      runner_sha256: runnerSha256,
      recorded_runner_sha256: null,
      skills_sha256: null,
      recorded_skills_sha256: null,
      skill_names: null,
      integrity: "unrecorded",
    },
  };
}

function parseSemver(value) {
  const match = String(value || "").match(SEMVER);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    const leftNumber = /^\d+$/.test(left[index]) ? Number(left[index]) : null;
    const rightNumber = /^\d+$/.test(right[index]) ? Number(right[index]) : null;
    if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) return leftNumber < rightNumber ? -1 : 1;
    if (leftNumber !== null && rightNumber === null) return -1;
    if (leftNumber === null && rightNumber !== null) return 1;
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue);
  const right = parseSemver(rightValue);
  if (!left || !right) return null;
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

async function fetchPublicJson(url, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_CHECK_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("This Node.js runtime does not provide fetch");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "graph-engineering-version-check",
      },
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("response exceeded the size limit");
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function safeCheckError(error) {
  if (error?.name === "AbortError") return "request timed out";
  return String(error?.message || error || "request failed")
    .replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s?#@]+@/g, "$1[REDACTED]@")
    .replace(/([?&](?:token|key|secret|password|authorization)=)[^\s&#]+/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .slice(0, 240);
}

async function latestVersionCheck(identity, options = {}) {
  const checkedAt = new Date().toISOString();
  const stablePromise = fetchPublicJson(NPM_LATEST_ENDPOINT, options)
    .then((value) => {
      if (!SEMVER.test(String(value?.version || ""))) throw new Error("registry response did not contain a valid version");
      return { status: "available", version: value.version, endpoint: NPM_LATEST_ENDPOINT };
    })
    .catch((error) => ({ status: "unavailable", version: null, endpoint: NPM_LATEST_ENDPOINT, error: safeCheckError(error) }));
  const sourcePromise = identity.source?.type === "git" && identity.source.canonical_repository
    ? fetchPublicJson(GITHUB_MAIN_ENDPOINT, options)
      .then((value) => {
        const commit = String(value?.sha || "").toLowerCase();
        if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("GitHub response did not contain a valid commit");
        return { status: "available", commit, endpoint: GITHUB_MAIN_ENDPOINT };
      })
      .catch((error) => ({ status: "unavailable", commit: null, endpoint: GITHUB_MAIN_ENDPOINT, error: safeCheckError(error) }))
    : Promise.resolve({ status: "not-applicable", commit: null, endpoint: GITHUB_MAIN_ENDPOINT });
  const [stable, source] = await Promise.all([stablePromise, sourcePromise]);

  let status = "unknown";
  let currentForChannel = null;
  let channel = identity.source?.type === "git" ? "github-main" : "npm-latest";
  if (["modified", "unreadable"].includes(identity.runtime?.integrity) || identity.source?.modified === true) {
    status = "modified";
  } else if (identity.source?.type === "package" && identity.runtime?.integrity !== "verified") {
    status = "unknown";
  } else if (identity.source?.type === "git") {
    if (identity.source.modified !== false || identity.source.canonical_repository !== true || !identity.source.commit) {
      status = "unknown";
    } else if (source.status === "available") {
      currentForChannel = identity.source.commit === source.commit;
      status = currentForChannel ? "current" : "update_available";
    }
  } else if (identity.package_version && stable.status === "available") {
    const comparison = compareSemver(identity.package_version, stable.version);
    if (comparison === 0) {
      currentForChannel = true;
      status = "current";
    } else if (comparison < 0) {
      currentForChannel = false;
      status = "update_available";
    } else if (comparison > 0) {
      currentForChannel = true;
      status = "ahead_of_stable";
    }
  }

  return {
    checked_at: checkedAt,
    channel,
    status,
    current_for_channel: currentForChannel,
    stable,
    source,
  };
}

function updateGuidance(identity) {
  if (
    identity.source?.type === "git"
    && identity.source.canonical_repository === true
    && identity.source.root
  ) {
    return {
      method: "agent-managed-git",
      source_root: identity.source.root,
      instruction:
        "Ask your Agent to require a clean Graph source checkout and no active Graph run, update canonical origin/main with fast-forward only, run npm run install:global, then run validate, doctor, and version --check again.",
    };
  }
  if (identity.source?.type === "git") {
    return {
      method: "agent-managed-reinstall",
      source_root: null,
      instruction:
        "The recorded Git source is not a usable verified canonical checkout. Ask your Agent to use a fresh https://github.com/aabbcdl/graph-engineering.git checkout and its installer; do not pull the recorded origin.",
    };
  }
  if (identity.source?.type === "legacy") {
    return {
      method: "agent-managed-reinstall",
      source_root: null,
      instruction:
        "The install predates version provenance. Ask your Agent to use a fresh canonical GitHub checkout, require no active Graph run, run npm run install:global, then run validate, doctor, and version --check again; do not assume NPM latest is newer.",
    };
  }
  return {
    method: "agent-managed-npm",
    source_root: null,
    instruction:
      "Ask your Agent to require no active Graph run, install graph-engineering@latest globally, run graph-engineering-install, then run validate, doctor, and version --check again.",
  };
}

async function graphVersionReport({ skillDir, runnerSha256, checkLatest = false, fetchImpl, timeoutMs } = {}) {
  const installed = await localVersionIdentity({ skillDir, runnerSha256 });
  const latest = checkLatest ? await latestVersionCheck(installed, { fetchImpl, timeoutMs }) : null;
  return {
    schema_version: 1,
    status: latest?.status || "installed",
    installed,
    latest_checked: Boolean(latest),
    latest,
    update: updateGuidance(installed),
  };
}

function renderVersionReport(report) {
  const installed = report.installed;
  const lines = [
    `Graph Engineering ${installed.package_version || "unknown"}`,
    `Install source: ${installed.source?.type || "unknown"}`,
    `Runtime integrity: ${installed.runtime?.integrity || "unknown"}`,
  ];
  if (installed.source?.commit) lines.push(`Installed commit: ${installed.source.commit}`);
  if (installed.installed_at) lines.push(`Installed at: ${installed.installed_at}`);
  if (!report.latest_checked) {
    lines.push("Latest status: not checked (run graph-engineering version --check)");
  } else {
    lines.push(`Latest status: ${report.latest.status}`);
    if (report.latest.source?.commit) lines.push(`GitHub main: ${report.latest.source.commit}`);
    if (report.latest.stable?.version) lines.push(`NPM latest: ${report.latest.stable.version}`);
    if (["update_available", "modified", "unknown"].includes(report.latest.status)) {
      lines.push(`Next: ${report.update.instruction}`);
    }
  }
  return lines.join("\n");
}

export {
  CANONICAL_REPOSITORY,
  GITHUB_MAIN_ENDPOINT,
  INSTALLATION_METADATA_FILE,
  NPM_LATEST_ENDPOINT,
  compareSemver,
  createInstallationMetadata,
  graphVersionReport,
  latestVersionCheck,
  localVersionIdentity,
  normalizedRepositoryUrl,
  renderVersionReport,
  updateGuidance,
};
