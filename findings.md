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

## 2026-08-22 jobqueue fixture

- The approved second benchmark fixture is a standard-library-only Go job scheduler with eight packages and 23 seeded defects.
- The host PowerShell session does not resolve `go`, but the official Go 1.27.0 Windows amd64 archive was resumed into the ignored `.tmp/` directory, SHA-256 checked against `f0c0a0d33ba94f4d2c5dbc887334ce678b21813504ddb3aafcb06e60a5a667c4`, and extracted to `.tmp/go-toolchain`. Fixture checks will invoke that exact binary explicitly.
- The fixture must keep public tests green after seeding defects; hidden acceptance checks belong in `evals/fixtures/jobqueue.evaluator.mjs` and must not be copied into the fixture snapshot.
- TDD RED is recorded: after public contract tests were added, `D:/project/graph-engineering/.tmp/go-toolchain/bin/go.exe test ./...` failed only because the eight target packages had no implementation files. An initial relative binary invocation was corrected before counting the RED result.
- The seeded snapshot now has 23 deterministic hidden acceptance checks: 5 concurrency, 4 error handling, 4 boundary, 4 cross-module contract, 3 resource leak, and 3 semantic/documentation defects. Public `go build ./...` and `go test ./...` remain green.
- The truth file is bound in `evals/manifest.pilot-jobqueue.json` by canonical SHA-256 `5742cd408da425421868fa5d9a70e9ee827d7ff9bfe57cd807d574c0ffa76232`; pair-runner and scorer fail closed on mismatch.
- Fixture graders now require raw findings to carry `validated: true` before mapping a natural-language claim to a truth defect; a focused regression proves unvalidated hypotheses do not inflate recall or precision.
- The hidden Go evaluator originally used escaped newline literals and could not parse `go test -json` records. It now parses actual newline-delimited JSON, and each defect records an `observed` pass/fail-event guard; the fixture regression verifies all 23 seeded checks are observed and failing. Final evaluator suite: 35/35.
