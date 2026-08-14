---
name: graph-security-privacy
description: Review or remediate exploitable security, privacy, trust-boundary, secret, dependency, access-control, logging, and personal-data risks. Use in Graph Engineering for sensitive data, inputs, APIs, credentials, permissions, tracking, retention, deletion, or backups. Never expose secrets.
---

# Graph Security And Privacy

Follow data and trust boundaries, prove exploitability or privacy impact, and remediate root causes without exposing sensitive material.

## Apply The Rubric

1. Resolve references relative to this `SKILL.md` file.
2. Read [references/review-rubric.md](references/review-rubric.md) completely before reviewing or changing a security/privacy-sensitive surface.
3. In read-only nodes, inspect and report only. In write-enabled nodes, implement only validated repository-authorized remediation.

## Graph Compatibility

- Use the reference as the domain rubric. Keep the Graph node schema, current role, user goal, project rules, and safety boundary as the execution contract.
- Map attack surfaces, trust boundaries, sensitive data, sources, transformations, sinks, retention, deletion, backup, and logging before judging severity.
- Separate verified exposure from hypothesis, search for counter-evidence, merge duplicate instances into root causes, and cite current primary sources when a standard or platform policy is decisive.
- Never print, copy, decode, validate, or include secret values. Report only location and remediation or rotation needs.
- Reject guessed, typo-squatted, unpinned, unmaintained, unlicensed, or unverified dependencies.

## Decision Authority

- Automatically implement low-risk reversible hardening and confirmed local fixes in write-enabled nodes.
- Require an owner gate before authentication or authorization behavior changes, secret rotation, destructive privacy cleanup, production policy changes, payment security changes, or any remediation without a safe rollback.
- Never probe live systems, weaponize a finding, rotate credentials, deploy, or mutate remote services without separate explicit authorization.

## Verification

Verify the fixed source-to-sink path, negative cases, regression tests, secret absence, and affected privacy behavior. A passing test without closure of the demonstrated path is insufficient.
