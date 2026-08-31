# Graph Engineering 15-item implementation

## Goal
Implement the approved Graph Engineering hardening plan while preserving the existing dirty worktree, v1/v2 run readability, isolated execution, transactional apply, and explicit no-Graph-self-modification boundary.

## Current Phase
Mac-first `0.3.2` release-candidate assurance; external release state is verified live from GitHub/NPM rather than cached in this plan (2026-08-31)

## Published baseline and current candidate

- Published baseline: `graph-engineering@0.3.1`, tag `v0.3.1`, and GitHub Release remain bound to release commit `1341b790a7d4c705f5cb1cfdcc066ac1d22ce078`.
- Current source version: `package.json` version `0.3.2`. Use `docs/release-runbook.md` to bind the live commit, CI, tarball, registry, tag, and publication state before any release action.
- The local gates below are evidence for the candidate only; they do not retroactively change the published baseline.

## Release-control contract

- Installed lifecycle Skills read `skills/autonomous-engineering-graph/references/lifecycle-contract.md`; the old Chinese path is a compatibility pointer only.
- `docs/release-runbook.md` fixes release/monitoring ownership, exact identity checks, a zero-tolerance failure threshold, and the `0.3.1` dist-tag/deprecation rollback.
- `validate:package`, `release:check`, package-policy regressions, and Ubuntu/macOS CI reject missing controls or legacy Skill references.
- Current local gate: 302 total / 296 pass / 6 skipped, archive 4/4, package policy 5/5, eval 66/66, specialist validation 72/72, package smoke/release check/Go/syntax/diff pass.
- Current deterministic tarball: 69 files, SHA-256 `caf37784720672c882ddf38f282cac71e02b6fb2a0e31872cab18231020af8d2`; isolated `0.3.1 -> 0.3.2 -> 0.3.1` installer rollback passes.
- NPM publish, Git tag, and GitHub Release remain separately authorized external actions.

## 2026-08-31 candidate closeout (historical local-preparation checkpoint)

- [x] Move the unreleased candidate from the already-published `0.3.1` version to `0.3.2` and add an unreleased changelog entry.
- [x] Separate the published `0.3.1` evidence from the current dirty checkout in public and project status documents.
- [x] Fresh `npm test`: 302 total, 296 pass, 6 skipped, 0 fail.
- [x] Fresh focused gates: archive 4/4, package policy 3/3, eval 65/65.
- [x] Reproduce and close the archive's intermediate-directory symlink escape; summary hashing now rejects every symlinked path component.
- [x] Reject fractional or unsafe scorer-only token/time budgets, duplicate/case-colliding pair identities, unvalidated findings, empty regression evidence, and invalid timing so malformed input cannot unlock `claim_ready`; focused adversarial regressions pass.
- [x] Verify the published `0.3.1` tarball identity and an isolated npm/Skill installer `0.3.1 -> 0.3.2 -> 0.3.1` upgrade/rollback round trip.
- [x] Re-run specialist validation, package validation, installed-bin smoke, release check, syntax, diff, Go fixture, tarball, and secret/private-content checks after the version/document edits: all local gates pass; the repeated `0.3.2` tarball is byte-identical (67 files, SHA-256 `c82da2d8d59a89197514f9afe64090bfd4c9389df12b824e9f02b53d2c180ed0`).
- [x] Re-run the final read-only quality and release-readiness audit after the last correction: no unresolved local P0/P1 remains, but Final Quality Audit is `BLOCK` and Release Readiness is `NO-GO`/`WAITING_GATE` until an authorized candidate commit, matching Node 20 remote CI, NPM authentication, and a concrete rollout monitoring/rollback owner are evidenced; tag/Release/published artifact identity remains post-action verification.
- [x] Do not commit, push, tag, create a GitHub Release, or publish NPM in this final local-preparation pass.

## 2026-08-30 closeout scope (published baseline; historical)

- [x] Pin the published `0.3.0` source provenance to tag `v0.3.0` before new changes.
- [x] Replace shell-dependent test globs with deterministic Node file enumeration.
- [x] Make Codex path-resolution regression tests independent of an installed host Codex.
- [x] Add `macos-14` to the deterministic CI matrix.
- [x] Bind the Darwin arm64 evaluator hash to the official `actions/setup-go` binary rather than a Homebrew rebuild.
- [x] Keep Windows protected smoke outside the Mac release CI matrix; retain it as an explicitly unknown external gate.
- [x] Complete local gates, publish `0.3.1`, push the release commit, and create `v0.3.1`/GitHub Release.
- [x] Record the exact commit, registry version, tarball identity, CI run, and remaining external gates.

### 2026-08-30 release evidence (published baseline; historical)

- Release commit: `1341b790a7d4c705f5cb1cfdcc066ac1d22ce078` (`ci: make the Mac evaluation gate reproducible`).
- Public CI: [run 33307211330](https://github.com/aabbcdl/graph-engineering/actions/runs/33307211330), all four Ubuntu/macOS jobs passed.
- NPM: `graph-engineering@0.3.1`, `latest=0.3.1`, 67 files, shasum `09e4b6ff80a89829a15c520e45b74d02652de704`.
- GitHub: tag `v0.3.1` and [release](https://github.com/aabbcdl/graph-engineering/releases/tag/v0.3.1) published; [v0.3.0 release](https://github.com/aabbcdl/graph-engineering/releases/tag/v0.3.0) also backfilled for the existing public tag.
- Remaining independent gates: Windows is only partially adapted and may be unreliable for real-agent work, so protected smoke remains optional/`UNKNOWN`; five comparable real-model Graph-vs-baseline pairs are blocked on authorized provider authentication after the confirmed launch choice.

## 2026-08-30 real-run archive and paired-evaluation preparation

- [x] Add a source-checkout archive utility that discovers Run records without following workspace directories or symlinked summary files.
- [x] Keep the archive public-safe: no raw source, workspace, report body, absolute path, or credential export; only sanitized metadata and evidence-file hashes/presence are retained.
- [x] Archive 4 located real-repository Runs from GoFish and KopiAI into a private local index outside the checkout (path intentionally omitted from repository documentation) (1 `completed`, 1 `completed_with_gaps`, 2 `waiting_budget`; invalid records 0).
- [x] Freeze the Mac JobQueue pilot entrypoint in `evals/manifest.pilot-jobqueue.json`: 5 repetitions, alternating arm order, same fixture/goal/model/effort/budget, Darwin arm64 toolchain hash, and hard aggregate budget contract.
- [x] Add deterministic archive tests and a CI-maintained `npm run test:archive` developer check.
- [ ] Run the 5 real Graph-vs-single-agent pairs. The owner confirmed Codex / `gpt-5.6-terra` / `medium` and accepted the declared 2,500,000-token / 240-minute per-arm budget, but the first launch was blocked by `401 API_KEY_REQUIRED` from the current custom provider; no comparable pair was produced.
- [x] Preserve and privately archive the incomplete launch outside the checkout; keep it operational feedback only with `claim_ready=false`.
- [x] Add a fail-fast guard so an infrastructure-invalid pair is persisted but cannot start later repetitions and consume more model quota; retain legitimate measured `negative_result` samples without truncating later repetitions.
- [x] Keep the private operational archive out of public effectiveness evidence; its `claim_ready` value remains `false` by design.

## 2026-08-28 NPM package preparation

- [x] Add separate `graph-engineering-install` NPM bin so package installation and user-level Skill installation are explicit steps.
- [x] Keep the public tarball limited to the runner, Skills, runtime references, documentation, and installer; exclude `evals/`, tests, package smoke, validator, and Windows smoke tooling.
- [x] Add a macOS NPM-bin smoke path that installs the tarball into an isolated prefix, runs the installer into temporary user directories, and validates `help`, `preview`, `doctor`, and `validate`.
- [x] Add `release:check` and `prepublishOnly` guards for repository metadata, public-doc placeholders, required bins, and final tarball contents.
- [x] Previous package evidence: 66 files / 17 shipped `.mjs`, `npm run validate:package` pass, `npm run test:package-smoke` pass, `npm run test:eval` 45/45, `npm run validate` 72/72, host `darwin-arm64` (historical; superseded for the current candidate).
- [x] Supply the real GitHub repository URL and remove public-doc placeholders before release; `npm run release:check` reports `ready`.
- [x] Publish `graph-engineering@0.3.0` to the public NPM registry through the browser web-auth/2FA flow; registry verification reports `latest=0.3.0`.
- [x] Commit and push the `0.3.0` release-preparation changes to the public GitHub repository; `main` was synced at `f716250`.

## 2026-08-26 repository health closure

- [x] Make the npm artifact discover its seven bundled graph specialists with an empty user `CODEX_HOME`; bundled graph names cannot be shadowed by project or global copies.
- [x] Preserve Windows batch package-manager paths containing spaces through the `cmd.exe` handoff without enabling repository lifecycle scripts.
- [x] Make JobQueue fixture compilation independent of unrelated parent-repository VCS stamping.
- [x] Re-run the current checkout: `npm test` 278/278; `npm run test:eval` 45/45; validator 72/72; package validation 69 files / 21 shipped `.mjs`; installed public-bin smoke pass; JobQueue Go build/vet/test pass; 48 source `.mjs` syntax checks and `git diff --check` pass.
- [x] Keep external gates explicit: protected real-agent sandbox probes, five comparable real-model pairs, remote CI, and release authorization remain unproven.

## Continuation completion audit
- [x] Reconstruct the user-purpose acceptance matrix from the approved design and public contracts
- [x] Independently review the current installability, readiness, evaluation, and runtime-boundary diff
- [x] Re-run deterministic repository, package, and isolated installed-CLI verification
- [x] Add RED regressions and repair any remaining validated gaps
- [x] Record a final evidence verdict without promoting unrun real-agent/model gates to passes

## Prior closure result (historical; 2026-08-23)

- [x] Fixed the validated preflight readiness gate: `WORKSPACE_ENVIRONMENT_GAP` blocks before planner/model use while preserving the frozen diagnostic record.
- [x] Extended installed package smoke through npm's public bin shim (`help`, `preview`, `doctor`, `validate`).
- [x] Made the JobQueue Go toolchain contract platform-aware and provisioned Go 1.27.0 in CI.
- [x] Prior local evidence: npm 274/274, eval 43/43, validator 72/72, package 69 files/21 `.mjs`, package smoke pass, Go build/vet/test pass, syntax/diff checks pass. This is historical and does not certify the current dirty checkout.
- [x] Residual gates are explicitly unproven: protected real-agent sandbox probes, real model paired pilot, and release/remote actions.

## Current continuation remediation (2026-08-23)
- [x] Record the current `271/274` timeout baseline and preserve the three isolated-pass diagnostics.
- [x] Increase only the deliberately slow dependency/installer child-process budget to 120 seconds and retain timeout error details.
- [x] Split CI runtime regression from contract/package checks with independent time budgets.
- [x] Re-run the complete current checkout suite and classify any remaining failure from observed diagnostics: exit 0, 274/274; no remaining timeout or assertion failure.
- [x] Re-run all downstream local gates and issue a second first-principles fit verdict: local control-plane gates pass; real-agent, real-model, and remote-release gates remain explicitly open.

## Second verification result (current checkout; 2026-08-23)

- [x] `npm test` exit 0, 274/274, 820701.2586 ms.
- [x] `npm run test:eval` exit 0, 43/43; `npm run validate` exit 0, 72 checks; `npm run validate:package` exit 0, 69 files / 21 shipped `.mjs` / 0 denied paths; `npm run test:package-smoke` exit 0.
- [x] JobQueue Go 1.27.0 `build=0`, `vet=0`, `test=0`; 203 repository `.mjs` files pass `node --check`; `git diff --check` exit 0; `npm pack --dry-run` confirms 69 files with 18 references, 8 agents, and no `evals/` or hidden tests.
- [x] Fresh `doctor --agent-backend codex --json` remains intentionally blocked (two missing sandbox probes); no task-ready claim is made.
- [x] First-principles verdict: installability, deterministic control contracts, isolation/recovery, and evidence bookkeeping are locally sufficient; real backend capability, Graph-vs-baseline effectiveness, remote CI, and release authorization are not yet proven.

## Capability identity hardening continuation (2026-08-23)

- [x] Add RED coverage proving a same-metadata executable replacement cannot reuse a capability record.
- [x] Bind capability records to `content_sha256`, bump record version to `3`, and compare the complete invocation identity.
- [x] Update public and implementation-plan documentation; focused capability regression passes 7/7.
- [x] Re-run the full current checkout verification after this code change: `npm test` 275/275; downstream contract, package, Go, syntax, and diff checks pass.

## Invocation-prefix identity continuation (2026-08-23)

- [x] Add RED coverage for a same-metadata prefixed CLI script replacement.
- [x] Include existing path-like prefix files and content hashes in `invocationIdentity`.
- [x] Update trust-boundary documentation and findings; focused command/prefix identity tests pass.
- [x] Re-run the full current checkout verification after this second capability hardening; superseded by the 2026-08-26 closure evidence above.

## Product-fit hardening phases
- [x] Add RED regressions for readiness, capability, evaluation packaging, and preview semantics
- [x] Repair ecosystem preflight and JobQueue toolchain contract
- [x] Add strict agent capability doctor and startup gate
- [x] Close evaluation package/truth boundary and symmetric budget contract
- [x] Align preview/assurance semantics and documentation
- [x] Run full verification and reassess user-purpose fit

## Product-fit closure (2026-08-23)
- [x] Align Claude capability write/read paths and merge concurrent probe records under a cross-process lock
- [x] Bind test-only assurance/capability bypasses to the repository fake-agent fixture; add Chinese goal-mode inference
- [x] Bind evaluation budget/toolchain declarations into adapter identities and scorer comparability checks
- [x] Remove source-checkout-only evaluation harness and hidden material from the npm package surface
- [x] Finish post-change full regression and record residual real-agent/model evidence gaps

## 2026-08-23 final verification and first-principles verdict (historical)

- [x] Fixed a release-blocking npm boundary defect: `files` patterns now recurse into every production `agents/` and `references/` directory; `validate:package` derives required runtime paths from `specialist-pack.json`.
- [x] Added `package-contract.test.mjs`; RED reproduced an installed tarball missing `specialist-pack.json`, GREEN now proves runtime references and agent metadata ship.
- [x] Historical evidence only: `npm test` exit 0, 272/272; `npm run test:eval` exit 0, 40/40; `npm run validate` exit 0, 72 checks; package, smoke, tarball, and diff checks passed at that checkpoint. These results predate the current continuation changes.
- [x] Read-only Windows smoke now requires target-specific host evidence: a target write operation, `sandbox_write_denied`, and `read-only` proof; caught PowerShell/.NET write errors are recognized and printed by the probes.
- [x] Source CLI `help` and Chinese audit `preview` are operational and preview creates no Run/state residue; preview correctly reports high assurance as waiting when both roles resolve to the same backend/model.
- [x] Local `doctor --agent-backend codex --json` exits 2 because protected Windows read-only and workspace-write smoke records are absent. This is an honest environment readiness block, not a passed real-agent check.
- [x] No Graph Run, real Codex/Claude smoke, real model paired pilot, commit, push, deploy, or publish was performed. Existing evaluation reports remain descriptive (`claim_ready=false`; prior records are Run v2/insufficient comparable pairs), so Graph effectiveness is not proven.

## Phases

### Phase 1: Baseline and P1 correctness gates
- [x] Record baseline and create deterministic RED tests
- [x] Implement strict required-check matching
- [x] Implement audit coverage and assurance completion gates
- [x] Implement persisted Run budget controls
- **Status:** completed; full-suite rerun remains a release-gate check after all phases

### Phase 2: CLI operations and review controls
- [x] Add total review cap and deprecated compatibility alias
- [x] Add preview, diff, apply dry-run/selective apply, and recheck (contract tests cover preview residue/shape, runs listing, diff classification, dry-run conflict checks, selective `--file` application with `partial_application` recording, and recheck guard rails plus the `already-satisfied` fast path)
- [x] Add backend capability matrix and assurance reporting (exposed through `preview`; assurance gates enforced in run outcome)
- **Status:** completed

### Phase 3: Scope and ecosystem preflight
- [x] Add repository-root versus requested-scope model
- [x] Add Node, Python, Go, Rust, Java, and .NET adapter registry
- **Status:** completed

### Phase 4: Durable control plane details
- [x] Add Run listing, soft quota, and explicit GC
- [x] Add event head and sparse index
- [x] Align restore with mode/kind/link manifest checks
- **Status:** completed

### Phase 5: Release assurance
- [x] Add package allowlist and tarball smoke checks
- [x] Add protected Windows real-agent smoke workflow
- [x] Update docs and run all required verification
- **Status:** completed

## Decisions

| Decision | Rationale |
|---|---|
| No new runtime dependency or SQLite migration | Preserve the current package and v1/v2 compatibility surface. |
| New Run default budget is 6M tokens / 240 active minutes / 96 attempts | User selected the wide hard-limit profile. |
| High assurance is fail-closed for audit and release checks | Avoid silently treating same-backend review as cross-model assurance. |
| Existing `--max-review-nodes` remains per-wave and is deprecated | Preserve saved runs and scripts. |
| No automatic commit, apply, deploy, publish, or Graph Run | Preserve explicit authorization boundaries. |

## Errors Encountered

| Error | Attempt | Resolution |
|---|---:|---|
| `D:\path\to\skills\codex-skills\tdd-workflow\SKILL.md` missing | 1 | Read the available user-level skill at `C:\Users\<user>\.agents\skills\tdd-workflow\SKILL.md`. |
| `C:\Users\<user>\.agents\skills\production-audit\SKILL.md` missing | 1 | Dropped the optional skill; use the loaded code-review and verification-loop checklists instead. |
| `npm audit --omit=dev --json` returned `ENOLOCK` | 1 | Record the audit limitation; the package declares zero dependencies and intentionally has no lockfile, so do not manufacture one solely for this check. |

## Baseline (historical snapshots)

- Branch: `main` (the current checkout is dirty; the following entries describe prior snapshots)
- Existing dirty changes: preserved; no reset/checkout/clean performed. The accumulated v0.3 work was committed in `92e3b59` after explicit owner approval.
- Baseline `npm test`: exit 1, 240 tests, 232 passed, 8 failed under the new strict/partial semantics; all 8 were resolved by targeted corrections or updated assertions.
- Final `npm test`: 255/255 (248 before the seven new CLI contract tests), `npm run test:eval` 10/10, `npm run validate` 72 checks.

## Jobqueue fixture phase (2026-08-22)

- [x] Freeze the Go fixture contract, module layout, and 23-defect category quota
- [x] Implement the clean public behavior and passing public test baseline (`go test ./...` and `go build ./...` pass with the SHA-checked local toolchain)
- [x] Seed the frozen cross-module defects without breaking public tests
- [x] Add hidden truth/evaluator, real-fixture coverage, and a pilot manifest
- [x] Run Go checks with the local SHA-checked toolchain
- [x] Run JavaScript harness/package regression and review the complete fixture diff
- [x] Require `validated: true` before mapping natural-language claims to truth defects
- [x] Validate newline-delimited Go hidden-test observations and guard against parser false negatives

### Jobqueue scope decisions

- Language: Go, standard library only; no new runtime dependency in Graph itself.
- Shape: one `go.mod`, eight packages/modules, approximately 2,000-3,000 source lines, 23 seeded defects.
- Public checks: `go build ./...` and `go test ./...` are the fixture contract.
- Truth is frozen before any real arm run and is never changed based on arm outcomes.
- Local verification uses the SHA-256-checked, ignored toolchain at `.tmp/go-toolchain`; it is not a Graph runtime dependency or fixture artifact.
