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

## Baseline failure classification (resolved)

- `a required command counts when it runs inside an exit-code-capturing wrapper`: resolved under the approved strict contract (extra wrapper commands are rejected).
- `a paraphrased command claim is accepted while a fabricated one is not`: resolved under exact normalized argv or explicit `equivalent_commands`.
- Six Graph lifecycle tests exiting code `2` with `completed_with_gaps`: resolved; the partial outcome was the intended blocked-item semantics and the fixtures were updated to assert it.

## Checkpoint policy

The v0.3 control-plane work was committed and pushed to `origin/main` (`92e3b59`) after explicit owner approval on 2026-08-22. Later tail work follows the same rule: commit only with current owner approval.
