---
name: autonomous-engineering-graph
description: Run a user-approved repository audit-and-repair task as a durable multi-agent graph with isolated execution, stage supervision, role-based model routing, machine-observed evidence, and independent verification. Use only when the user explicitly names Graph Engineering, `graph-engineering`, or `$autonomous-engineering-graph` in the current task, or explicitly accepts a concrete Graph recommendation. Never infer approval from task size, complexity, multiple files, review scope, or autonomous wording.
---

# Graph Engineering

Use the bundled runner for one explicitly approved Graph task. Do not imitate graph stages in the parent task and do not use Graph to modify Graph itself.

## Approval Boundary

Start a new run only when the user explicitly requests Graph by naming it in the current task, or explicitly approves a concrete Graph recommendation. Approval never carries across tasks.

Without current-task approval, handle the work directly. This includes broad review, known bugs, decided implementation, refactoring, documents, images, and ordinary repository exploration. If Graph would materially help, recommend it once with its scope and expected cost, then wait.

Before launch, state the workspace and goal, that several fresh agent processes will run, that each node may take minutes, and that shared model capacity may queue work.

## Start

Prefer the background command for unattended work:

```powershell
graph-engineering submit --workspace "<absolute path>" --goal "<exact goal>" --user-approved
```

Use `start` only when the current host will wait on the same process. Launch exactly one command. Do not implement the same goal in the parent task, start duplicates, or spend model turns polling an unchanged queue.

Version 2 defaults to:

- `--workspace-mode auto`: frozen Git worktree, or a frozen copy for non-Git workspaces;
- `--supervision stage`: artifact-only control gates after planning, synthesis, and implementation; supervisors do not inspect the repository or repeat discovery;
- `--notify`: one notification for each distinct terminal state.

An overall `high` risk plan increases scrutiny but does not request owner authorization. A gate is created only by a structured planning decision or synthesis blocker naming one concrete protected action with `required_for_current_goal=true`. Optional, excluded, or safely deferred protected work uses `false` and remains in the report; an omitted decision is corrected rather than guessed. Goal, scope, finding, or recommendation text cannot open a gate by keyword. Verification may generate ignored build/test artifacts inside the frozen workspace; if it changes a tracked or unignored project file, the runner blocks the run instead of treating that change as a repair.

Use `--workspace-mode live` only when the user deliberately wants in-place execution. Isolated results are exported but never merged automatically.

## Resume And Stop

Resume one exact saved run:

```powershell
graph-engineering resume --background --workspace "<absolute path>" --run "<run-id>"
```

A background resume is successful only when the command returns `handoff: confirmed`. If several incomplete runs exist, require a run ID instead of guessing. Version 1 runs retain their legacy live/no-supervision behavior.

An owner-gated run still requires current explicit approval of the exact protected scope:

```powershell
graph-engineering resume --workspace "<absolute path>" --run "<run-id>" --authorize "<exact approved scope>"
```

Never fabricate or broaden `--authorize`. Do not pass it to a service-paused or ordinarily interrupted run.

Stop one exact run recoverably:

```powershell
graph-engineering stop --workspace "<absolute path>" --run "<run-id>"
```

Use `--force` only when that exact legacy runner cannot acknowledge the cooperative stop. Never kill inferred or all Graph processes.

## Capacity And Service Failure

The Skill consumes no model slot; node processes do. The shared adaptive queue starts at two model processes, grows after stable success up to four, and contracts on explicit overload. Waiting workspaces take priority over an extra read lane; writers remain exclusive per workspace.

For one shared gateway, run two projects concurrently by default. A third may wait without consuming tokens. Use endpoint-scoped admission only for genuinely independent model services.

```powershell
graph-engineering queue
```

After three consecutive temporary service failures, the runner records `waiting_service`, releases capacity, retains the run ID and checkpoint, and exits without a fourth request. Resume after the service recovers.

## Role Profiles

Every node is a fresh Codex or Claude CLI process, not the current chat session. It uses that CLI's configuration unless overridden.

On Windows, isolated Codex nodes retain the configured `[windows].sandbox` implementation and shared provisioned sandbox state while the runner still applies each node's separate `read-only` or `workspace-write` policy. User plugins, MCP startup, rules, and session history remain excluded. The runner prefers the newest working installed Codex CLI to prevent desktop/CLI sandbox version conflicts. These choices do not expand Graph authority.

Use repeated role assignments when cost or capability needs differ:

```powershell
--role-backend "planner=codex,review=claude"
--role-model "codex.planner=<model>"
--role-model "review=<model>"
--role-effort "planner=xhigh,supervisor=high,review=medium"
```

Roles are `planner`, `supervisor`, `discovery`, `review`, `synthesis`, `implementation`, `correction`, `verification`, and `independent-review`. Requested backend, model, effort, queue time, duration, and available token use are persisted for every attempt.

## Evidence And Results

Read `report.md` before reporting an outcome. Also inspect:

- `completion.json` for real status, checks, files, independent review, blocker, and run-level cost;
- `finding-lineage.json` for each issue's first discoverer, independent confirmation, validation, repair, final review, reopen count, and associated node cost;
- `results/` for isolated output and the generated conflict-checked apply command.

Associated node cost is not exclusive per-finding cost and must not be summed across findings. Missing usage remains unknown; never estimate it.

Implementation and correction capability blockers require evidence from the current writer attempt. A write-permission blocker needs a machine-observed write denial; a tooling blocker needs the exact failed command. Upstream read-only observations do not satisfy either rule. The runner rejects an unsupported capability blocker, performs one focused writer retry, and stops after a second unsupported claim instead of looping.

The runner injects a compact controller contract and enforces it directly. Nodes record `skills_applied` evidence for selected domain Skills and required references, but do not self-report `autonomous-engineering-graph` as a domain Skill. Upstream artifacts and proof are compacted by role, synthesis correction receives only the prior synthesis plus supervisor feedback, and an oversized node prompt is stopped before any model process starts.

For isolated runs, report the result package and apply command. Do not run it unless applying the result is within the user's request. The apply script must reject source files changed since launch.

Notifications are best effort and do not prove completion. A custom `--notification-command` receives `GRAPH_RUN_ID`, `GRAPH_STATUS`, `GRAPH_WORKSPACE`, `GRAPH_EXECUTION_WORKSPACE`, `GRAPH_REPORT`, and `GRAPH_COMPLETION_JSON`.

Never describe `queued`, `recovering`, `waiting_service`, `waiting_owner`, `interrupted`, `blocked`, or `failed` as complete. Report only files, checks, Skill hashes, and outcomes present in retained machine evidence.

Read [references/graph-contract.md](references/graph-contract.md) before changing runtime behavior, schemas, evidence, isolation, notifications, or safety. Read the lifecycle references before changing routing, authority, budgets, or release semantics.
