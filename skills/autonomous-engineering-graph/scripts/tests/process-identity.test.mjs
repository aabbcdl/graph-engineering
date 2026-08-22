import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyProcessRecord,
  matchesProcessIdentity,
  parseProcessRecord,
  processIdentity,
  processMatchesRecord,
} from "../process-identity.mjs";

test("a live PID with unavailable identity is unknown rather than stale", () => {
  const record = {
    pid: 4242,
    process_started_at_ms: 1_700_000_000_000,
    runner_path: "graph-runner.mjs",
  };
  assert.equal(classifyProcessRecord(record, { alive: true, identity: null }), "unknown");
  assert.equal(classifyProcessRecord(record, { alive: false, identity: null }), "dead");
  assert.equal(classifyProcessRecord(record, {
    alive: true,
    identity: {
      pid: record.pid,
      started_at_ms: record.process_started_at_ms + 60_000,
      command_line: "node graph-runner.mjs",
      executable: null,
    },
  }), "mismatch");
  assert.equal(classifyProcessRecord(record, {
    alive: true,
    identity: {
      pid: record.pid,
      started_at_ms: record.process_started_at_ms,
      command_line: "node graph-runner.mjs",
      executable: null,
    },
  }), "match");
});

test("an uninspectable live PID is not accepted as the owner of a lock", () => {
  const record = {
    pid: 4242,
    process_started_at_ms: 1_700_000_000_000,
    runner_path: "graph-runner.mjs",
  };
  assert.equal(matchesProcessIdentity(record, {
    pid: record.pid,
    started_at_ms: null,
    command_line: null,
    executable: null,
  }), false);
  assert.equal(matchesProcessIdentity(record, {
    pid: record.pid,
    started_at_ms: record.process_started_at_ms,
    command_line: "node unrelated-worker.mjs",
    executable: null,
  }), false);
});

test("a reused PID with a different start time is rejected", () => {
  const identity = processIdentity(process.pid, { refresh: true });
  if (!identity?.started_at_ms) return;
  assert.equal(processMatchesRecord({
    pid: process.pid,
    process_started_at_ms: identity.started_at_ms + 60_000,
    runner_path: "graph-runner.mjs",
  }, { refresh: true }), false);
});

test("a legacy record without a start timestamp uses record time and path", () => {
  const recordTime = Date.parse("2026-08-18T12:00:00.000Z");
  const record = parseProcessRecord(JSON.stringify({
    pid: 123,
    process_started_at_ms: null,
    runner_path: "C:/graph/graph-runner.mjs",
    acquired_at: new Date(recordTime).toISOString(),
  }));
  assert.equal(record.process_started_at_ms, null);
  assert.equal(matchesProcessIdentity(record, {
    pid: record.pid,
    started_at_ms: Date.parse("2026-08-18T11:59:00.000Z"),
    command_line: "node C:/graph/graph-runner.mjs",
    executable: null,
  }), true);
});
