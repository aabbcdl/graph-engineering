# Graph Engineering 15-item implementation

## Goal
Implement the approved Graph Engineering hardening plan while preserving the existing dirty worktree, v1/v2 run readability, isolated execution, transactional apply, and explicit no-Graph-self-modification boundary.

## Current Phase
Phase 2 - control-plane operations, assurance, and backend capability reporting

## Phases

### Phase 1: Baseline and P1 correctness gates
- [x] Record baseline and create deterministic RED tests
- [x] Implement strict required-check matching
- [x] Implement audit coverage and assurance completion gates
- [x] Implement persisted Run budget controls
- **Status:** completed; full-suite rerun remains a release-gate check after all phases

### Phase 2: CLI operations and review controls
- [x] Add total review cap and deprecated compatibility alias
- [x] Add preview, diff, apply dry-run/selective apply, and recheck (initial implementation exists; contract tests pending)
- [ ] Add backend capability matrix and assurance reporting
- **Status:** in_progress

### Phase 3: Scope and ecosystem preflight
- [ ] Add repository-root versus requested-scope model
- [ ] Add Node, Python, Go, Rust, Java, and .NET adapter registry
- **Status:** pending

### Phase 4: Durable control plane details
- [ ] Add Run listing, soft quota, and explicit GC
- [ ] Add event head and sparse index
- [ ] Align restore with mode/kind/link manifest checks
- **Status:** pending

### Phase 5: Release assurance
- [ ] Add package allowlist and tarball smoke checks
- [ ] Add protected Windows real-agent smoke workflow
- [ ] Update docs and run all required verification
- **Status:** pending

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

- Branch: `master`
- Existing dirty changes: preserved; no reset/checkout/clean performed.
- Baseline `npm test`: exit 1, 240 tests, 232 passed, 8 failed under the new strict/partial semantics; all 8 are now covered by targeted corrections or updated assertions.
- Baseline `npm run test:eval` and `npm run validate`: pending capture.
