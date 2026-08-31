#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_DEPTH = 6;
const RUN_FILE = "run.json";
const SUMMARY_FILES = [
  "run.json",
  "runtime-state.json",
  "completion.json",
  "report.md",
  "graph.json",
  "finding-lineage.json",
  "events/events.jsonl",
  "events/events.head.json",
  "events/events.index.jsonl",
];
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".gradle",
  "artifacts",
  "build",
  "dist",
  "node_modules",
  "recovery",
  "target",
  "workspace",
  "workspaces",
]);
const SENSITIVE_LABEL_PATTERNS = [
  /(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/i,
  /(?:^|[^A-Za-z0-9])(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}/i,
  /(?:^|[^A-Za-z0-9])AIza[A-Za-z0-9_-]{20,}/i,
  /(?:^|[^A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}/i,
  /-----BEGIN [A-Z0-9 ]+ PRIVATE KEY-----/i,
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileSha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function regularSummaryFile(runDirectory, relativePath) {
  const root = path.resolve(runDirectory);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Archive summary path escapes the Run directory: ${relativePath}`);
  }

  let current = root;
  const parts = relative.split(path.sep);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let details;
    try {
      details = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    if (details.isSymbolicLink()) return null;
    if (index < parts.length - 1 && !details.isDirectory()) return null;
    if (index === parts.length - 1 && !details.isFile()) return null;
  }
  return current;
}

async function fileSummary(runDirectory, relativePath) {
  const filePath = await regularSummaryFile(runDirectory, relativePath);
  if (!filePath) return { present: false };
  const details = await lstat(filePath);
  return {
    present: true,
    bytes: details.size,
    sha256: await fileSha256(filePath),
  };
}

async function readJson(filePath) {
  const details = await lstat(filePath);
  if (!details.isFile()) throw new Error(`Archive summary is not a regular file: ${filePath}`);
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function discoverRunFiles(rootPath, { maxDepth = DEFAULT_MAX_DEPTH } = {}) {
  const root = path.resolve(rootPath);
  const discovered = [];

  async function visit(directory, depth) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isFile() && entry.name === RUN_FILE) {
        discovered.push(absolute);
        continue;
      }
      if (!entry.isDirectory() || entry.isSymbolicLink() || depth >= maxDepth) continue;
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      await visit(absolute, depth + 1);
    }
  }

  const rootDetails = await stat(root);
  if (!rootDetails.isDirectory()) throw new Error(`Archive root is not a directory: ${rootPath}`);
  await visit(root, 0);
  return [...new Set(discovered.map((item) => path.resolve(item)))].sort();
}

function finiteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeLabel(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value)) return null;
  return SENSITIVE_LABEL_PATTERNS.some((pattern) => pattern.test(value)) ? null : value;
}

function safeTimestamp(value) {
  const match = typeof value === "string"
    ? value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/)
    : null;
  if (!match) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const milliseconds = `${match[7] || ""}000`.slice(0, 3);
  const canonical = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${milliseconds}Z`;
  return new Date(parsed).toISOString() === canonical ? value : null;
}

function validateGeneratedAt(value) {
  const safe = safeTimestamp(value);
  if (!safe) throw new Error("generatedAt must be a valid ISO-8601 UTC timestamp");
  return safe;
}

function safeHash(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
}

function goalClass(goal = "") {
  const normalized = String(goal).toLowerCase();
  if (/large.?repository|kopiai|android|worker|multi.?module|大型仓库/.test(normalized)) return "large-repository-review";
  if (/macos|mac\s*compatib|平台兼容|兼容性/.test(normalized)) return "platform-compatibility-review";
  if (/sum function|queue path|debug|小型|修复/.test(normalized)) return "small-repair-or-debug";
  if (/audit|审计|review|检查|检查/.test(normalized)) return "repository-review";
  return "repository-engineering";
}

function nodeCounts(nodes) {
  const values = Array.isArray(nodes) ? nodes : Object.values(nodes || {});
  const counts = {};
  for (const node of values) {
    const status = safeLabel(node?.status || node?.state) || "unknown";
    counts[status] = (counts[status] || 0) + 1;
  }
  return {
    total: values.length,
    by_status: Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))),
  };
}

function blockerType(blocker) {
  if (!blocker || typeof blocker !== "object") return null;
  const type = safeLabel(blocker.type);
  if (type) return type;
  const budgetReason = safeLabel(blocker.budget_reason);
  if (budgetReason) return budgetReason;
  return "recorded";
}

function runBudget(run) {
  const configured = run.budget || {};
  const observed = configured.observed || {};
  return {
    max_tokens: finiteNumber(configured.max_tokens ?? observed.max_tokens),
    max_minutes: finiteNumber(configured.max_minutes ?? observed.max_minutes),
    max_attempts: positiveInteger(configured.max_attempts ?? observed.max_attempts),
    observed_tokens: finiteNumber(observed.observed_tokens),
    observed_attempts: positiveInteger(observed.attempts),
    process_ms: finiteNumber(observed.process_ms),
    process_minutes: finiteNumber(observed.process_minutes),
    token_overrun: finiteNumber(observed.token_overrun),
    time_overrun_minutes: finiteNumber(observed.time_overrun_minutes),
    usage_complete: observed.usage_complete === true,
    cost_known: observed.cost_known === true,
  };
}

async function archiveRun(runFile) {
  const runDirectory = path.dirname(runFile);
  const run = await readJson(runFile);
  const completionPath = path.join(runDirectory, "completion.json");
  let completion = null;
  try {
    completion = await readJson(completionPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const runId = String(run.run_id || run.id || path.basename(runDirectory));
  const goal = typeof run.goal === "string" ? run.goal : "";
  const sourceWorkspace = run.source_workspace || run.workspace || run.repository_root || "";
  const options = run.options || {};
  const status = safeLabel(run.status || completion?.status) || "unknown";
  const nodeSummary = nodeCounts(run.nodes);
  const files = {};
  for (const relativePath of SUMMARY_FILES) files[relativePath] = await fileSummary(runDirectory, relativePath);

  return {
    record_id: `run-${sha256(runId).slice(0, 16)}`,
    run_id_sha256: sha256(runId),
    workspace_identity_sha256: sourceWorkspace ? sha256(String(sourceWorkspace)) : null,
    graph_run_version: Number.isSafeInteger(run.version ?? completion?.version) ? run.version ?? completion?.version : null,
    status,
    goal_class: goalClass(goal),
    goal_sha256: safeHash(run.goal_sha256) || (goal ? sha256(goal) : null),
    agent_backend: safeLabel(options.agent_backend || run.agent_backend),
    model: safeLabel(options.model || options.codex_model || options.claude_model || run.model),
    reasoning_effort: safeLabel(options.reasoning_effort || run.reasoning_effort),
    workspace_mode: safeLabel(options.workspace_mode || run.workspace_mode),
    assurance: safeLabel(options.assurance || run.assurance),
    review_only: options.review_only === true || completion?.review_only === true,
    created_at: safeTimestamp(run.created_at || completion?.written_at),
    updated_at: safeTimestamp(run.updated_at || completion?.written_at),
    budget: runBudget(run),
    nodes: nodeSummary,
    files_changed_count: Array.isArray(run.files_changed) ? run.files_changed.length : null,
    unattributed_workspace_changes_count: Array.isArray(run.unattributed_workspace_changes)
      ? run.unattributed_workspace_changes.length
      : null,
    completion: {
      status: safeLabel(completion?.status) || status,
      review_completed: completion?.review_completed === true,
      release_ready: completion?.release_ready === true,
      application_ready: completion?.application_ready === true,
      has_blocker: Boolean(completion?.blocker || run.blocker),
      blocker_type: blockerType(completion?.blocker || run.blocker),
    },
    evidence_class: "operational_feedback_only",
    claim_ready: false,
    privacy: {
      raw_workspace_exported: false,
      raw_report_exported: false,
      absolute_paths_exported: false,
      report_bodies_exported: false,
    },
    files,
  };
}

async function buildArchive({ rootPaths, generatedAt = new Date().toISOString(), maxDepth = DEFAULT_MAX_DEPTH }) {
  if (!Array.isArray(rootPaths) || rootPaths.length === 0) throw new Error("At least one archive root is required");
  const safeGeneratedAt = validateGeneratedAt(generatedAt);
  const runFiles = (await Promise.all(rootPaths.map((root) => discoverRunFiles(root, { maxDepth })))).flat();
  const records = [];
  const warnings = [];
  for (const runFile of [...new Set(runFiles)].sort()) {
    try {
      records.push(await archiveRun(runFile));
    } catch (error) {
      warnings.push({ kind: "invalid_run_record", record_sha256: sha256(runFile), message: "record could not be parsed" });
    }
  }
  records.sort((left, right) => {
    const byTime = String(left.created_at || "").localeCompare(String(right.created_at || ""));
    return byTime || left.record_id.localeCompare(right.record_id);
  });
  const statusCounts = {};
  for (const record of records) statusCounts[record.status] = (statusCounts[record.status] || 0) + 1;
  return {
    schema_version: 1,
    type: "graph-real-run-archive-index",
    generated_at: safeGeneratedAt,
    redaction: "public-safe",
    source_policy: {
      roots_exported: false,
      raw_records_copied: false,
      raw_workspaces_copied: false,
      report_bodies_copied: false,
      absolute_paths_exported: false,
      secrets_and_credentials_exported: false,
    },
    evidence_policy: {
      class: "operational_feedback_only",
      claim_ready: false,
      reason: "These are individual real-repository runs, not a bound Graph-vs-baseline paired evaluation.",
    },
    counts: {
      discovered_run_files: runFiles.length,
      archived_records: records.length,
      invalid_records: warnings.length,
      by_status: Object.fromEntries(Object.entries(statusCounts).sort(([left], [right]) => left.localeCompare(right))),
    },
    warnings,
    records,
  };
}

function argumentValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values;
}

async function main() {
  const roots = argumentValues("--root");
  const output = argumentValues("--output")[0];
  const generatedAt = argumentValues("--generated-at")[0] || new Date().toISOString();
  const maxDepth = Number.parseInt(argumentValues("--max-depth")[0] || String(DEFAULT_MAX_DEPTH), 10);
  if (!roots.length || !output || !Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new Error("usage: node scripts/archive-run-records.mjs --root <dir> [--root <dir> ...] --output <index.json>");
  }
  const archive = await buildArchive({ rootPaths: roots, generatedAt, maxDepth });
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await writeFile(path.resolve(output), `${JSON.stringify(archive, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ status: "archived", ...archive.counts })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}

export { archiveRun, buildArchive, discoverRunFiles, fileSummary, goalClass, safeTimestamp, validateGeneratedAt };
