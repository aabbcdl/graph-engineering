# Findings and decisions

## Current authoritative state (2026-08-31)

- Published rollback baseline: the `v0.3.1` tag and GitHub Release remain pinned to release commit `1341b790a7d4c705f5cb1cfdcc066ac1d22ce078`, and the published NPM artifact is `graph-engineering@0.3.1`. Live `main`, CI, registry, dist-tag, and authentication state is intentionally not cached here; verify it with `docs/release-runbook.md`.
- Current source line: `package.json` declares `0.3.2`. A release identity exists only when its exact commit, Node 20 Ubuntu/macOS CI, tarball metadata, registry metadata, dist-tag, and clean-install smoke agree.
- The current closeout changes repository test orchestration, deterministic Codex resolver coverage, CI matrix coverage, release/documentation metadata, the source-checkout-only private Run archive utility, and evaluation state-root/fail-fast/scorer-input safeguards. It does not change user repositories or claim a new model-quality result.
- Mac Apple Silicon is the primary supported workflow. Public deterministic CI covers Ubuntu and macOS 14; Windows is only partially adapted, may be unreliable for real-agent work, and remains an optional external `UNKNOWN` gate that is not required for Mac use.
- Local verification is complete: `npm test` 302 total (296 pass, 6 skipped, 0 fail), `npm run test:archive` 4/4, `npm run test:package-policy` 5/5, `npm run test:eval` 66/66, `npm run validate` 72/72, `npm run validate:package` 69 files / 17 shipped `.mjs` / 0 denied paths, installed-bin package smoke with Mac `doctor=ready`, release check, source `.mjs` syntax, pinned Go build/vet/test, package privacy/boundary checks, and working-tree diff checks all pass.
- After packaged documentation was finalized, three `0.3.2` tarballs are byte-identical: 69 files, SHA-256 `caf37784720672c882ddf38f282cac71e02b6fb2a0e31872cab18231020af8d2`, npm shasum `8951ea7d91f222ccb1053759d2f666741821f64b`, integrity `sha512-LF/b0Vf4675OZjKqmhfXni7hmlhvPSZPFdBfwLOtLHozMweLvKw6+Z537DeB+zrV/99Qtw3CBraxdQN9YRitkw==`, and unpacked size 1,370,037 bytes. `npm audit --omit=dev --json` remains unavailable with `ENOLOCK` because this zero-runtime-dependency repository has no lockfile; no audit-pass claim is made.
- The registry `0.3.1` tarball matched its published shasum. An isolated `0.3.1 -> 0.3.2 -> 0.3.1` npm/Skill installer round trip passes exact tree hashing, canonical workflow-contract resolution, candidate `help`/no-state `preview`, and baseline restoration.
- The final scorer review now rejects duplicate or case-colliding `(fixture_id, repetition)` identities, missing/false `validated` findings, empty regression evidence, and invalid wall/queue timing before a pair can contribute to a claim. Focused and full regressions cover these guards.
- The final archive review reproduced an intermediate-directory symlink escape that could hash an external summary file. `fileSummary` now rejects every symlinked path component; the focused regression and an independent temporary-directory reproduction both return `present=false`.
- Historical release evidence remains available in CI run [33307211330](https://github.com/aabbcdl/graph-engineering/actions/runs/33307211330), NPM `0.3.1`, and GitHub Releases [v0.3.0](https://github.com/aabbcdl/graph-engineering/releases/tag/v0.3.0)/[v0.3.1](https://github.com/aabbcdl/graph-engineering/releases/tag/v0.3.1); none of it may be reused as `0.3.2` evidence.
- `aabbcdl` is the named release and rollout-monitoring owner. Any identity mismatch or failed clean-install `help`/`preview`/`doctor`/`validate` check triggers restoration of `latest` to `0.3.1` and deprecation of `0.3.2`; published registry history is retained.
- The previous point-in-time audit blocked on candidate commit/CI, NPM authentication, and missing monitoring/rollback ownership. Ownership and rollback controls are now repository-enforced; exact commit/CI and NPM authentication remain live pre-release evidence. NPM publish, Git tag, and GitHub Release require separate authorization and post-action verification.
- Four real-repository Run records from the selected GoFish/KopiAI temporary roots were located, independently checked, and summarized into a private public-safe index. The index contains sanitized metadata and evidence-file hashes only; it remains operational feedback, not published statistical evidence (`claim_ready=false`).
- The owner confirmed the Mac pilot launch as Codex / `gpt-5.6-terra` / `medium` with the declared 2,500,000-token and 240-minute per-arm limits. The first launch passed the external-state isolation preflight, but both arms were rejected by the current custom provider with `401 API_KEY_REQUIRED`; no backend token usage was reported, no pair was comparable, and the run was stopped before further quota exposure. The incomplete output is privately archived outside the checkout at a local path intentionally omitted from repository documentation, with `claim_ready=false`.

## Repository evidence baseline (historical; rechecked below)

- Main runner: `skills/autonomous-engineering-graph/scripts/graph-runner.mjs` (still the orchestration monolith; `runtime/` extraction is the next structural step).
- `runtime/evidence-verifier.mjs` now requires exact normalized argv matching and rejects fabricated `check_id` claims.
- `runtime/state-model.mjs` includes audit-domain completion, assurance, and budget gates in `deriveRunOutcome()`.
- `runtime/event-log.mjs` maintains a sparse head/index and lazily rebuilds legacy metadata.
- `workspace-preflight.mjs` covers Node, Python, Go, Rust, Java, and .NET lock inputs.
- `restore-run.mjs` restores mode, kind, and link-target differences.
- `apply-results.mjs` provides transactional apply, conflict checks, rollback, dry-run, and selective `--file` application.
- The older v0.3 closure was recorded against `92e3b59`; this is historical evidence, not the current checkout baseline.

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

## 2026-08-22 first-principles product-fit pass

- The user's real outcome is a trustworthy, repeatable engineering control plane that a team can install and use to decide whether a change is ready, not merely a repository with green unit tests.
- Current gaps are operational-contract gaps: standard-library Go projects are falsely classified as missing-lock environments; readiness is conflated with preflight execution success; agent sandbox capability is only WARN/unverified without a hard doctor gate; the published eval package includes hidden truth material; evaluator toolchain and budget contracts are asymmetric; and audit preview can advertise ordinary task coverage/assurance.
- No current Run v3 real-model pair exists, so production-level effectiveness remains unproven even after local correctness fixes.

## 2026-08-23 release-boundary finding and closure

- A tarball smoke run initially failed at installed CLI startup with `ENOENT` for `skills/autonomous-engineering-graph/references/specialist-pack.json`. The cause was non-recursive `skills/**/agents` and `skills/**/references` entries in `package.json`; `validate:package` did not require those runtime files and therefore gave a false pass.
- The boundary is now repaired with recursive package globs, manifest-derived required-path validation, and `skills/autonomous-engineering-graph/scripts/tests/package-contract.test.mjs`. RED reproduced the missing file; GREEN and installed package smoke pass.
- Final local evidence: `npm test` 270/270, `npm run test:eval` 40/40, `npm run validate` 72 checks, `validate:package` 69 files, package smoke pass, and tarball boundary 18 references/8 agents/0 `evals`/0 tests.
- Remaining evidence gaps are intentional and explicit: Windows `doctor` is blocked until protected Codex/Claude sandbox probes run; no current Run v3 real-model paired evaluation exists, and prior reports are `claim_ready=false`. Neither gap may be reported as a successful release or performance result.

## 2026-08-23 sandbox-probe trust-boundary closure

- The first strict-probe review found that a read-only smoke could pass when the agent returned `file_exists=false` without attempting a write; this would record capability without host denial evidence. The same path also missed caught PowerShell/.NET `WriteAllText` errors when the command exited 0.
- `machineFailuresFromProof` now recognizes those write APIs and caught denial text, `readonlySandboxProbeEvidence` requires `read-only` plus target-observed write plus `sandbox_write_denied`, and both Codex/Claude read-only probes enforce it. Regression tests cover both the no-op rejection and caught-denial acceptance.
- Final local regression after this fix: `npm test` 272/272; `npm run test:eval` 40/40; package/validator/smoke and syntax checks pass. Real smoke commands remain intentionally unrun, so capability records are not claimed.

## 2026-08-23 product-fit closure pass

- Claude capability probes now share one canonical `claude-sandbox.json` path (including the generic backend override), and concurrent read/modify/write probes are serialized with a per-record lock so one probe cannot erase the other.
- `AEG_TEST_MODE=1` no longer bypasses assurance or capability gates by itself. The bypass requires the exact repository `fake-codex.mjs` command binding; child environments project the variable only for that fixture. Chinese audit/review/diagnosis keywords are recognized by deterministic goal inference.
- Evaluation adapters now echo the manifest budget/toolchain contracts in `harness_identity`; pair validation and scoring compare those contracts against the launch fingerprint, and toolchain manifests require ecosystem/version/platform plus a pinned binary hash.
- The npm artifact no longer ships the source-checkout evaluation harness (`evals/`); package validation and smoke checks confirm the installed CLI surface has no evaluator that would fail due to missing controlled fixtures.
- Verified at the intermediate checkpoint: focused capability/goal tests pass, evaluation contract tests pass, `validate:package` reports 69 files with no denied paths, and package install smoke passes. The terminal full-suite results are recorded in the final closure section above.

## 2026-08-23 continuation completion audit

- **Validated P1 readiness-gate defect:** `prepareExecutionWorkspace()` now distinguishes `status=pass` (inspection succeeded) from `readiness=environment_gap` / `ready=false`, but `ensureExecutionWorkspacePrepared()` persists that record and continues into the planner without enforcing `ready`. A Python/Go/Rust/Java/.NET project with an untrusted or missing lock input can therefore consume a model call despite the public contract saying it stops before execution.
- **Resolved:** the fix preserves the truthful preflight record (`status=pass`, `readiness=environment_gap`), raises `WORKSPACE_ENVIRONMENT_GAP` before any planner/model call, and proves that no planner attempt is created. The blocker correctly requires correcting the source workspace and starting a new Run because the isolated snapshot is frozen.
- **Resolved:** package smoke now installs the tarball and exercises `help`, `preview`, `doctor`, and `validate` through npm's public bin shim with an isolated temporary `CODEX_HOME`; preview leaves no state residue.
- `npm audit --omit=dev --json` cannot run because the zero-dependency repository intentionally has no lockfile (`ENOLOCK`). This is not evidence of a vulnerability-free dependency graph; the package currently declares no dependencies, so dependency-audit exposure is limited to the Node/npm toolchain itself.

### Historical verification evidence (superseded by the current recheck below)

- `npm test`: exit 0, 274/274 in the preceding run; this result is not current proof after subsequent workspace activity.
- `npm run test:eval`: exit 0, 43/43.
- `npm run validate`: exit 0, 72 checks.
- `npm run validate:package`: exit 0, 69 files, 21 shipped `.mjs`, 0 denied paths.
- `npm run test:package-smoke`: exit 0; npm-bin `help`/`preview`/`doctor`/`validate` exercised; preview created no state.
- JobQueue Go 1.27.0 Windows toolchain: `build=0`, `vet=0`, `test=0`.
- `git diff --check`: exit 0; targeted shipped `.mjs` syntax checks: exit 0.
- Real Windows Codex/Claude probes and real-model paired evaluation remain intentionally unrun; no capability or performance claim is made.

## 2026-08-23 current continuation recheck

- Current Git baseline observed before this continuation: `HEAD` and `origin/main` are both `51571c0`; the working tree contains the existing tracked and untracked product-fit changes and was preserved.
- Fresh full `npm test` is not green in this host session: exit 1, 271/274 passed, with three child-process timeout failures in dependency preparation and installer integration tests. The three tests pass when isolated; their slow child deadlines now use `SLOW_INTEGRATION_TIMEOUT=120000` and timeout diagnostics include `result.error`.
- Fresh `npm run test:eval` passes 43/43. `npm run validate` passes 72 checks. `npm run validate:package` passes with 69 files, 21 shipped `.mjs`, and 0 denied paths. `npm run test:package-smoke` passes through the npm public bin and still reports the expected unverified-backend block.
- Fresh JobQueue checks pass with the local Go 1.27.0 toolchain: `build=0`, `vet=0`, `test=0`. `npm audit --omit=dev --json` remains unavailable with `ENOLOCK`; the package declares no runtime dependencies.
- Current Codex `doctor` remains `blocked`: installed and invocable, but read-only and workspace-write sandbox probes are absent. No real agent smoke, Graph Run, or current v3 paired model evaluation was run.
- The CI runtime regression and contract/package checks are now separate jobs with independent time budgets in `.github/workflows/ci.yml`; remote CI for this dirty checkout remains unobserved.

## 2026-08-23 second verification and first-principles fit verdict

- Fresh full-suite evidence now closes the previous host-load gap: `npm test` exited 0 with 274/274 passed in 820701.2586 ms. The three formerly timing-sensitive child-process tests pass under the bounded `SLOW_INTEGRATION_TIMEOUT=120000`; no assertion or timeout failure remains.
- Fresh downstream evidence: `npm run test:eval` 43/43; `npm run validate` 72 checks; `npm run validate:package` 69 files / 21 shipped `.mjs` / 0 denied paths; `npm run test:package-smoke` pass through the npm public bin (`help`, audit `preview`, fail-closed `doctor`, package `validate`); JobQueue Go 1.27.0 `build=0`, `vet=0`, `test=0`; 203 repository `.mjs` files pass `node --check`; `git diff --check` exit 0.
- `npm pack --dry-run` confirms the installable boundary is 69 files, including 18 references and 8 agent metadata files, with no `evals/` or hidden tests. `npm audit --omit=dev --json` remains `ENOLOCK`; because the package declares no dependencies and no lockfile, this is an audit limitation rather than a clean dependency verdict.
- Fresh source `doctor --agent-backend codex --json` exits 2: the installed/invocable CLI is proven, but read-only and workspace-write sandbox probes are absent. This is the correct fail-closed result; no `task-ready` claim is allowed.
- Fresh source `preview --goal "Audit the repository for release readiness"` reports `mode=audit`, all four required review domains, `assurance.level=high`, `status=waiting_environment`, and `creates_run/creates_workspace/creates_state=false`.

### First-principles acceptance matrix

| Necessary user outcome | Current evidence | Verdict |
|---|---|---|
| Install and invoke the control plane from a package | Tarball boundary, npm-bin smoke, public commands, package validator | **Satisfied locally** |
| Inspect before acting and keep audit/release scope explicit | Read-only `preview`, four-domain audit floor, high-assurance wait, no state residue | **Satisfied structurally and locally** |
| Avoid spending model calls in an unready environment | Readiness regression proves `ready=false` blocks before planner attempts | **Satisfied by deterministic tests** |
| Preserve isolation, rollback, recovery, and evidence lineage | Full runtime suite 274/274 plus apply/recovery/lineage tests | **Satisfied by local tests; production load unverified** |
| Know whether the selected real agent can actually read/write in its sandbox | Doctor remains blocked because protected Windows probes have not run | **Not yet satisfied** |
| Know whether Graph improves engineering outcomes over a baseline | Evaluation harness is contract-valid, but no current Run v3 real-model pairs and fewer than five comparable pairs | **Not satisfied; effectiveness unproven** |
| Publish or release with external infrastructure confidence | Remote CI, real-agent workflow, and release actions were not run or authorized | **Not satisfied; release gate remains open** |

The first-principles conclusion is therefore **locally control-plane ready, but not task-ready or release-ready**. The remaining gap is evidence from the real execution environment and a valid paired measurement, not another deterministic unit-test feature.

## 2026-08-23 capability identity hardening

- **Validated trust-boundary gap:** capability records previously compared the resolved agent path, size, and mtime but did not bind the executable contents. A replacement binary preserving those metadata values could theoretically reuse an old sandbox smoke record.
- **Resolved:** `invocationIdentity` now records `content_sha256`; capability records use version `3`, and matching fails when the executable content changes. A regression keeps file size and mtime constant while replacing bytes and proves the old record no longer matches.
- Focused capability regression: 7/7 passed. This strengthens evidence integrity only; the protected real-agent probes are still unrun and `doctor` remains correctly blocked.
- Post-hardening full verification: `npm test` 275/275; `npm run test:eval` 43/43; `npm run validate` 72 checks; package validator/smoke, JobQueue Go build/vet/test, 203-file syntax scan, and `git diff --check` all pass. No new local failure was introduced.

## 2026-08-23 invocation-prefix identity hardening

- **Validated follow-up gap:** some resolved agent invocations execute a CLI script through a stable command binary (`node <script>` or `powershell -File <script>`). Hashing only the command binary left the prefixed script outside the capability identity.
- **Resolved:** `invocationIdentity` now records existing path-like prefix files with path, metadata, and `content_sha256`; capability matching therefore invalidates a probe when either the command or a prefixed script changes. A regression replaces a same-size/same-mtime prefix script and proves the identity changes.
- The real-agent boundary remains fail-closed: this strengthens future records but does not create any smoke evidence on the current host.

## 2026-08-26 repository health closure

- **Package/runtime defect resolved:** the tarball contained all eight Skills, but `discoverSkills` read only workspace and user-global roots. Public-bin validation with an isolated `CODEX_HOME` therefore found zero Skills, and source integration tests could pass only when the host happened to contain compatible global graph specialists. The runner now treats its seven sibling graph specialists as canonical bundled inputs and still excludes `autonomous-engineering-graph` from graph nodes.
- **Windows portability defect resolved:** Node's Windows argument serialization escaped the quoted `npm.cmd` batch path a second time. `cmd.exe` could not execute package managers installed below paths such as `Program Files`. The runner now uses a `call` batch handoff with verbatim Windows arguments; the real dependency preparation regression proves lifecycle scripts remain disabled.
- **Evaluation portability defect resolved:** JobQueue compilation inherited Go VCS stamping and could fail solely because a parent Git repository rejected ownership inspection. The frozen evaluator now builds with `-buildvcs=false`; Go build/vet/test and all 23 hidden defect observations pass.
- **Current deterministic verdict:** `npm test` 278/278, eval 45/45, specialist validation 72/72, package validation and installed public-bin smoke pass, JobQueue build/vet/test pass, 48 source `.mjs` syntax checks pass, and `git diff --check` passes.
- **Still external:** `doctor` remains fail-closed until protected Codex/Claude read/write probes produce current machine evidence. Graph effectiveness still requires five comparable Run v3 real-model pairs, and release readiness still requires an identified commit, remote CI/artifact evidence, rollback signals, and owner authorization.
