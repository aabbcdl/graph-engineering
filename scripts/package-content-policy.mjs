import { readFile } from "node:fs/promises";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

const CONTENT_RULES = [
  { id: "absolute-mac-user-path", pattern: /\/Users\/(?!<[^>\r\n/]+>)[A-Za-z0-9._-]+(?:\/|(?=[\s"'`()\[\]{},:;!?]|$))/g },
  { id: "absolute-volume-path", pattern: /\/Volumes\/(?!<[^>\r\n/]+>)[A-Za-z0-9._-]+(?:\/|(?=[\s"'`()\[\]{},:;!?]|$))/g },
  { id: "absolute-private-temp-path", pattern: /\/private\/(?:tmp|var)\/(?!<[^>\r\n/]+>)[A-Za-z0-9._-]+(?:\/|(?=[\s"'`()\[\]{},:;!?]|$))/g },
  { id: "absolute-home-path", pattern: /\/home\/(?!<[^>\r\n/]+>)[A-Za-z0-9._-]+(?:\/|(?=[\s"'`()\[\]{},:;!?]|$))/g },
  {
    id: "absolute-windows-user-path",
    pattern: /\b[A-Za-z]:\\(?:Users|Documents and Settings)\\(?!<[^>\r\n\\]+>)[A-Za-z0-9._-]+(?:\\|(?=[\s"'`()\[\]{},:;!?]|$))/gi,
  },
  { id: "uri-embedded-credentials", pattern: /https?:\/\/[^/\s:@]+:[^/\s@]+@/gi },
  { id: "private-key-material", pattern: /-----BEGIN [A-Z0-9 ]+ PRIVATE KEY-----/g },
  { id: "github-token", pattern: /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/g },
  { id: "provider-api-key", pattern: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/gi },
  { id: "google-api-key", pattern: /\bAIza[A-Za-z0-9_-]{20,}\b/g },
  { id: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
];

const CANONICAL_WORKFLOW_CONTRACT = "skills/autonomous-engineering-graph/references/lifecycle-contract.md";
const WORKFLOW_CONTRACT_COMPAT_ENTRY = "生命周期扩展/统一工作流契约.md";
const RELEASE_RUNBOOK = "docs/release-runbook.md";
const LEGACY_WORKFLOW_CONTRACT_REFERENCE = /(?:生命周期扩展\/)?统一工作流契约\.md/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function scanPackagedContent(relativePath, content) {
  const violations = [];
  for (const rule of CONTENT_RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(String(content))) violations.push({ path: relativePath, rule: rule.id });
  }
  return violations;
}

function pathIsInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function scanPackagedFiles({ projectRoot, files }) {
  const root = path.resolve(projectRoot);
  const canonicalRoot = await realpath(root);
  const violations = [];
  for (const entry of files) {
    const relative = String(entry.path || entry).replaceAll("\\", "/");
    const filePath = path.resolve(root, relative);
    if (!pathIsInside(root, filePath)) throw new Error(`Package path escapes project root: ${relative}`);
    const details = await lstat(filePath);
    if (details.isSymbolicLink()) throw new Error(`Package path must not be a symlink: ${relative}`);
    const canonicalFile = await realpath(filePath);
    if (!pathIsInside(canonicalRoot, canonicalFile)) {
      throw new Error(`Package path resolves outside project root: ${relative}`);
    }
    const content = await readFile(filePath);
    if (content.includes(0)) continue;
    violations.push(...scanPackagedContent(relative, content.toString("utf8")));
  }
  return violations;
}

function packageRepositoryOwner(packageJson) {
  const raw = typeof packageJson?.repository === "string"
    ? packageJson.repository
    : packageJson?.repository?.url;
  const normalized = String(raw || "").replace(/^git\+/, "");
  try {
    const parsed = new URL(normalized);
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    return parsed.pathname.split("/").filter(Boolean)[0] || null;
  } catch {
    const match = normalized.match(/^git@github\.com:([^/]+)\//i);
    return match?.[1] || null;
  }
}

function releaseControls(content) {
  const block = String(content).match(/<!--\s*release-controls\s*\n([\s\S]*?)-->/i)?.[1] || "";
  const controls = {};
  for (const line of block.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-z_]+)=(.+)$/);
    if (match) controls[match[1]] = match[2].trim();
  }
  return controls;
}

async function validateReleaseDocuments({ projectRoot, files, packageJson }) {
  const root = path.resolve(projectRoot);
  const packagedFiles = [...new Set(files.map((entry) => String(entry.path || entry).replaceAll("\\", "/")))];
  const packaged = new Set(packagedFiles);
  const violations = [];
  const add = (file, rule) => violations.push({ path: file, rule });
  const required = [CANONICAL_WORKFLOW_CONTRACT, WORKFLOW_CONTRACT_COMPAT_ENTRY, RELEASE_RUNBOOK];
  for (const relative of required) {
    if (!packaged.has(relative)) add(relative, "missing-release-document");
  }
  if (violations.length) return violations;

  const compat = await readFile(path.join(root, WORKFLOW_CONTRACT_COMPAT_ENTRY), "utf8");
  if (!compat.includes(`../${CANONICAL_WORKFLOW_CONTRACT}`)) {
    add(WORKFLOW_CONTRACT_COMPAT_ENTRY, "compat-entry-missing-canonical-target");
  }

  const owner = packageRepositoryOwner(packageJson);
  const runbook = await readFile(path.join(root, RELEASE_RUNBOOK), "utf8");
  const controls = releaseControls(runbook);
  const packageName = String(packageJson?.name || "");
  const packageVersion = String(packageJson?.version || "");
  const baseline = controls.rollback_baseline || "";
  const baselinePrefix = `${packageName}@`;
  const baselineVersion = baseline.startsWith(baselinePrefix) ? baseline.slice(baselinePrefix.length) : "";
  if (!owner || controls.release_owner !== owner) add(RELEASE_RUNBOOK, "release-owner-mismatch");
  if (!owner || controls.monitoring_owner !== owner) add(RELEASE_RUNBOOK, "monitoring-owner-mismatch");
  if (!SEMVER.test(baselineVersion) || baselineVersion === packageVersion) {
    add(RELEASE_RUNBOOK, "invalid-rollback-baseline");
  }
  if (controls.failure_threshold !== "any_identity_mismatch_or_smoke_failure") {
    add(RELEASE_RUNBOOK, "invalid-failure-threshold");
  }
  const requiredRunbookText = [
    `${packageName}@${packageVersion}`,
    `npm dist-tag add ${baseline} latest`,
    `npm deprecate ${packageName}@${packageVersion}`,
    "gitHead",
    "dist.shasum",
    "dist.integrity",
    "dist.fileCount",
    "dist-tags.latest",
    "help",
    "preview",
    "doctor",
    "validate",
  ];
  for (const expected of requiredRunbookText) {
    if (!runbook.includes(expected)) add(RELEASE_RUNBOOK, `missing-runbook-control:${expected}`);
  }
  if (/\bnpm\s+unpublish\b/i.test(runbook)) add(RELEASE_RUNBOOK, "unsafe-unpublish-rollback");

  for (const relative of packagedFiles.filter((file) => file.startsWith("skills/") && file.endsWith(".md"))) {
    const content = await readFile(path.join(root, relative), "utf8");
    if (LEGACY_WORKFLOW_CONTRACT_REFERENCE.test(content)) {
      add(relative, "legacy-workflow-contract-reference");
    }
    for (const match of content.matchAll(/`([^`\r\n]*lifecycle-contract\.md)`/g)) {
      const target = path.resolve(path.dirname(path.join(root, relative)), match[1]);
      if (target !== path.join(root, CANONICAL_WORKFLOW_CONTRACT)) {
        add(relative, "noncanonical-workflow-contract-target");
      }
    }
  }
  return violations;
}

export { scanPackagedContent, scanPackagedFiles, validateReleaseDocuments };
