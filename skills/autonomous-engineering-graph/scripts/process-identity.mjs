import { spawnSync } from "node:child_process";
import path from "node:path";

const IDENTITY_TOLERANCE_MS = 5_000;
const identityCache = new Map();

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
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; ` +
    "if ($null -ne $p) { " +
    "$started = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds(); " +
    "[pscustomobject]@{ started_at_ms = $started; command_line = [string]$p.CommandLine; executable = [string]$p.ExecutablePath } " +
    "| ConvertTo-Json -Compress }";
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const parsed = JSON.parse(result.stdout.trim());
  return {
    pid,
    started_at_ms: Number.isFinite(Number(parsed.started_at_ms)) ? Number(parsed.started_at_ms) : null,
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
  const value = identity || { pid, started_at_ms: null, command_line: null, executable: null };
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
      process_started_at_ms: Number.isFinite(Number(parsed.process_started_at_ms))
        ? Number(parsed.process_started_at_ms)
        : null,
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
  if (!commandLine || !expectedPath) return true;
  const normalize = (value) => String(value).replace(/\\/g, "/").toLowerCase();
  const command = normalize(commandLine);
  const expected = normalize(expectedPath);
  return command.includes(expected) || command.includes(`/${path.basename(expected)}`);
}

export function processMatchesRecord(record, { expectedPath = null, refresh = false } = {}) {
  const pid = Number(record?.pid);
  const identity = processIdentity(pid, { refresh });
  if (!identity) return false;
  const expectedStartedAt = Number(record?.process_started_at_ms);
  if (Number.isFinite(expectedStartedAt) && Number.isFinite(identity.started_at_ms)) {
    if (Math.abs(identity.started_at_ms - expectedStartedAt) > IDENTITY_TOLERANCE_MS) return false;
  } else {
    const recordTime = Number(record?.record_time_ms);
    if (Number.isFinite(recordTime) && Number.isFinite(identity.started_at_ms)) {
      if (identity.started_at_ms > recordTime + IDENTITY_TOLERANCE_MS) return false;
    }
  }
  const requiredPath = expectedPath || record?.runner_path || null;
  return commandMatches(identity.command_line, requiredPath);
}

