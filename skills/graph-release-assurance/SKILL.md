---
name: graph-release-assurance
description: Audit completed work across requirements, implementation, tests, security, product, UX, compatibility, rollback, and release evidence. Use only in Graph Engineering verification, independent review, final audit, or release readiness. Read-only; never releases or publishes.
---

# Graph Release Assurance

Decide whether completed work is genuinely ready to hand off or release, using observed evidence rather than upstream claims.

## Select The Gate

1. Resolve references relative to this `SKILL.md` file.
2. Read [references/final-audit.md](references/final-audit.md) completely to check cross-stage consistency and decide whether the work may reach a release gate.
3. Read [references/release-gate.md](references/release-gate.md) completely only after the final audit passes or when the node focus explicitly requests release readiness.
4. Read both in that order for final end-to-end assurance.

## Graph Compatibility

- Use the references as audit rubrics. Keep the Graph node schema, current role, user goal, project rules, and safety boundary as the output contract.
- Remain read-only. Never repair source files from this skill; return failed checks to the owning implementation or correction skill.
- Inspect the current diff, actual build and test output, migrations and compatibility, security/privacy impact, rendered UX evidence when relevant, rollback, observability, external claims, flags, and secret hygiene.
- Preserve accepted risks and evidence gaps. Do not manufacture confidence from green CI alone.

## Verdict Boundary

- A final audit pass permits release-readiness evaluation; it does not authorize release.
- `GO` means ready for a separately authorized action. `GO_WITH_CONDITIONS` remains waiting until conditions have fresh evidence and the gate reruns. `NO_GO` routes remediation back to its owner.
- Never commit, push, deploy, publish, roll back, restart devices, alter live flags, or mutate remote systems.
- Completion after an authorized release requires separate proof of the action and post-action monitoring. Do not claim it from readiness evidence alone.
