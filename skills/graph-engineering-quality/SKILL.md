---
name: graph-engineering-quality
description: Review or repair architecture, correctness, contracts, state, failures, dependencies, tests, and maintainability. Use in Graph Engineering for code changes, regressions, refactoring, build failures, or technical debt; review in read-only nodes and fix validated defects in write nodes.
---

# Graph Engineering Quality

Apply the original engineering review and execution standards without replacing the surrounding Graph node contract.

## Select The Rubric

1. Resolve reference paths relative to this `SKILL.md` file.
2. In `discovery`, `review`, `synthesis`, or `independent_review` work, read [references/review-rubric.md](references/review-rubric.md) completely before judging the code.
3. In `implementation` or `correction` work, read [references/execution-rubric.md](references/execution-rubric.md) completely before editing.
4. For a standalone code review, use only the review rubric unless the user explicitly asks for fixes.

## Graph Compatibility

- Treat the selected reference as the domain reasoning rubric. Keep the Graph JSON result schema, current node role, user goal, project instructions, and safety boundary as the output and execution contract.
- Ignore standalone reference instructions that demand a different final document format, ask interactive questions, or claim downstream stages ran. Convert findings and actions into the fields required by the current node.
- In a read-only node, never modify files. In a write-enabled node, implement only findings validated by upstream evidence or newly confirmed repository evidence.
- Revalidate paths, callers, contracts, and evidence before changing code. Preserve user changes and unrelated work.
- Run impact analysis when the project provides it, then run the tests required by the touched surfaces.

## Decision Authority

- Decide low-risk questions from current repository patterns, tests, and contracts.
- For medium-risk ambiguity, choose the smallest reversible and compatibility-preserving option and record the assumption.
- Require an owner gate for authentication or authorization changes, payments, destructive migrations, secrets, production actions, irreversible public-contract breaks, or changes without a safe rollback.
- Never commit, push, deploy, publish, restart devices, or mutate remote services unless the user separately authorizes that action.

## Completion

Do not pass verification from self-report. Require observed commands or runtime checks, actual file attribution, and a fresh independent review. If a check fails, return a concrete correction task rather than weakening the check.
