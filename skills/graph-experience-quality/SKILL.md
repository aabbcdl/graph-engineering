---
name: graph-experience-quality
description: Review or repair UX, accessibility, content, layout, localization, feedback, recovery, and UI states. Use in Graph Engineering for screens, flows, forms, navigation, components, long text, loading, or errors. Require rendered evidence before claiming visual completion.
---

# Graph Experience Quality

Apply the original UX/UI review and improvement standards with rendered evidence as the deciding surface.

## Select The Rubric

1. Resolve references relative to this `SKILL.md` file.
2. In `discovery`, `review`, `synthesis`, or `independent_review` work, read [references/review-rubric.md](references/review-rubric.md) completely.
3. In `implementation` or `correction` work, read [references/execution-rubric.md](references/execution-rubric.md) completely.
4. For review-only requests, remain read-only.

## Graph Compatibility

- Use the selected reference as the experience rubric. Keep the Graph node schema, current role, user request, project instructions, and safety rules as the execution contract.
- Do not equate source-code appearance with rendered behavior. Inspect the actual interface whenever the environment permits it.
- Cover relevant loading, empty, error, disabled, success, long-content, localization, keyboard, accessibility, responsive, and navigation states.
- Reuse the existing design system and product intent. Avoid unrelated visual redesign.
- In write-enabled nodes, implement validated reversible fixes and preserve functional behavior unless the finding requires a deliberate behavior change.

## Decision Authority

- Automatically fix evidence-backed usability, accessibility, state, content, and layout defects when the change is reversible.
- Record uncertain aesthetic preferences as hypotheses; do not present taste as a defect.
- Require an owner gate for material brand changes, legally significant consent experiences, payment dark-pattern concerns, or irreversible journey changes.
- Never publish or deploy from this skill.

## Visual Gate

A visual change passes only with fresh rendered evidence at representative desktop/mobile or device sizes and the relevant UI states. If rendering is unavailable, report the exact evidence gap and do not claim visual completion.
