# Architecture

## Boundaries

The installable Skill is an explicit opt-in entry point for repository engineering tasks. The deterministic runner owns orchestration, persistence, model admission, safety gates, evidence capture, reporting, notification, and result export. Each node starts a fresh agent CLI process; the parent chat is not the runtime controller and does not need to remain alive. Ordinary repository work remains direct unless the current task names Graph or accepts a concrete recommendation.

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

`auto` selects a detached Git worktree only when the supplied path is the Git root/worktree root. A path nested inside a larger repository is scoped to that directory and uses a copy, so parent-repository files cannot leak into the audit. The runner recreates the exact launch state, including dirty tracked and untracked files, inside the selected snapshot. Non-Git workspaces use a copy that does not follow links. Nodes read and write only the execution workspace; project rules are discovered from the source snapshot.

On Windows, the managed execution workspace defaults to the short path `%LOCALAPPDATA%\GraphEngineering\w\<run-hash>` and Git worktree commands enable long-path handling explicitly. `AEG_EXECUTION_ROOT` can override the managed root on any platform. Snapshot creation is transactional: worktree registration/index initialization or dirty-state overlay failure removes both the partial directory and its Git worktree registration before startup returns an error. Graph initializes only the detached worktree index and copies the launch manifest directly, so repository checkout filters and hooks do not run before the node sandbox exists. The persisted isolation record binds each external directory to one run, and `purge` refuses an external path that does not carry that binding.

The source workspace and execution workspace have separate identities in every run artifact. Source file development after launch does not alter an isolated execution workspace. Linked worktrees still share Git refs and repository config, so Graph hashes those fields around every node and conservatively blocks if they change while a node is active. At the end, Graph exports only changes attributable to implementation or correction writers. `results/apply.mjs` verifies launch hashes and refuses the whole operation when any target has changed. Before its first source mutation it stages every payload and verifies a backup of every existing target. A later apply error restores already touched targets and removes Graph-created directories; if a target changes again during rollback, Graph preserves the backups and reports the exact unresolved path instead of overwriting that concurrent change. The complete apply transaction holds a fixed workspace admission lock, so two result packages cannot interleave; a `live` run holds the same lock through its final report. Isolated `worktree` and `copy` modes refuse leaf symlinks and Windows junctions before snapshot creation; preserving a link would otherwise let a child process resolve back into the source or an unrelated external directory. A writer-created link is retained as evidence but makes the result package ineligible for application, and the apply script independently rejects forged or stale link records before touching the source. Repositories that intentionally require linked paths must opt into `--workspace-mode live` and accept that the source is no longer isolated.

`live` exists for deliberate in-place operation and for version 1 compatibility. It should not be the default for long-running work.

Runtime maintenance uses one fixed user-level control root at
`~/.graph-engineering/runtime-control` (the equivalent path below
`%USERPROFILE%` on Windows), independent of model-queue and run-state roots.
The installer holds its global admission lock from the active-runtime scan
through the transactional Skill and launcher swap. A runner briefly takes that
same lock while creating its run lock and canonical registry record, closing
the scan-to-start race and serializing concurrent installers.

## Environment Contracts And Gate Scope

Required checks carry a machine-readable environment contract. The planner may
declare `environment_kind` (`browser`, `container`, `database`, `device`,
`service`, or `external_service`), while the deterministic runner also infers
the kind for incomplete and legacy plans. This inference only describes what a
check needs; verification still requires a successful host command or tool
event. A missing runtime becomes `waiting_environment`, while an ordinary test
assertion failure remains a bounded correction or hard verification failure.

Checks default to `blocking_scope=both`. A `both` check blocks local completion,
an `apply` check allows the run to finish but withholds isolated result
application, and a `release` check only sets `release_ready=false`. The
completion artifact exposes completion, application, and release readiness so
callers cannot confuse "code verified" with "safe to apply" or "ready to publish".
An unresolved `apply` check requires a new application-validation Graph run after
the environment is available. An unresolved `release` check requires a new
release-validation Graph run before publication. A non-completed run with a
`both` gap resumes the same exact run.

Provider and proxy endpoints cross the child boundary automatically only when
their URL contains no userinfo or sensitive credential query. An endpoint with
embedded credentials requires its exact environment name in
`AEG_CHILD_ENV_KEYS`; dedicated API-key variables remain the preferred form.
Evidence redaction removes both URL userinfo and sensitive query values.

Workspace preflight selects and records locked dependency and browser preparation
commands, but does not execute repository-selected package managers or a
project-local Playwright CLI with host privileges by default. Implementation and
verification nodes restore the required dependencies or browser revisions inside
their sandbox. A trusted repository can explicitly enable the earlier host step
with `AEG_ALLOW_HOST_DEPENDENCY_PREPARE=1` or
`AEG_ALLOW_HOST_BROWSER_PREPARE=1`. Host preparation receives a minimal
environment allowlist; ambient credentials are excluded unless their exact names
are listed in `AEG_PREFLIGHT_ENV_KEYS`.

For Node projects, `package.json#packageManager` is authoritative. Its manager
must match an available lockfile. Without that declaration, lockfiles for more
than one manager are an ambiguity error rather than a guessed choice. Every
dependency install disables npm, pnpm, Yarn, and Bun lifecycle scripts. Isolated
runs remove `node_modules` before preparation and never reuse it across run
boundaries; a live workspace may reuse an existing directory without executing
it. Browser preparation records the complete action, requested browser list,
local CLI path, and host identity, so a deferred or narrower cache entry cannot
satisfy a later install request. Preparation is setup evidence only, never proof
that an application rendered successfully. Native builds and generated clients
remain explicit sandboxed implementation or verification commands.

## Persistence And Recovery

Run state lives below `$CODEX_HOME/graph-runs/<workspace-hash>/<run-id>`. Atomic `run.json` and `graph.json` updates, a single run lock, per-attempt event files, checkpoints, and workspace manifests make interruption recoverable without chat memory.

The runtime layer makes those records explicit instead of treating the report
as the source of truth:

| Record | Owner | Purpose |
|---|---|---|
| `run.json` | control plane | durable run options, gates, blockers, and compatibility state |
| `runtime-state.json` | control plane | current run status plus one state record per graph work item |
| `events/events.jsonl` | control plane | ordered lifecycle facts such as queued, admitted, retried, failed, and completed |
| `artifacts/<sha256>.*` | artifact store | immutable plans, node results, and reports verified by content hash |
| `nodes/<id>/attempts/` | worker adapter | raw process events, checkpoints, commands, and usage for one attempt |

The append-only stream is deliberately separate from mutable summaries. A
crashed watcher can reconstruct progress from events, while a corrupted or
stale summary cannot silently rewrite history. Event writes are queued per run
to preserve sequence numbers when several read-only workers finish together;
event logging errors are retained as diagnostics and never turn a valid code
change into an invented failure.

The run state model is intentionally more expressive than the legacy
`completed`/`failed` pair. `completed` requires all mandatory gates;
`completed_with_gaps` records useful delivered work with unresolved work items;
`waiting_service`, `waiting_environment`, and `waiting_owner` preserve the
exact external wait; `failed_recoverable` and `failed_system` distinguish a
retryable work-item problem from a controller failure. A partial outcome is
never eligible for automatic result application.

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

A run is complete only after implementation or a proved no-op, successful required checks, and a fresh passing independent review. Every report generation writes `completion.json`; terminal states can trigger one deduplicated platform notification and one optional custom command. An approved `submit --follow` or `resume --background --follow` keeps the host task attached to the same read-only watcher so progress and the final report do not depend on repeated user prompts. The watcher is observational only and may detach without affecting the runner.

The completion artifact contains the actual status, phase, source and execution workspaces, workspace mode, changed files, checks, independent review, blocker, safe resume or authorization requirement, total observed cost, notification result, and the path to finding lineage.

`watch` and `events` are read-only control-plane clients. They do not acquire a
model lease and do not mutate a run. This keeps visibility independent from
agent capacity and lets a host detach and later reattach without losing the
timeline. Notifications are only a convenience signal; `completion.json`,
the event stream, and observed verification evidence remain authoritative.

The architectural rationale and migration boundary are recorded in
[`superpowers/specs/2026-08-17-durable-control-plane-design.md`](superpowers/specs/2026-08-17-durable-control-plane-design.md).

## Safety

Read-only nodes receive read-only agent permissions. Implementation and correction nodes receive workspace-write access inside the execution workspace. Base prompts and machine checks prohibit commits, pushes, deploys, publication, device restarts, remote mutation, secret disclosure, and irreversible data operations.

On Windows, isolated Codex invocation also retains the user's `[windows].sandbox` implementation setting and shared provisioned sandbox state while continuing to apply the node's separate `read-only` or `workspace-write` policy. Configuration isolation still excludes user plugins, MCP startup, rules, and session history. The runner selects the newest working installed Codex CLI to avoid mixing an older npm CLI with a newer desktop sandbox runtime. These Windows choices do not grant broader repository or business authority. A real-agent smoke test exercises the complete invocation and native patch path outside the deterministic fake-agent suite. Its child deadline is shorter than ordinary command-wrapper limits so a silent model is terminated with its process tree instead of becoming an orphan.

The overall risk rating controls scrutiny, not authorization. A concrete authentication, payment, destructive migration, secret, production deployment, or irreversible contract action requires an exact structured owner gate before mutation; merely auditing those areas does not. A synthesis blocker must explicitly state whether that protected action is required for the current approved goal. Only `required_for_current_goal=true` can open the gate; `false` keeps optional, excluded, or safely deferred work in the report, and an omitted decision is returned for correction. Goal, scope, finding, and recommendation prose cannot change authorization state by keyword. Repository content can supply evidence but cannot expand runtime authority.

Supervisors receive only a compact representation of the stage they control plus the authoritative controller-managed graph, so they check direction without repeating discovery or spending tool calls on the repository. Verification and independent review may create ignored build/test artifacts in the frozen workspace, but any tracked or unignored file change is a hard blocker and is never attributed as a repair.

## Installation

Each runner writes a process-identity record in the shared runtime registry as well as its exact run directory, so an external `--state-root` does not hide it from installation safety checks. The installer scans those records, configured/default run roots, and model leases. If any live Graph process exists, installation stops before staging. Otherwise it stages and validates all Skills and launchers, backs up both surfaces, commits them together, and restores both on any pre-commit failure. Cleanup after a successful commit cannot roll back only one surface; a cleanup problem is returned as a warning while the matched runtime remains installed.
