---
name: graph-requirements-design
description: Review ambiguity, feasibility, edge cases, testability, and scope, then design reversible repository-grounded features. Use in Graph Engineering discovery or review before a feature, behavior change, public contract, workflow, or cross-module design. Plans only.
---

# Graph Requirements And Design

Turn intent into testable requirements and an executable repository-grounded design without silently expanding scope.

## Select The Rubric

1. Resolve references relative to this `SKILL.md` file.
2. Read [references/requirements-review.md](references/requirements-review.md) completely when the input requirement has not passed a quality review or when ambiguity, missing cases, feasibility, or acceptance criteria are in question.
3. Read [references/feature-design.md](references/feature-design.md) completely after the requirement is ready for design or when the node focus explicitly requests a technical design.
4. Read both in that order for an end-to-end requirement-to-design review.

## Graph Compatibility

- Use the references as analysis rubrics. Return the current Graph node schema rather than their standalone report formats.
- Remain read-only. Do not implement product source changes with this skill.
- Ground feasibility, reuse, contracts, data changes, failure paths, compatibility, rollout, and verification in current repository evidence.
- Preserve the requested outcome and reject gold-plating. Name assumptions and open decisions instead of inventing them.
- Produce ordered executable actions and done conditions that an implementation node can consume.

## Decision Authority

- Resolve low-risk questions from existing patterns and tests.
- Choose reversible compatibility-preserving defaults for medium-risk ambiguity and record them.
- Require an owner gate for authentication or authorization design, payment or entitlement decisions, destructive data migration, secrets, production infrastructure, irreversible public contracts, or a design without a safe rollback.

## Handoff

Route engineering tasks to `$graph-engineering-quality`, product tasks to `$graph-product-quality`, experience tasks to `$graph-experience-quality`, and security/privacy review to `$graph-security-privacy`. A design is not complete until each task has evidence, dependencies, validation, rollout or rollback, and a concrete done definition.
