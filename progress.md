# Progress log

## 2026-08-21

### Phase 1 - baseline and P1 correctness gates

- **Status:** completed; targeted post-change checks pass; full suite is deferred until the remaining phases settle.
- **Actions:** Loaded `using-superpowers`, `graph-engineering-quality`, `planning-with-files`, and user-level `tdd-workflow` instructions. Inspected current runner/runtime/preflight/apply/restore surfaces and preserved the dirty worktree.
- **Files:** `task_plan.md`, `findings.md`, `progress.md` created for execution state.
- **Baseline:** `npm test` 235/235 passed, exit 0; `npm run test:eval` 10/10 passed, exit 0; `npm run validate` 72 checks passed, exit 0.
- **TDD RED:** Added exact-command and forged-`check_id` regression; targeted runtime test failed 1/9 before implementation.
- **TDD GREEN:** Replaced substring matching with exact canonical token matching and fail-closed shell-wrapper parsing; targeted runtime test passed 9/9.
- **Files:** `skills/autonomous-engineering-graph/scripts/runtime/evidence-verifier.mjs`, `skills/autonomous-engineering-graph/scripts/tests/runtime.test.mjs`.
- **Outcome gate repair:** runtime work-item summaries now include dynamic correction/recheck nodes, mark resolved historical failures as `superseded`, omit skipped supervision nodes when supervision is off, and resolve an authorized synthesis gate without deleting its blocked evidence.
- **Regression updates:** strict wrapper/paraphrase tests now reject compound commands and accept only a single known shell wrapper or explicit `equivalent_commands`; recorded blocker tests now assert `completed_with_gaps` and exit code 2.
- **Targeted verification:** runtime `15/15`; strict command `2/2`; recorded blocker `1/1`; owner gate `1/1`; stage supervision correction `1/1`; implementation correction `1/1`; supervision-off correction `1/1`; isolated owner-gate resume `1/1`.

## Test results

| Test | Expected | Actual | Status |
|---|---|---|---|
| `npm test` | exit 0 | exit 0; 248 tests, 248 passed (2026-08-22, before CLI contract tail work) | pass |
| `npm run test:eval` | exit 0 | exit 0; 10/10 passed | pass |
| `npm run validate` | exit 0 | exit 0; 72 checks passed | pass |

## 2026-08-22

### Tail closure for the v0.3 control-plane session

- **Status:** completed; the 15-item plan is fully delivered.
- Committed and pushed the accumulated v0.3 work to `origin/main` as `92e3b59`.
- Added seven CLI contract tests for the operations that previously had no coverage: `preview` (read-only, no state residue, v3 shape), `runs` (listing, recoverable flags, usage, workspace filter), `diff` (added/modified/deleted/mode-only classification), `apply --dry-run` (eligibility and conflict checks without writes), `apply --file` (selective application, `partial_application` recording, `RunPartiallyApplied` event), `recheck` guard rails (scope, completion, review, metadata, drift), and the `recheck` `already-satisfied` fast path with zero model calls.
- Synced `task_plan.md`, `findings.md`, and this file to the verified final state.

### Evaluation trustworthiness and token analysis

- **Status:** completed (`35b9644`); see the harness binding, rejection classes, and cost-efficiency metrics sections in `evals/README.md`.
- Verified the owner's four corrections: the August pilots are Run v2 records (not current v3), each budget tier is its own 1/5 experiment with `claim_ready=false`, booking-ledger holds 6 truth defects in 55 source lines, and `92e3b59` spans 63 files (+18,659/-3,721).
- Rescoring an old pilot with the new scorer rejects its unbound pairs as `infrastructure` with the descriptive-history conclusion, as designed.
- Added `evals/scripts/analyze-run-tokens.mjs` and `docs/eval-token-analysis.md`: per-node/per-stage token breakdowns of both completed v2 pilots. Headline: output is 2-3% of cost; the clean run spends 38.7% in five review nodes and the corrected run spends 48% in the correction loop's full re-verification/re-review rounds; supervision nodes have zero cache hits.
- Drafted `docs/fixture-jobqueue-design.md`: a Go fixture-2 proposal (7 modules, ~2,700 lines, 20+ cross-module defects with category quotas frozen before any arm observation).

### Token optimization levers 1-2

- **Status:** implemented; verification below.
- Auto review-limit scaling (`effectiveReviewLimits` + `measureWorkspaceScale`): tiny workspaces (≤30 files, ≤256 KiB) shrink the review fan-out to the four required audit domains (or two review nodes for ordinary tasks) only when no `--max-review-nodes(-per-wave)`/`--max-total-review-nodes` was set; the flag `review_limits_explicit` is parsed, persisted in `run.options`, and merged conservatively on resume (legacy saved runs count as pinned). The decision and workspace measurements are recorded in `coverage.auto_review_scaling`, surfaced in `preview`, and never shrink an audit below its required domains.
- Incremental correction rounds: verification round ≥1 computes the previous round's unsatisfied checks (`unsatisfiedCheckIds`) and carries them as `incremental_check_ids`; `promptRequiredChecks`, the prompt heading, and the runner-side evaluation/environment classification all scope to that set; independent review round ≥1 narrows its focus to the previously flagged findings and changed surfaces while keeping full independent workspace access; the final summary fold-merges per-round `machine_check_evaluation` by check id (earlier recorded passes survive unless a later round re-ran the check).
- Lever 4 (supervision cache prefix) was analyzed and deliberately deferred: the zero cache hits come from supervision being single-turn no-tool nodes, which cannot produce multi-turn prefix reuse; reordering the prompt would be unverified speculation.
- Tests: extended the correction-resume test with incremental-round input assertions and the merged evaluation; added unit tests for `effectiveReviewLimits` (small/large/explicit/audit floor), `makeLoopNode`/`unsatisfiedCheckIds` scoping, and a full fake-Codex run asserting `coverage.auto_review_scaling` and the ≤2 review fan-out on a small workspace.

### Token optimization levers 3 and review input packing

- **Status:** implemented.
- Measured the v2 independent-review-r0 input composition (115KB: skills ~62KB, upstream verification result ~48.5KB, header ~4.6KB) before changing anything.
- Reviewer dependency slimming: `compactResultForDependency` now returns a machine-facts-first shape for `independent_review` consumers (finding identities for lineage, checks, changed files, and the runner-computed `machine_check_evaluation` statuses) and drops self-reported evidence prose, recommended actions, evidence anchors, and command transcripts; an `upstream_scope_note` tells the reviewer to re-derive evidence from the workspace. Other node kinds keep the previous compaction.
- Workspace file map: `workspaceFileMap` (bounded: 200 entries / 12KiB, skips .git/node_modules/build dirs) is injected into discovery and review prompts to front-load orientation and cut tool-loop re-listing.
- Tests: unit coverage for both (reviewer context shape vs unchanged correction context; map bounds and directory skipping).

### 2026-08-22 jobqueue fixture implementation

- **Status:** completed; repository-wide regression and diff review passed.
- Revalidated `docs/fixture-jobqueue-design.md`; implementation scope is Go, eight packages, 23 defects, standard library only.
- The missing host `go` was resolved without system installation: an official, SHA-256-verified Go 1.27.0 archive was extracted under ignored `.tmp/go-toolchain`. Future fixture checks use its absolute `go.exe` path explicitly.
- Added the fixture contract (`README.md`, `docs/contract.md`, `AGENTS.md`, `go.mod`) and public package tests before source implementation. Valid RED: `go test ./...` failed due to the intentionally absent package implementations. A first invocation used a fixture-relative toolchain path and failed before the test compiler ran; this was corrected and is not counted as TDD evidence.
- Implemented the clean standard-library baseline across `config`, `events`, `queue`, `retry`, `store`, `worker`, `scheduler`, `api`, and `cmd/jobqueue-demo`. Baseline GREEN: `go test ./...` and `go build ./...` both passed using `D:/project/graph-engineering/.tmp/go-toolchain/bin/go.exe`.
- Seeded all 23 frozen defects while keeping public Go checks green; hidden evaluator reports 23/23 unrepaired on the seeded snapshot.
- Added `evals/fixtures/jobqueue.truth.json`, `evals/fixtures/jobqueue.evaluator.mjs`, `evals/fixtures/jobqueue-hidden-tests/`, `evals/manifest.pilot-jobqueue.json`, and real-fixture tests. The pilot binds truth SHA-256 `5742cd408da425421868fa5d9a70e9ee827d7ff9bfe57cd807d574c0ffa76232` before arm launch.
- Go source is 2,235 lines across 18 files; `real-fixture.test.mjs` verifies public build/test, hidden-test cleanup, 23 defects, category quotas, and finding mapping.
- During final review, found that both fixture graders could map a matching but `validated: false` claim. Added a regression and changed both graders to require `validated: true`; focused fixture tests pass 8/8.
- Also fixed the JobQueue Go JSON-stream parser: it now splits real newline-delimited records and records whether every hidden acceptance test emitted an observable `pass`/`fail` event, preventing parser failures from being reported as ordinary unrepaired defects.
- A root-level `go vet ./...` attempt was a cwd mistake because the repository root is not a Go module; the corrected command in `evals/fixtures/jobqueue` passed. A PowerShell `rg ... ||` probe was also corrected to PowerShell-compatible control flow; neither affected repository state.
- Final verification after all corrections: `npm test` 260/260, `npm run test:eval` 35/35, `npm run validate` 72/72, `npm run validate:package` pass, `npm run test:package-smoke` pass, `npm pack --dry-run` 141 files, `.mjs` syntax 46/46, Go `build`/`vet`/`test` pass, and `git diff --check` pass.
- Diff review found only the approved fixture, harness, scorer, package, test, and planning/documentation changes; no obsolete truth hash remains. No commit, push, real-model evaluation, or Graph Run was started.

## Baseline failure classification (resolved)

- `a required command counts when it runs inside an exit-code-capturing wrapper`: resolved under the approved strict contract (extra wrapper commands are rejected).
- `a paraphrased command claim is accepted while a fabricated one is not`: resolved under exact normalized argv or explicit `equivalent_commands`.
- Six Graph lifecycle tests exiting code `2` with `completed_with_gaps`: resolved; the partial outcome was the intended blocked-item semantics and the fixtures were updated to assert it.

## Checkpoint policy

The v0.3 control-plane work was committed and pushed to `origin/main` (`92e3b59`) after explicit owner approval on 2026-08-22. Later tail work follows the same rule: commit only with current owner approval.
