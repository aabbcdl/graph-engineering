# Findings and decisions

## Current repository evidence (verified 2026-08-22)

- Main runner: `skills/autonomous-engineering-graph/scripts/graph-runner.mjs` (still the orchestration monolith; `runtime/` extraction is the next structural step).
- `runtime/evidence-verifier.mjs` now requires exact normalized argv matching and rejects fabricated `check_id` claims.
- `runtime/state-model.mjs` includes audit-domain completion, assurance, and budget gates in `deriveRunOutcome()`.
- `runtime/event-log.mjs` maintains a sparse head/index and lazily rebuilds legacy metadata.
- `workspace-preflight.mjs` covers Node, Python, Go, Rust, Java, and .NET lock inputs.
- `restore-run.mjs` restores mode, kind, and link-target differences.
- `apply-results.mjs` provides transactional apply, conflict checks, rollback, dry-run, and selective `--file` application.
- The v0.3 work is committed on `origin/main` (`92e3b59`); the working tree is clean apart from tracked status-file updates.

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

## 2026-08-22 baseline diagnosis (closed)

- The eight failures recorded on 2026-08-21 were resolved: two were stale assertions under the strict command contract, and six lifecycle fixtures were asserting the old full-success outcome where `completed_with_gaps` (exit 2) is the intended blocked-item semantics. The full suite passed 248/248 before the CLI contract tests were added, and no outcome gate was relaxed.
