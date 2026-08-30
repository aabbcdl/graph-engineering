# Progress log

## Current authoritative status (2026-08-30)

- Mac Apple Silicon is the primary supported path; the deterministic CI matrix is Ubuntu + `macos-14`. Windows protected smoke remains outside the Mac release gate.
- Public NPM `0.3.0` and public GitHub `main` are already present. This closeout prepares a traceable `0.3.1` patch for cross-platform test execution and CI reliability.
- The previous public CI run was red for two environment/entrypoint assumptions, not for Graph runtime behavior; both are now covered by deterministic fixes.
- Windows protected real-agent smoke remains optional and external to the Mac workflow. Graph-vs-baseline effectiveness remains unclaimed until five comparable pairs exist.
- Real-repository runs reported during development are not converted into release evidence unless their Run artifacts can be located and independently checked.

## 2026-08-30 public CI correction

- The first three-platform attempt exposed two separate environmental facts: GitHub `macos-14` uses the official Go 1.27.0 arm64 binary, while the old Darwin hash was from a Homebrew rebuild; Windows still has 15 path/isolation-specific test failures beyond shell glob expansion.
- The evaluator now pins the official Darwin arm64 hash. Windows protected smoke remains an external `UNKNOWN` gate, and the public Mac release matrix is intentionally limited to Ubuntu + macOS 14.

## 2026-08-30 closeout verification (local)

- `npm test`: exit 0; 302 tests, 296 passed, 6 skipped, 0 failed.
- `npm run test:eval`: 45/45; `npm run validate`: 72/72; `npm run validate:package`: 67 files, 17 shipped `.mjs`, 0 denied paths.
- `npm run test:package-smoke` and `npm run release:check`: both pass; package smoke exercised the public NPM bin on `darwin-arm64`.
- The only remaining release actions are external: push the verified commit, observe public CI, publish NPM `0.3.1`, and create/push tags and GitHub Releases. Windows real-agent smoke remains a separate optional environment gate.

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

### First-principles product-fit hardening pass started

- Re-read the existing plan and current repository state; `main` at `51571c0`, clean, no commit/push authorized.
- Confirmed scope: local code/tests/docs only; no Graph run, real model pilot, release, or remote write.
- Next: add targeted RED tests for the five remaining operational-contract gaps before production edits.

### 2026-08-23 closure implementation

- Added RED coverage for Claude capability path consistency, concurrent probe merging, fake-agent-bound test bypass, Chinese audit inference, evaluation contract identity, and npm package boundary.
- Implemented the corresponding runner/harness/package fixes. Focused GREEN checks pass; the intermediate package check reported 69 files and excludes `evals/`.
- Manual read-only checks confirm Chinese audit preview selects `mode=audit`, four required domains, and high assurance without state residue; the local Codex doctor correctly remains blocked until protected sandbox smoke records exist.
- At this checkpoint full post-change verification was still running; the terminal results and unchanged authorization boundary are recorded in the final closure audit below.

## 2026-08-23 final closure audit

- Found and fixed a gate-critical installability defect during final verification. The npm tarball had omitted all `agents/` and `references/` descendants because the `files` globs named directories without recursive `/**`; installed `graph-runner.mjs` failed before argument parsing with `ENOENT` for `specialist-pack.json`.
- Added `skills/autonomous-engineering-graph/scripts/tests/package-contract.test.mjs` and confirmed the intended RED failure before changing package metadata. `package.json` now includes recursive production directories, and `scripts/validate-package.mjs` derives required paths from `specialist-pack.json`.
- Final commands and terminal results before the strict probe closure: `npm test` exit 0 (270/270, 830049.9084ms); `npm run test:eval` exit 0 (40/40); `npm run validate` exit 0 (72 checks); `npm run validate:package` exit 0 (69 files, 21 shipped `.mjs`, 0 denied paths); `npm run test:package-smoke` exit 0; `npm pack --dry-run` reports 69 files, 18 references, 8 agents, 0 `evals/`, 0 `scripts/tests/`; `git diff --check` exit 0; source `help` and Chinese audit `preview` pass.
- Strict sandbox-probe closure then completed: `npm test` exit 0 (272/272); the two new tests require target-specific `sandbox_write_denied` evidence and recognize caught PowerShell/.NET write denials; affected smoke scripts pass syntax checks.
- `doctor --agent-backend codex --json` intentionally exits 2 with installed/invocable Codex but unverified read-only and workspace-write sandbox probes. No real-agent smoke, current Run v3 paired model pilot, Graph Run, commit, push, deploy, or publish was run. Existing reports remain descriptive (`claim_ready=false`).

### TDD RED evidence

- Added regressions for standard-library Go modules, external Go requirements, preflight readiness semantics, strict capability doctor, audit preview mode/assurance, package hidden-boundary, and the pilot budget/toolchain contract.
- RED confirmed: `graph-runner.test.mjs` fails at module instantiation because the planned `agentCapabilityDoctor` export is absent; `adapter-common.test.mjs` fails because `manifest.budget_contract` is absent. The real-fixture package-contract test is still running its existing evaluator cases and will be recorded after completion.

### Product-fit hardening implementation

- Go preflight now parses `go.mod` requirements and treats a no-external-requirement module without `go.sum` as `stdlib-only`/ready with no restore action; external requirements without `go.sum` remain `missing-lock`.
- All preflight records expose `status` plus `readiness` and `ready`; reports persist the distinction and list environment gaps.
- Added strict `doctor`, first-start/submit/resume capability gating, generic v2 backend capability records, exact runner/binary identity, and Codex read/write smoke workflow coverage. `AEG_TEST_MODE=1` is forwarded only to controlled test children; the doctor CLI explicitly disables that override.
- npm package allowlist now excludes `evals/fixtures`, hidden tests, evaluator modules, truth, and pilot manifests; package validator rejects those paths.
- JobQueue evaluator pins Go 1.27.0 and the Windows amd64 binary SHA-256, and the pilot declares a hard aggregate budget contract. Both graph and baseline adapters report the contract; baseline uses the runner's streaming token guard.
- Preview infers audit goals, applies the four-domain floor, and routes `assurance=auto` to high for audit plans. Docs cover the new operational contracts.

### Verification observations

- Targeted GREEN: 7 new Graph regressions, 3 package/manifest regressions, 24 pair/scorer tests, JobQueue real fixture (23/23 observed), `validate:package`, and `validate` all pass.
- First full `npm test` after implementation: 261/266 passed, 5 failures. All five were diagnosed and fixed: Go action classification and test-marker propagation to detached fake runners. The corrected focused reproductions pass; a fresh full-suite run remains the final gate.

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

## 2026-08-23 continuation completion audit

- Reopened completion for a requirement-by-requirement audit of installability, readiness, evaluation comparability, and runtime trust boundaries.
- Independent diff review found that generic ecosystem preflight records `ready=false` but the runner does not enforce it before planner execution. A RED integration regression is next.
- `npm audit --omit=dev --json` exited with `ENOLOCK`; the repository has no package lock and declares no runtime or development dependencies.
- **TDD RED:** `an ecosystem readiness gap stops before planner model usage` failed because the Python missing-lock fixture returned exit 0 instead of 2 after consuming fake-agent planner/workflow calls. The failure was the intended missing readiness gate.
- **TDD GREEN:** the runner now stops before planner use, preserves `status=pass` plus `readiness=environment_gap`, and records a source-fix/new-Run blocker; the five adjacent Go/preflight tests pass.
- **Package-boundary RED:** `installed npm bin exercises the core control-plane commands` failed because the installed smoke report had no public-entrypoint or `preview`/`doctor` execution evidence; the old smoke invoked only the internal runner path for `help`.

### Continuation completion audit closeout

- **Historical observation, superseded:** installed tarball smoke ran through npm's public bin shim and `validate` reported 41 discovered Skills. The 2026-08-26 clean-home reproduction proved that count came from ambient user Skills rather than the tarball; the closure below replaces it with a deterministic seven-specialist bundled contract.
- Added a platform-aware Go toolchain contract: the JobQueue pilot binds official Go 1.27.0 hashes for `win32-x64` and `linux-x64`, resolves the current host before either arm starts, and CI provisions Go 1.27.0 on both runners.
- `npm run test:eval`: exit 0; 43/43 passed, including hidden JobQueue observation and contract tests.
- Full final gates: `npm test` 274/274; `npm run validate` 72/72; `npm run validate:package` 69 files / 21 shipped `.mjs` / 0 denied; `npm run test:package-smoke` pass; Go build/vet/test pass; syntax and `git diff --check` pass.
- Final evidence boundary unchanged: no Graph Run, real Codex/Claude sandbox smoke, real model paired pilot, commit, push, deploy, or publish was performed.

## 2026-08-23 continuation implementation

- Revalidated the current dirty checkout before editing. The prior `274/274` closure entry is historical and is no longer treated as current evidence.
- Baseline full-suite result from the current host was exit 1 with `271/274` passed; the three failures were child-process timeout assertions in dependency preparation and installer tests. Isolated reruns passed, including the slow installer path.
- Added `SLOW_INTEGRATION_TIMEOUT=120000` for the deliberately slow dependency/installer child processes and a `spawnResultDetails()` helper so `spawnSync` timeout errors retain `result.error` diagnostics.
- Split `.github/workflows/ci.yml` into `runtime-regression` and `contract-and-package` jobs with independent time budgets; no release or remote workflow was triggered.
- Updated `findings.md` to distinguish historical closure evidence from this continuation's observed results. Real Codex/Claude probes, a Graph Run, and current v3 paired evaluation remain external verification gates.

## 2026-08-23 second verification

- Fresh full `npm test` exited 0 with 274/274 passed in 820701.2586 ms; the prior three timeout failures did not recur under the bounded slow-path budget.
- Fresh downstream gates passed: `npm run test:eval` 43/43; `npm run validate` 72 checks; `npm run validate:package` 69 files / 21 shipped `.mjs` / 0 denied paths; `npm run test:package-smoke` through npm's public bin; JobQueue Go 1.27.0 build/vet/test; 203 `.mjs` syntax checks; `git diff --check`.
- `npm pack --dry-run` confirmed the shipped boundary (69 files, 18 references, 8 agents, no `evals/` or hidden tests). `npm audit --omit=dev --json` still returns `ENOLOCK` because this zero-dependency repository has no lockfile; this remains an audit limitation, not a clean dependency assertion.
- Fresh `doctor --agent-backend codex --json` exits 2 with installed/invocable checks passing and both sandbox dimensions unverified. Source `preview` confirms audit mode, four required domains, high assurance waiting, and no state creation.
- First-principles acceptance matrix is now recorded in `findings.md`: the local install/control/recovery surface is sufficient for controlled use, while real-agent task readiness, real-model paired effectiveness, remote CI, and release readiness remain open gates.

## 2026-08-23 capability identity hardening continuation

- Added a RED regression for same-size/same-mtime executable replacement; the old capability identity contract failed at module import because the content-binding helpers were absent.
- Added `content_sha256` to `invocationIdentity`, bumped the sandbox capability record version to `3`, and made capability matching compare the complete invocation identity. Focused capability tests pass 7/7.
- Updated README, usage, architecture, findings, and implementation-plan text so “resolved agent binary” means content-bound evidence. Real smoke remains intentionally unrun; this change only makes future smoke records harder to replay across binary replacement.

## 2026-08-23 post-hardening verification

- Full `npm test` exited 0 with 275/275 passed in 783284.3856 ms.
- `npm run test:eval` exited 0 with 43/43; `npm run validate` passed 72 checks; `npm run validate:package` passed with 69 files / 21 shipped `.mjs` / 0 denied; `npm run test:package-smoke` passed with the expected blocked doctor/validate readiness diagnostics.
- JobQueue Go 1.27.0 build/vet/test exited 0; 203 `.mjs` files passed syntax checks; `git diff --check` exited 0.
- The remaining external gates are unchanged: protected real-agent smoke, current v3 paired model evidence, remote CI/release identity, and any authorized release action.

## 2026-08-23 invocation-prefix identity continuation

- RED: a same-size/same-mtime prefixed CLI script replacement left `invocationIdentity` unchanged.
- GREEN: capability identity now includes existing path-like prefix files and their content hashes; command and prefix replacement regressions pass.
- Documentation and findings now describe the complete invocation binding. Its required full-suite verification is fulfilled by the 2026-08-26 closure below.

## 2026-08-26 repository health closure

- Reproduced the current dirty checkout before editing: `npm test` failed 272/276, `npm run test:eval` failed 43/44, and installed package smoke found zero Skills with an isolated user home.
- Fixed the shared package/routing cause by discovering the npm artifact's sibling graph specialists as a canonical `bundled` origin. The control-plane Skill remains excluded, so installed `validate` now deterministically reports seven specialists without reading ambient user Skills.
- Fixed Windows dependency preparation when `npm.cmd` is installed below a path containing spaces: the batch handoff uses `call` and passes the already-quoted command line verbatim to `cmd.exe`. The lifecycle-script denial regression passes.
- Disabled Go VCS stamping only for the frozen JobQueue evaluator build. This preserves compile coverage while preventing unrelated parent Git ownership/configuration from invalidating the fixture.
- Fresh closure evidence on the final code: `npm test` 278/278 in 256433.2238 ms; `npm run test:eval` 45/45; `npm run validate` 72 checks; `npm run validate:package` 69 files / 21 shipped `.mjs` / 0 denied paths; installed npm-bin package smoke pass with seven bundled specialists; JobQueue Go 1.27.0 build/vet/test pass; 48 source `.mjs` syntax checks and `git diff --check` pass.
- No real-agent smoke, real-model paired pilot, remote CI, commit, push, deploy, or publish was performed. Those external evidence and authorization gates remain open.
