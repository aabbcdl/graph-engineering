import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildArchive } from "../archive-run-records.mjs";

async function fixtureRun(root, { status = "completed", goal = "Fix the sum function" } = {}) {
  const runDirectory = path.join(root, "state", "workspace-hash", "20260830T000000.000Z-run-123");
  await mkdir(path.join(runDirectory, "events"), { recursive: true });
  await mkdir(path.join(runDirectory, "workspace"), { recursive: true });
  await writeFile(path.join(runDirectory, "workspace", "should-not-be-read.json"), JSON.stringify({ secret: "do-not-export" }));
  await writeFile(path.join(runDirectory, "run.json"), `${JSON.stringify({
    run_id: "20260830T000000.000Z-run-123",
    version: 3,
    status,
    goal,
    created_at: "2026-08-30T00:00:00.000Z",
    updated_at: "2026-08-30T00:01:00.000Z",
    workspace: "/private/tmp/private-project",
    options: {
      agent_backend: "codex",
      model: "test-model",
      reasoning_effort: "medium",
      workspace_mode: "copy",
      assurance: "standard",
    },
    budget: {
      max_tokens: 1000,
      max_minutes: 10,
      max_attempts: 3,
      observed: {
        observed_tokens: 700,
        attempts: 1,
        process_ms: 1200,
        process_minutes: 0.02,
        usage_complete: true,
        cost_known: false,
      },
    },
    nodes: {
      planner: { status: "completed" },
      review: { status: "pending" },
    },
    files_changed: ["src/private.js"],
  }, null, 2)}\n`);
  await writeFile(path.join(runDirectory, "completion.json"), `${JSON.stringify({
    version: 3,
    status,
    review_only: true,
    review_completed: status === "completed",
    release_ready: false,
    application_ready: false,
    blocker: status === "completed" ? null : { type: "RUN_BUDGET_EXHAUSTED", reason: "/private/tmp/private-project" },
  })}\n`);
  await writeFile(path.join(runDirectory, "runtime-state.json"), "{\"status\":\"safe\"}\n");
  await writeFile(path.join(runDirectory, "report.md"), "PRIVATE REPORT BODY AND /private/tmp/private-project\n");
  await writeFile(path.join(runDirectory, "events", "events.jsonl"), "{\"type\":\"WorkItemStarted\"}\n");
  return runDirectory;
}

test("buildArchive creates a deterministic public-safe index without exporting workspace or report content", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aeg-archive-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fixtureRun(root);
  await mkdir(path.join(root, "workspace"), { recursive: true });
  await writeFile(path.join(root, "workspace", "run.json"), "{\"status\":\"malicious-nested-record\"}\n");

  const archive = await buildArchive({ rootPaths: [root], generatedAt: "2026-08-30T00:02:00.000Z" });
  assert.equal(archive.counts.discovered_run_files, 1);
  assert.equal(archive.counts.archived_records, 1);
  assert.deepEqual(archive.counts.by_status, { completed: 1 });
  assert.equal(archive.redaction, "public-safe");
  assert.equal(archive.source_policy.raw_workspaces_copied, false);
  assert.equal(archive.records[0].goal_class, "small-repair-or-debug");
  assert.equal(archive.records[0].agent_backend, "codex");
  assert.equal(archive.records[0].nodes.by_status.completed, 1);
  assert.equal(archive.records[0].nodes.by_status.pending, 1);
  assert.equal(archive.records[0].budget.observed_tokens, 700);
  assert.equal(archive.records[0].files["report.md"].present, true);

  const serialized = JSON.stringify(archive);
  assert.doesNotMatch(serialized, /private-project|PRIVATE REPORT BODY|do-not-export|20260830T000000/);
  assert.doesNotMatch(serialized, /\/private\/tmp|\/Users\//);
});

test("buildArchive preserves incomplete operational outcomes without turning them into claims", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aeg-archive-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fixtureRun(root, { status: "waiting_budget", goal: "Read-only large-repository smoke review" });
  const archive = await buildArchive({ rootPaths: [root], generatedAt: "2026-08-30T00:02:00.000Z" });
  const record = archive.records[0];
  assert.equal(record.status, "waiting_budget");
  assert.equal(record.completion.has_blocker, true);
  assert.equal(record.completion.blocker_type, "RUN_BUDGET_EXHAUSTED");
  assert.equal(record.evidence_class, "operational_feedback_only");
  assert.equal(record.claim_ready, false);
  assert.equal(archive.evidence_policy.claim_ready, false);
});

test("archive metadata rejects path-shaped labels and symlinked summary files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aeg-archive-test-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "aeg-archive-outside-"));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  const runDirectory = await fixtureRun(root, { status: "completed", goal: "Audit repository" });
  const run = JSON.parse(await readFile(path.join(runDirectory, "run.json"), "utf8"));
  run.options.model = `sk-${"a".repeat(40)}`;
  run.options.agent_backend = `github_pat_${"b".repeat(24)}`;
  run.nodes.planner.status = "/private/tmp/secret-status";
  await writeFile(path.join(runDirectory, "run.json"), `${JSON.stringify(run)}\n`);
  await symlink("/etc/hosts", path.join(runDirectory, "graph.json"));
  await writeFile(path.join(outside, "events.jsonl"), "outside evidence must not be hashed\n", "utf8");
  await rm(path.join(runDirectory, "events"), { recursive: true, force: true });
  await symlink(outside, path.join(runDirectory, "events"));

  const archive = await buildArchive({ rootPaths: [root], generatedAt: "2026-08-30T00:02:00.000Z" });
  const record = archive.records[0];
  assert.equal(record.model, null);
  assert.equal(record.agent_backend, null);
  assert.equal(record.completion.status, "completed");
  assert.equal(record.nodes.by_status.unknown, 1);
  assert.equal(record.files["graph.json"].present, false);
  assert.equal(record.files["events/events.jsonl"].present, false);
  assert.doesNotMatch(JSON.stringify(archive), /sk-aaaaaaaa|github_pat_bbbb|codex\/backend/);
});

test("archive generatedAt accepts only a valid ISO UTC timestamp", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aeg-archive-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fixtureRun(root);
  await assert.rejects(
    buildArchive({ rootPaths: [root], generatedAt: "/Users/example-user/private-archive/index.json" }),
    /generatedAt must be a valid ISO-8601 UTC timestamp/,
  );
  await assert.rejects(
    buildArchive({ rootPaths: [root], generatedAt: "2026-02-30T00:00:00.000Z" }),
    /generatedAt must be a valid ISO-8601 UTC timestamp/,
  );
  const archive = await buildArchive({ rootPaths: [root], generatedAt: "2026-08-31T00:00:00.000Z" });
  assert.equal(archive.generated_at, "2026-08-31T00:00:00.000Z");
  const withoutMilliseconds = await buildArchive({ rootPaths: [root], generatedAt: "2026-08-31T00:00:00Z" });
  assert.equal(withoutMilliseconds.generated_at, "2026-08-31T00:00:00Z");
});
