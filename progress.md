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
| `npm test` | exit 0 | exit 1; 240 tests, 232 passed, 8 failed | baseline captured; 2 failures are stale strict-command expectations and 6 integration fixtures return exit 2 under the new gates |
| `npm run test:eval` | exit 0 | pending after baseline | pending |
| `npm run validate` | exit 0 | pending after baseline | pending |

### Phase 2 - control-plane operations

- **Status:** in_progress
- Existing review caps and initial `preview`, `diff`, `apply`, `recheck`, `runs`, and `gc` command paths are present in `graph-runner.mjs`; capability matrix completeness, selective-apply/recheck contract coverage, and release semantics still need implementation and verification.

### Baseline failure classification

- `a required command counts when it runs inside an exit-code-capturing wrapper`: old test expects an extra command wrapper to pass; the approved contract now rejects extra commands.
- `a paraphrased command claim is accepted while a fabricated one is not`: old test expects paraphrased command text to pass; the approved contract now requires exact normalized argv or explicit `equivalent_commands`.
- Six Graph lifecycle tests exit with code `2` and report `completed_with_gaps`; root cause is not yet confirmed and must be diagnosed from their captured run artifacts before changing code.

## Error log

| Timestamp | Error | Attempt | Resolution |
|---|---|---:|---|
| 2026-08-21 | TDD skill path under `D:\ai-data` was absent | 1 | Used the available user-level skill path. |

## Checkpoint policy

No commits or pushes will be created because the worktree already contains user-owned changes. Progress is checkpointed in these files and by verified diffs/tests.
