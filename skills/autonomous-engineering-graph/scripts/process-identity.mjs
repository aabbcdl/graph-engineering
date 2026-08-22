import { spawnSync } from "node:child_process";
import path from "node:path";

const IDENTITY_TOLERANCE_MS = 5_000;
const identityCache = new Map();

function optionalFiniteNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function windowsProcessIdentity(pid) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script =
    `$p = $null; ` +
    `try { $p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop } catch { } ` +
    "if ($null -ne $p) { " +
    "$started = $null; try { $started = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() } catch { } " +
    "[pscustomobject]@{ started_at_ms = $started; command_line = [string]$p.CommandLine; executable = [string]$p.ExecutablePath } " +
    "| ConvertTo-Json -Compress } else { " +
    `$fallback = $null; try { $fallback = Get-Process -Id ${pid} -ErrorAction Stop } catch { } ` +
    "if ($null -ne $fallback) { " +
    "$started = $null; try { $started = ([DateTimeOffset]$fallback.StartTime).ToUnixTimeMilliseconds() } catch { } " +
    "[pscustomobject]@{ started_at_ms = $started; command_line = $null; executable = [string]$fallback.Path } | ConvertTo-Json -Compress } }";
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const parsed = JSON.parse(result.stdout.trim());
  return {
    pid,
    started_at_ms: optionalFiniteNumber(parsed.started_at_ms),
    command_line: parsed.command_line || null,
    executable: parsed.executable || null,
  };
}

function posixProcessIdentity(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], {
    encoding: "utf8",
    timeout: 5_000,
  });
  const output = result.stdout.trim();
  if (result.status !== 0 || !output) return null;
  const startedText = output.slice(0, 24).trim();
  const startedAt = Date.parse(startedText);
  return {
    pid,
    started_at_ms: Number.isFinite(startedAt) ? startedAt : null,
    command_line: output.slice(24).trim() || null,
    executable: null,
  };
}

export function processIdentity(pid, { refresh = false } = {}) {
  if (!processIsAlive(pid)) return null;
  const cached = identityCache.get(pid);
  if (!refresh && cached && Date.now() - cached.observed_at_ms < 1_000) return cached.identity;
  let identity = null;
  try {
    identity = process.platform === "win32" ? windowsProcessIdentity(pid) : posixProcessIdentity(pid);
  } catch {
    identity = null;
  }
  const value = identity && (
    optionalFiniteNumber(identity.started_at_ms) !== null ||
    Boolean(identity.command_line || identity.executable)
  )
    ? identity
    : null;
  identityCache.set(pid, { observed_at_ms: Date.now(), identity: value });
  return value;
}

export function currentProcessStartedAtMs() {
  return Math.round(Date.now() - process.uptime() * 1_000);
}

export function parseProcessRecord(contents, fallbackTimestampMs = null) {
  const text = String(contents || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return {
      ...parsed,
      pid: Number(parsed.pid),
      process_started_at_ms: optionalFiniteNumber(parsed.process_started_at_ms),
      record_time_ms: Date.parse(parsed.acquired_at || parsed.queued_at || parsed.created_at || "") || fallbackTimestampMs,
    };
  } catch {
    const lines = text.split(/\r?\n/);
    return {
      version: 1,
      pid: Number.parseInt(lines[0], 10),
      process_started_at_ms: null,
      record_time_ms: Date.parse(lines[1] || "") || fallbackTimestampMs,
      runner_path: null,
    };
  }
}

function commandMatches(commandLine, expectedPath) {
  if (!expectedPath) return true;
  if (!commandLine) return false;
  const normalize = (value) => String(value).replace(/\\/g, "/").toLowerCase();
  const command = normalize(commandLine);
  const expected = normalize(expectedPath);
  return command.includes(expected) || command.includes(`/${path.basename(expected)}`);
}

function identityPathState(identity, expectedPath) {
  if (identity?.command_line) {
    return expectedPath && !commandMatches(identity.command_line, expectedPath) ? "mismatch" : "match";
  }
  if (identity?.executable) {
    // A process executable can identify an executable owner, but it cannot
    // prove which JavaScript entrypoint that executable started. Treat that
    // partial observation as unknown instead of reclaiming a live lock.
    if (!expectedPath) return "match";
    const normalizedExpected = String(expectedPath).replace(/\\/g, "/").toLowerCase();
    const expectedExtension = path.extname(normalizedExpected);
    if (expectedExtension && ![".exe", ".com", ".cmd", ".bin"].includes(expectedExtension)) return "unknown";
    return commandMatches(identity.executable, expectedPath) ? "match" : "mismatch";
  }
  return "unknown";
}

function classifyObservedProcessIdentity(record, identity, { expectedPath = null } = {}) {
  if (!identity) return "unknown";
  const expectedStartedAt = optionalFiniteNumber(record?.process_started_at_ms);
  const actualStartedAt = optionalFiniteNumber(identity.started_at_ms);
  const hasActualStartedAt = actualStartedAt !== null;
  const requiredPath = expectedPath || record?.runner_path || null;
  if (expectedStartedAt !== null) {
    // A start timestamp is authoritative only when the host returned one.
    if (!hasActualStartedAt) return "unknown";
    if (Math.abs(actualStartedAt - expectedStartedAt) > IDENTITY_TOLERANCE_MS) return "mismatch";
    return identityPathState(identity, requiredPath);
  }
  const recordTime = optionalFiniteNumber(record?.record_time_ms);
  if (recordTime !== null && hasActualStartedAt && actualStartedAt > recordTime + IDENTITY_TOLERANCE_MS) {
    return "mismatch";
  }
  return identityPathState(identity, requiredPath);
}

/**
 * Classify a process record without collapsing a live-but-uninspectable PID
 * into the stale state. This pure form is also used by regression tests.
 */
export function classifyProcessRecord(record, { alive = null, identity = undefined, expectedPath = null } = {}) {
  const pid = Number(record?.pid);
  const isAlive = alive === null ? processIsAlive(pid) : Boolean(alive);
  if (!isAlive) return "dead";
  const observed = identity === undefined ? processIdentity(pid, { refresh: true }) : identity;
  return classifyObservedProcessIdentity(record, observed, { expectedPath });
}

export function processRecordState(record, { expectedPath = null, refresh = false } = {}) {
  const pid = Number(record?.pid);
  if (!processIsAlive(pid)) return "dead";
  const identity = processIdentity(pid, { refresh });
  return classifyObservedProcessIdentity(record, identity, { expectedPath });
}

export function matchesProcessIdentity(record, identity, { expectedPath = null } = {}) {
  return classifyObservedProcessIdentity(record, identity, { expectedPath }) === "match";
}

export function processMatchesRecord(record, { expectedPath = null, refresh = false } = {}) {
  return processRecordState(record, { expectedPath, refresh }) === "match";
}
