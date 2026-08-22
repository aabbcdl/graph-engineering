# Graph Engineering 15-item implementation

## Goal
Implement the approved Graph Engineering hardening plan while preserving the existing dirty worktree, v1/v2 run readability, isolated execution, transactional apply, and explicit no-Graph-self-modification boundary.

## Current Phase
Completed - all five phases delivered; final verification green

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
| `D:\ai-data\skills\codex-skills\tdd-workflow\SKILL.md` missing | 1 | Read the available user-level skill at `C:\Users\cdl\.agents\skills\tdd-workflow\SKILL.md`. |

## Baseline

- Branch: `main` (pushed to https://github.com/aabbcdl/graph-engineering)
- Existing dirty changes: preserved; no reset/checkout/clean performed. The accumulated v0.3 work was committed in `92e3b59` after explicit owner approval.
- Baseline `npm test`: exit 1, 240 tests, 232 passed, 8 failed under the new strict/partial semantics; all 8 were resolved by targeted corrections or updated assertions.
- Final `npm test`: 255/255 (248 before the seven new CLI contract tests), `npm run test:eval` 10/10, `npm run validate` 72 checks.
