import path from "node:path";

const SHELL_OPTIONS = new Map([
  ["cmd", ["/c"]],
  ["cmd.exe", ["/c"]],
  ["powershell", ["-command", "-c"]],
  ["powershell.exe", ["-command", "-c"]],
  ["pwsh", ["-command", "-c"]],
  ["pwsh.exe", ["-command", "-c"]],
  // Codex command events on macOS are emitted through `/bin/zsh -lc`.
  // Keep the accepted forms explicit so shell wrappers remain single-command
  // evidence and cannot smuggle compound commands into a required check.
  ["bash", ["-c", "-lc", "-ic", "-ilc", "-lic"]],
  ["bash.exe", ["-c", "-lc", "-ic", "-ilc", "-lic"]],
  ["sh", ["-c", "-lc", "-ic", "-ilc", "-lic"]],
  ["sh.exe", ["-c", "-lc", "-ic", "-ilc", "-lic"]],
  ["zsh", ["-c", "-lc", "-ic", "-ilc", "-lic"]],
  ["zsh.exe", ["-c", "-lc", "-ic", "-ilc", "-lic"]],
  ["fish", ["-c"]],
  ["fish.exe", ["-c"]],
]);

function tokens(command) {
  const source = String(command || "").trim();
  if (!source) return [];
  const output = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const character of source) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote === '"') {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        output.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (quote || escaped) return null;
  if (current) output.push(current);
  return output;
}

function basename(value) {
  return path.basename(String(value || "").replace(/^['"]|['"]$/g, "")).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
}

export function unwrapShellCommand(command) {
  const parts = tokens(command);
  if (!parts) return null;
  if (parts.length < 3) return null;
  const options = SHELL_OPTIONS.get(basename(parts[0]));
  if (!options) return null;
  const optionIndex = parts.findIndex((token, index) => index > 0 && options.includes(token.toLowerCase()));
  if (optionIndex < 0 || optionIndex >= parts.length - 1) return null;
  const inner = parts.slice(optionIndex + 1).join(" ");
  return hasUnsafeShellOperator(inner) ? null : inner;
}

function hasUnsafeShellOperator(command) {
  let quote = null;
  let escaped = false;
  for (const character of String(command || "")) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote === '"') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (["&", "|", ";", "<", ">", "`", "\n", "\r"].includes(character)) return true;
  }
  return Boolean(quote || escaped);
}

export function normalizeCommand(command) {
  return String(command || "")
    .trim()
    .replace(/\\{2,}/g, "\\")
    .replace(/\\"/g, '"')
    .replace(/\s+/g, " ");
}

function sameCommand(left, right) {
  const canonical = (command, depth = 0) => {
    if (depth > 2) return null;
    const parts = tokens(normalizeCommand(command));
    if (!parts || !parts.length) return null;
    const options = SHELL_OPTIONS.get(basename(parts[0]));
    if (options) {
      const optionIndex = parts.findIndex((token, index) => index > 0 && options.includes(token.toLowerCase()));
      if (optionIndex < 0 || optionIndex >= parts.length - 1) return null;
      const inner = parts.slice(optionIndex + 1).join(" ");
      if (hasUnsafeShellOperator(inner)) return null;
      return canonical(inner, depth + 1);
    }
    return parts.map((part, index) => index === 0 ? basename(part) : part);
  };
  const a = canonical(left);
  const b = canonical(right);
  return Boolean(a && b && JSON.stringify(a) === JSON.stringify(b));
}

export function commandMatches(required, observed) {
  return sameCommand(required, observed);
}

function checkId(value) {
  return value?.check_id || value?.checkId || value?.id || null;
}

function successfulCommand(command) {
  return command?.exit_code === 0 && !["blocked", "declined", "error", "failed", "rejected"].includes(String(command?.status || "").toLowerCase());
}

function blockingScope(required) {
  const value = String(required?.blocking_scope || "both").trim().toLowerCase();
  return ["both", "apply", "release"].includes(value) ? value : "both";
}

/**
 * Evaluate required checks only from host-observed commands/tools. Claims are
 * used to attach evidence text, never to turn a failed host command into pass.
 */
export function evaluateRequiredChecks(requiredChecks = [], {
  commands = [],
  toolCalls = [],
  claims = [],
  sourceGit = null,
} = {}) {
  const claimed = new Map((claims || []).map((item) => [checkId(item), item]));
  const successfulTools = new Set((toolCalls || [])
    .filter((tool) => ["completed", "success", "succeeded"].includes(String(tool.status || "").toLowerCase()))
    .map((tool) => tool.name));
  const checks = (requiredChecks || []).map((required) => {
    const id = checkId(required);
    const claim = claimed.get(id);
    if (required.source_evidence === "source_git_snapshot") {
      const pass = sourceGit?.available === true;
      return {
        id,
        status: pass ? "pass" : "missing",
        blocking_scope: blockingScope(required),
        environment_required: required.environment_required === true,
        environment_kind: required.environment_kind || null,
        evidence: pass
          ? claim?.evidence || `source Git snapshot observed at ${sourceGit.observed_at || "run launch"}`
          : claim?.evidence || null,
        observed_source: pass ? "source_git_snapshot" : null,
        reason: pass ? "source Git snapshot observed at run launch" : "no source Git snapshot available",
      };
    }
    const candidates = [required.command, ...(required.equivalent_commands || [])].filter(Boolean);
    if (required.command === null || required.command === undefined) {
      const pass = Boolean(required.evidence_tool && successfulTools.has(required.evidence_tool));
      return {
        id,
        status: pass ? "pass" : "missing",
        blocking_scope: blockingScope(required),
        environment_required: required.environment_required === true,
        environment_kind: required.environment_kind || null,
        evidence: claim?.evidence || null,
        observed_tool: pass ? required.evidence_tool : null,
        reason: pass ? "successful evidence tool observed" : `missing successful evidence tool ${required.evidence_tool || "unknown"}`,
      };
    }
    const observed = (commands || []).find((item) => {
      if (!successfulCommand(item)) return false;
      return candidates.some((candidate) => commandMatches(candidate, item.command));
    });
    const pass = Boolean(claim?.status === "pass" && claim?.evidence && observed);
    return {
      id,
      status: pass ? "pass" : observed ? "claim_missing" : "missing",
      blocking_scope: blockingScope(required),
      environment_required: required.environment_required === true,
      environment_kind: required.environment_kind || null,
      evidence: claim?.evidence || null,
      observed_command: observed?.command || null,
      reason: pass ? "successful host command and claim observed" : observed ? "host command passed but claim is incomplete" : "no matching successful host command",
    };
  });
  const gaps = checks.filter((check) => check.status !== "pass");
  // A `both` check is required to declare the repository-local work complete;
  // an `apply` check may leave the run complete but must still stop result
  // application. Release-only checks are reported separately.
  const completionGaps = gaps.filter((check) => check.blocking_scope === "both");
  const applicationGaps = gaps.filter((check) => check.blocking_scope !== "release");
  const releaseGaps = gaps.filter((check) => ["both", "release"].includes(check.blocking_scope));
  return {
    // `pass` retains the strict all-checks result for reporting and legacy
    // callers. `blocking_pass` remains the historical application gate;
    // completion and release have explicit scopes below.
    pass: gaps.length === 0,
    blocking_pass: applicationGaps.length === 0,
    completion_pass: completionGaps.length === 0,
    application_pass: applicationGaps.length === 0,
    release_pass: releaseGaps.length === 0,
    checks,
    gaps,
    completion_gaps: completionGaps,
    blocking_gaps: applicationGaps,
    application_gaps: applicationGaps,
    release_gaps: releaseGaps,
  };
}
