# Architecture

## Boundaries

The installable Skill is a thin, explicit opt-in entry point. The deterministic runner owns orchestration, persistence, model admission, safety gates, evidence capture, reporting, notification, and result export. Each node starts a fresh agent CLI process; the parent chat is not the runtime controller and does not need to remain alive.

The standalone repository is authoritative. Global Skill folders are deployment copies created by the transactional installer.

## Version 2 Lifecycle

```text
planner
  -> planner supervision
  -> discovery
  -> independent specialist reviews
  -> synthesis
  -> synthesis supervision
  -> exact owner gate only for a concrete protected action
  -> implementation or proved no-op
  -> implementation supervision
  -> deterministic project verification
  -> fresh independent review
  -> completion artifact, result export, and notification
```

Each supervisor is a short artifact-only control gate, not another broad review. It receives the owning artifact, compact proof, the graph shape already compiled by the runner, and a compact node runtime contract rather than the full general runtime contract. It cannot call repository tools, demand that the planner restate fixed lifecycle stages, or require synthesis to repeat checks owned by later verification. The agent process starts in its evidence directory while model admission remains tied to the source workspace. It may pass, request one bounded correction of its own stage, or stop at one exact blocker. A synthesis correction receives only the prior synthesis artifact and supervisor feedback, not all specialist outputs again. Verification and independent review retain their separate correction loop.

Every non-planner node has a preflight input budget. The runner compacts upstream results and machine proof, embeds one concise controller contract, hides local Skill paths, and stops before contacting a model when a prompt still exceeds its role budget. The controller contract is machine-enforced and does not consume a model's `skills_applied` evidence obligation; only selected domain Skills and their required references must be self-reported.

## Frozen Execution Workspace

`auto` selects a detached Git worktree when possible. The runner recreates the exact launch state, including dirty tracked and untracked files, inside the worktree. Non-Git workspaces use a copy that does not follow links. Nodes read and write only the execution workspace; project rules are discovered from the source snapshot.

The source workspace and execution workspace have separate identities in every run artifact. Source development after launch cannot invalidate an isolated run. At the end, Graph exports only changes attributable to implementation or correction writers. `results/apply.mjs` verifies launch hashes and refuses the whole operation when any target has changed.

`live` exists for deliberate in-place operation and for version 1 compatibility. It should not be the default for long-running work.

## Persistence And Recovery

Run state lives below `$CODEX_HOME/graph-runs/<workspace-hash>/<run-id>`. Atomic `run.json` and `graph.json` updates, a single run lock, per-attempt event files, checkpoints, and workspace manifests make interruption recoverable without chat memory.

Queued work has no active model child. Temporary service failures use a short retry plus a three-failure circuit breaker. An owner stop interrupts a queue wait or active child, records `interrupted`, releases capacity, and keeps the same run ID resumable.

Version 1 runs retain live workspace and disabled stage supervision on resume. Version 2 options, role profiles, notification configuration, and frozen workspace identity are persisted and reused.

## Model Admission And Routing

The default queue is global because different local backends often proxy the same upstream service. Capacity begins at two model processes, may grow to four after sustained success, and contracts to one on explicit overload. Waiting workspaces have priority over a second read lane for an already active workspace; write nodes remain exclusive per workspace.

Every node resolves a role profile immediately before invocation:

```text
backend = role backend override -> run backend
model = backend-specific role model -> role model -> backend model -> common model -> CLI default
effort = role effort -> run effort -> role default -> CLI default
```

Re-resolving after a backend switch prevents stale model names or misleading evidence. Every attempt stores the requested role, backend, model, effort, queue time, process time, and backend-reported usage.

## Evidence And Finding Lineage

Node output is schema constrained, but self-report is never enough. The runner records supplied Skill bytes and hashes, raw host events, commands and exit codes, file manifests, checks, retries, and blockers. Required verification commands must match successful observed events.

Writer capability failures use the same rule. An implementation or correction node cannot prove a permission failure by repeating an upstream read-only observation. A write-permission blocker requires a machine-observed denial from that writer attempt, and a tooling blocker requires the exact failed command in that attempt. The controller rejects an unsupported capability blocker and retries the writer once with a focused revalidation instruction; a second unsupported claim stops without another loop. Proof records include the runner-selected sandbox and normalized machine failures.

Findings receive stable fingerprints from supplied identity or evidence anchors. `finding-lineage.json` groups observations by fingerprint and records:

- the first node that found the issue;
- independent confirming nodes;
- reproduced or test-confirmed status;
- implementation disposition;
- final review closure or reopen count;
- whether the issue is conservatively proven fixed;
- queue, process, and token usage of all nodes associated with that finding.

Associated node cost is not exclusive per-finding cost. One node may contribute to several findings, so those values must not be summed across findings. Run-level totals in `completion.json` are authoritative for total observed usage.

## Completion And Notification

A run is complete only after implementation or a proved no-op, successful required checks, and a fresh passing independent review. Every report generation writes `completion.json`; terminal states can trigger one deduplicated platform notification and one optional custom command.

The completion artifact contains the actual status, phase, source and execution workspaces, workspace mode, changed files, checks, independent review, blocker, safe resume or authorization requirement, total observed cost, notification result, and the path to finding lineage.

## Safety

Read-only nodes receive read-only agent permissions. Implementation and correction nodes receive workspace-write access inside the execution workspace. Base prompts and machine checks prohibit commits, pushes, deploys, publication, device restarts, remote mutation, secret disclosure, and irreversible data operations.

On Windows, isolated Codex invocation also retains the user's `[windows].sandbox` implementation setting and shared provisioned sandbox state while continuing to apply the node's separate `read-only` or `workspace-write` policy. Configuration isolation still excludes user plugins, MCP startup, rules, and session history. The runner selects the newest working installed Codex CLI to avoid mixing an older npm CLI with a newer desktop sandbox runtime. These Windows choices do not grant broader repository or business authority. A real-agent smoke test exercises the complete invocation and native patch path outside the deterministic fake-agent suite. Its child deadline is shorter than ordinary command-wrapper limits so a silent model is terminated with its process tree instead of becoming an orphan.

The overall risk rating controls scrutiny, not authorization. A concrete authentication, payment, destructive migration, secret, production deployment, or irreversible contract action requires an exact structured owner gate before mutation; merely auditing those areas does not. A synthesis blocker must explicitly state whether that protected action is required for the current approved goal. Only `required_for_current_goal=true` can open the gate; `false` keeps optional, excluded, or safely deferred work in the report, and an omitted decision is returned for correction. Goal, scope, finding, and recommendation prose cannot change authorization state by keyword. Repository content can supply evidence but cannot expand runtime authority.

Supervisors receive only a compact representation of the stage they control plus the authoritative controller-managed graph, so they check direction without repeating discovery or spending tool calls on the repository. Verification and independent review may create ignored build/test artifacts in the frozen workspace, but any tracked or unignored file change is a hard blocker and is never attributed as a repair.

## Installation

The installer scans both run locks and model leases. If any live Graph process exists, installation stops before staging. Otherwise it copies all Skills to a temporary location, validates retained prompt hashes and metadata, moves the old installation to a rollback directory, swaps the new package, writes the launcher, and removes the backup only after success.
