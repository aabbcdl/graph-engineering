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

## Baseline failure classification (resolved)

- `a required command counts when it runs inside an exit-code-capturing wrapper`: resolved under the approved strict contract (extra wrapper commands are rejected).
- `a paraphrased command claim is accepted while a fabricated one is not`: resolved under exact normalized argv or explicit `equivalent_commands`.
- Six Graph lifecycle tests exiting code `2` with `completed_with_gaps`: resolved; the partial outcome was the intended blocked-item semantics and the fixtures were updated to assert it.

## Checkpoint policy

The v0.3 control-plane work was committed and pushed to `origin/main` (`92e3b59`) after explicit owner approval on 2026-08-22. Later tail work follows the same rule: commit only with current owner approval.
