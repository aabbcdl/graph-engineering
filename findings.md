# Findings and decisions

## Current repository evidence

- Main runner: `skills/autonomous-engineering-graph/scripts/graph-runner.mjs`.
- Runtime modules already exist for state, event log, summaries, artifact storage, and evidence verification.
- `runtime/evidence-verifier.mjs` currently accepts bidirectional substring matches.
- `runtime/state-model.mjs` does not include required audit-domain completion in `deriveRunOutcome()`.
- `runtime/event-log.mjs` reads the complete `events.jsonl` before every append and read.
- `workspace-preflight.mjs` currently implements Node package-manager preparation only.
- `restore-run.mjs` does not compare or restore mode-only changes.
- `apply-results.mjs` already provides transactional apply, conflict checks, and rollback.
- The worktree contains extensive user-owned uncommitted changes. All implementation must layer on top of them.

## Approved public decisions

- Run schema version 3 with lazy v1/v2 migration.
- `waiting_budget` is a resumable terminal state.
- New commands: `preview`, `diff`, `apply`, `recheck`, `runs`, and `gc`.
- New ecosystems: Node, Python, Go, Rust, Java, and .NET.
- Soft state warning at 20 GiB; GC is preview-first and explicit.
- No runtime dependency additions.

## Coverage gaps to verify during implementation

- Existing planner and node schemas must remain compatible with normalized coverage fields.
- Existing result-package and recovery-package copies must remain self-contained.
- Current tests may already contain partial fixes; each task must be revalidated against current code.

## 2026-08-22 baseline diagnosis in progress

- The current full suite has 8 failures after the persisted P1 changes. Two are directly stale assertions for the newly approved strict command contract.
- Six lifecycle fixtures return `completed_with_gaps` with exit code `2` although their default fake planner uses `mode: task`; inspect the persisted run budget and assurance snapshots before deciding whether the fixture or runner is wrong.
- Do not relax the new outcome gates to restore old fixture expectations. The fixture must provide evidence that the new public contract requires, or the test must assert the intended partial outcome.
- A retained `recorded-blocker` Run has `budget.pass=true`, `usage_complete=true`, `required_domains_complete=true`, and a single blocked review work item; its partial outcome is therefore caused by the intended blocked-item rule, not the budget controller.
