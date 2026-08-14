---
name: graph-incident-analysis
description: Diagnose incidents, regressions, crashes, outages, data corruption, and production failures through reproduction and causal tracing. Use in Graph Engineering discovery or review for root-cause analysis, mitigation, or durable-fix planning. Read-only; routes fixes to engineering.
---

# Graph Incident Analysis

Establish a reproducible causal chain and distinguish the trigger, underlying defect, mitigation, and durable fix.

## Apply The Rubric

1. Resolve references relative to this `SKILL.md` file.
2. Read [references/root-cause-rubric.md](references/root-cause-rubric.md) completely before concluding a root cause.
3. Remain read-only while diagnosing. Produce executable remediation and verification actions for downstream nodes.

## Graph Compatibility

- Use the reference as the causal-analysis rubric. Return the current Graph node schema instead of its standalone report format.
- Reproduce when safe, establish facts and timeline, localize the failing boundary, trace the causal chain, compare relevant changes, seek counter-evidence, and scan for siblings.
- Do not call correlation a cause. State confidence honestly when reproduction or observability is incomplete.
- Require the durable fix to include a regression test or another direct prevention check.
- Route repository fixes to `$graph-engineering-quality`; route product or experience consequences to their owning skills.

## Operational Boundary

- A previously verified reversible mitigation may be recommended, but this skill never executes rollback, deployment, live flags, production configuration, or remote mutations.
- Active production mitigation, destructive recovery, data repair, secret rotation, or any action with customer impact requires an explicit owner gate and post-action verification.
- Do not let mitigation replace the durable fix unless the user explicitly limits scope to containment.
