---
name: autonomous-engineering-graph
description: Run a durable multi-agent repository audit-and-repair graph with isolated execution, stage supervision, role-based model routing, machine-observed evidence, live progress, and independent verification. Use only when the user explicitly names Graph Engineering in the current task or explicitly accepts a concrete Graph recommendation. Do not use implicitly for ordinary repository work.
---

# Graph Engineering

Use the bundled runner for one explicitly approved repository task. Do not imitate graph stages in the parent task and do not use Graph to modify Graph itself.

## Explicit Invocation Boundary

Invoke this Skill only when the user, in the current task, explicitly names
Graph Engineering, `graph-engineering`, or `$autonomous-engineering-graph`, or
explicitly accepts a concrete Graph recommendation made by the host. A prior
task's approval, a standing preference, inferred intent, task size, multiple
files, review scope, or autonomous wording is not approval for a new run.

Ordinary review, debugging, implementation, refactoring, testing,
configuration, documentation, and release work stays in the current task.
Pass `--user-approved` only after the current-task opt-in above; it records run
creation approval and never bypasses owner gates or protected-action policy.

Graph runner or Skill maintenance and Graph lifecycle commands (`status`,
`watch`, `queue`, `stop`, `resume`, `purge`, `validate`) are handled directly
and never create a new run. Never invoke Graph recursively from a Graph node
(the controller contract or `GRAPH_RUN_ID` is authoritative).

Before launch, state the workspace and goal, that several fresh agent processes
will run, that each node may take minutes, and that shared model capacity may
queue work. Submit exactly one background run. The same host task must remain
attached to the runner's read-only progress stream after `handoff: confirmed`;
the user must not need to ask for status or say "continue".

## Start

Prefer the background command for unattended work:

```powershell
graph-engineering submit --workspace "<absolute path>" --goal "<exact goal>" --user-approved --follow
```

`--follow` first returns the confirmed handoff, then attaches the same command
to persisted progress until a terminal state. It does not hold a model lease,
resume a paused run, or stop the background runner if the display detaches.
Relay meaningful state changes in the task; do not narrate unchanged snapshots
or repeatedly call `status`. On a terminal state, immediately read
`report.md`, `completion.json`, and `finding-lineage.json`, then report the
observed result and exact next action.

Use `start` only for deliberate foreground execution. Launch exactly one
runner command. Do not implement the same goal in the parent task or start a
duplicate while the approved run is active or queued.

Version 3 defaults to:

- `--workspace-mode auto`: frozen Git worktree when the supplied path is the Git root/worktree root, or a frozen copy for non-Git and nested paths;
- `--supervision stage`: artifact-only control gates after planning, synthesis, and implementation; supervisors do not inspect the repository or repeat discovery;
- `--notify`: one notification for each distinct terminal state.

Use `--mode review` when the user wants an assessment only. The runner then
compiles discovery, specialist review, synthesis, synthesis supervision, and
one fresh independent review, all read-only. It does not create implementation,
verification, correction, or result-application stages; runtime, device, and
release checks are explicitly deferred and recorded as such. `--minimal` never
turns a review-mode run into a writer or verifier.

In `--workspace-mode copy`, the execution snapshot intentionally has no `.git`.
The runner records the source repository's launch-time HEAD, refs/config hashes,
and short status in `source-repository-before.json` and uses that evidence for a
matching Git-state requirement. Nodes do not run Git commands against the
user's source repository to compensate for the copied boundary.

For an already-running exact run, attach the same read-only display manually:

```powershell
graph-engineering watch --workspace "<absolute path>" --run "<run-id>"
```

`watch` and `--follow` only read persisted run state and queue records. They show the current
phase, node checkpoint count, queue position, last progress time, next node,
and blocker, then exit when the run reaches a terminal state. `--once --json`
is suitable for a script or a desktop/session monitor. It never resumes,
stops, or creates a run, and Ctrl+C only detaches the display.

For a replayable lifecycle timeline, use the read-only event command:

```powershell
graph-engineering events --workspace "<absolute path>" --run "<run-id>" --since 0
```

Repeat `--type <event>` to filter event kinds. It reads
`events/events.jsonl`, never acquires a model lease, and never changes run
state. The event stream is the durable explanation for queue admission,
attempts, retries, service pauses, work-item outcomes, and terminal delivery.

The broad-audit default is up to six specialist review nodes. Use the explicit
`--max-review-nodes <1-6>` option only for a deliberately scoped or evaluation
run; the chosen limit is persisted and reused on resume, and a reduced limit
must be called out in the final evidence because it trades coverage for cost.

An overall `high` risk plan increases scrutiny but does not request owner authorization. The planner records scope, risk, exclusions, and checks; it cannot create an owner gate. Only synthesis may create an owner gate, through a structured blocker naming one concrete protected action with `required_for_current_goal=true`. Optional, excluded, or safely deferred protected work uses `false` and remains in the report; an omitted decision is corrected rather than guessed. Goal, scope, finding, or recommendation text cannot open a gate by keyword. Verification may generate ignored build/test artifacts inside the frozen workspace; if it changes a tracked or unignored project file, the runner blocks the run instead of treating that change as a repair.

Use `--workspace-mode live` only when the user deliberately wants in-place execution. Isolated results are exported but never merged automatically.

On Windows, managed snapshots use `%LOCALAPPDATA%\GraphEngineering\w\<run-hash>` and explicit Git long-path support. `AEG_EXECUTION_ROOT` may select another short local root. A snapshot startup failure must clean its partial directory and worktree registration before returning; `purge` removes only the exact managed workspace bound into that run's isolation record.

## Resume And Stop

Resume one exact saved run:

```powershell
graph-engineering resume --background --follow --workspace "<absolute path>" --run "<run-id>"
```

A background resume is successful only when the command returns `handoff: confirmed`; `--follow` then monitors that same run. Resume only after the user asks to continue that exact run. If several incomplete runs exist, require a run ID instead of guessing. Version 1 runs retain their legacy live/no-supervision behavior.

An owner-gated run still requires current explicit approval of the exact protected scope:

```powershell
graph-engineering resume --background --follow --workspace "<absolute path>" --run "<run-id>" --authorize "<exact approved scope>"
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

Claude nodes always use runner-generated fail-closed native sandbox settings. `ANTHROPIC_BASE_URL` is inherited when it contains no embedded credential; environment-only credentials and credential-bearing routing URLs cross the child boundary only when the user explicitly names their variables in `AEG_CHILD_ENV_KEYS`. Codex custom providers use the same explicit projection through `model_providers.<id>.env_key`; a real isolated child rejects any declared `experimental_bearer_token` and never copies it. Attempt evidence records names, never values, URL credentials are redacted, and execution-control variables remain prohibited. On Windows, automatic fallback may select Claude only after the packaged writer and read-only denial smoke probes both pass for the current runner and Claude binary. Explicit Claude routing is still allowed, but an unavailable native sandbox stops that attempt rather than running unsandboxed.

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

The runner injects a compact controller contract and enforces it directly. Nodes record `skills_applied` evidence for selected domain Skills and required references, but do not self-report `autonomous-engineering-graph` as a domain Skill. Verification and independent review have a larger 256000-byte input budget because they aggregate required checks and multiple domain reviews. Upstream artifacts and proof are compacted by role through standard, tight, minimal, and emergency levels; an oversized node prompt is stopped before any model process starts with every compaction attempt retained.

For isolated runs, report the result package and apply command. Do not run it unless applying the result is within the user's request. The apply script must reject source files changed since launch.

Notifications are best effort and do not prove completion. A custom `--notification-command` receives `GRAPH_RUN_ID`, `GRAPH_STATUS`, `GRAPH_WORKSPACE`, `GRAPH_EXECUTION_WORKSPACE`, `GRAPH_REPORT`, and `GRAPH_COMPLETION_JSON`.

Never describe `queued`, `recovering`, `waiting_service`, `waiting_owner`, `interrupted`, `blocked`, or `failed` as complete. Report only files, checks, Skill hashes, and outcomes present in retained machine evidence.

The runtime also distinguishes `completed_with_gaps` and `waiting_environment`.
The former means at least one work item was delivered while another item or
mandatory gate remains unresolved; it is a terminal partial result and never
produces an apply command. The latter means a required environment is absent
and must remain an explicit wait. Do not collapse either status into
`completed`, and do not hide successful work items merely because a later node
failed.

Read [references/graph-contract.md](references/graph-contract.md) before changing runtime behavior, schemas, evidence, isolation, notifications, or safety. Read the lifecycle references before changing routing, authority, budgets, or release semantics.
