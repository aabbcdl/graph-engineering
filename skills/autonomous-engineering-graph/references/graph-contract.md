# Graph Engineering Contract

## Contents

1. Purpose
2. Graph shape
3. Node contract
4. Evidence and honesty
5. State and recovery
6. Agent backends
7. Workspace isolation
8. Stage supervision
9. Finding contribution and cost
10. Notifications
11. Safety boundaries
12. Completion rules

## Purpose

The graph turns one user goal into bounded, independently verifiable units of work. A node is one fresh agent loop. Edges carry artifacts and gate results, not conversation history. The runner owns routing, global model admission, retries, persistence, and the factual portion of the final report.

The graph is not the default route for repository engineering work. The host
starts a new run only when the current task explicitly names Graph Engineering
or the user explicitly accepts a concrete Graph recommendation. Task size,
multiple files, review wording, autonomy, or approval from another task never
counts as current approval. The host records current approval as the run's
`user_approved` marker before state is created. That marker authorizes creating
the run, not protected mutations. Pure conversation, Graph maintenance and
control commands, and an explicit no-Graph request stay outside the route, and
Graph nodes never invoke Graph recursively.

## Graph Shape

Every compiled run contains these mandatory stages:

```text
planner
  -> planner supervision
  -> discovery
  -> zero or more parallel specialist reviews
  -> synthesis
  -> synthesis supervision
  -> owner gate only for a concrete protected action
  -> implementation
  -> implementation supervision
  -> verification
  -> independent review
  -> local evidence report
```

Verification or independent-review failure creates a bounded correction node and returns to verification. The runner never retries a failed gate without an intervening correction or a newly recorded hypothesis.

The planner may add read-only specialist reviews. It may not remove stage supervision, synthesis, implementation/no-op confirmation, verification, independent review, or final evidence reporting. Version 1 runs retain their saved no-supervision graph when resumed; new version 2 runs use all three supervision gates by default. Writers are serialized by default.

## Node Contract

Each node has:

- a stable ID and kind;
- explicit dependencies;
- one bounded role and focus;
- selected skills from a discovered catalog;
- read-only or workspace-write access;
- a maximum attempt count;
- structured output validated by `node-result.schema.json`;
- before/after workspace manifests;
- raw host events and a machine-derived proof record.

Node terminal states are `completed`, `needs_retry`, `blocked`, or `skipped`. A skipped node requires a concrete reason and may not bypass a mandatory gate. Gate values are `pass`, `fail`, `blocked`, or `not_applicable`.

## Evidence And Honesty

Evidence has three levels:

1. `machine_observed`: captured by the runner from process exit state, JSONL tool events, workspace hashes, or generated files.
2. `agent_reported`: present only in the node's structured response.
3. `unverified`: claimed without corresponding machine or artifact evidence.

The final report separates these levels. Agent-reported commands are compared with commands observed in host events. Selected domain Skills are read by the runner, hashed, and embedded in the exact node input saved on disk. Models record concrete application evidence for those domain Skills and required references. The compact `autonomous-engineering-graph` node contract is enforced and recorded by the runner itself, so it is excluded from model self-report requirements. This proves instruction delivery, not perfect model compliance; compliance is judged through required artifacts and independent gates.

The independent reviewer receives current repository state, upstream result artifacts, and proof records in a fresh session. It does not receive the executor's hidden reasoning or conversation.

## State And Recovery

Run state lives under:

```text
$CODEX_HOME/graph-runs/<workspace-hash>/<run-id>/
```

Required files:

```text
run.json
graph.json
workspace-before.json
workspace-after.json
nodes/<node-id>/input.md
nodes/<node-id>/result.json
nodes/<node-id>/events.jsonl
nodes/<node-id>/stderr.log
nodes/<node-id>/proof.json
nodes/<node-id>/attempts/attempt-<n>/events.jsonl
nodes/<node-id>/attempts/attempt-<n>/stderr.log
nodes/<node-id>/checkpoint.json
report.md
completion.json
finding-lineage.json
workspace-isolation.json
source-workspace-before.json
results/metadata.json
results/apply.mjs (only when all mandatory gates pass)
```

Version 2 runtime records also include:

```text
runtime-state.json
events/events.jsonl
artifacts/<sha256>.*
artifacts/<sha256>.meta.json
```

`runtime-state.json` is the current projection of run/work-item state;
`events/events.jsonl` is the append-only lifecycle history; artifacts are
content-addressed immutable inputs and results. Mutable projections can be
rebuilt or inspected without rewriting the event history. Use
`graph-engineering events --workspace <path> --run <id>` for a read-only view;
it never contacts a model or changes the run.

Writes to `run.json` and `graph.json` are atomic. A run lock is held from planning through the final report, so two processes cannot advance the same run and an owner stop can identify its exact process. Runtime maintenance uses the fixed user-level `~/.graph-engineering/runtime-control` root. The installer holds its global admission lock from active-runtime scan through the transactional runtime and launcher swap; a runner holds the same lock only while creating its run lock and canonical registry record. This closes runner-start and concurrent-installer races without coupling maintenance to a custom state or model-queue root. A `live` run additionally holds the source workspace application lock until its final report. A detached start or resume reports success only after the child passes snapshot checks, acquires these locks, saves the resumed configuration, and returns an explicit handoff acknowledgement; pre-handoff failure is returned to the launching command. Model admission uses persistent request records and active leases. Global capacity starts at two, grows after three successful calls up to four, and contracts after an explicit `429`, `5xx`, or structured capacity rejection as low as one. A workspace may hold up to two read-only leases, but a waiting workspace without a lease is admitted before an extra read lease for an already active workspace. A write lease is exclusive within its workspace. `--queue-scope endpoint` is an explicit opt-in for configurations whose resolved endpoints genuinely have independent capacity. Every process retry keeps its own raw artifacts while the node root points to the latest attempt. Failed attempts also update `checkpoint.json` with bounded machine-visible commands, tool calls, agent messages, errors, and usage. Resume injects that checkpoint so the node can reuse observed facts without claiming to recover hidden reasoning. Resume reuses only nodes with a valid result and proof file. Failed, interrupted, or invalid nodes rerun without discarding successful independent siblings. A planner process failure produces a resumable report.

Resume preserves the original new-run approval marker, backend, fallback policy, queue scope, model, role profiles, isolation mode, supervision mode, notifications, timeouts, and correction settings unless an allowed resume option explicitly overrides the corresponding execution setting. When more than one incomplete run exists for a workspace, the runner requires an exact run ID and never guesses which task the owner intended. `reconcile` marks a `running` record as `interrupted` only when no live owner process holds its lock; it never deletes evidence or changes an active run. If the Skill, a specialist reference, or a shared controller reference changes after planning, the current process records `RUNTIME_UPDATED` and exits without an ordinary process retry. A new process resumes the same run ID and loads the updated definition set; mixing old manifest hashes with new instruction content inside one process is forbidden.

For change attribution, a path observed by a Graph writer is not sufficient proof that the final version belongs to that writer. The runner compares the final file or link fingerprint with the writer's post-node manifest; a mismatch is recorded as unattributed workspace drift and suppresses the restore command.

Temporary `429`, `5xx`, timeout, disconnect, and connection failures enter the affected run's persisted `recovering` state. Only an explicit `429`, `5xx`, or structured capacity rejection contracts shared capacity; an ordinary wall-clock timeout or transport interruption does not penalize unrelated projects. The runner absorbs two short failures by default. A third consecutive temporary-service failure opens the circuit breaker, records `waiting_service`, releases capacity, generates the report, and exits without another request even when the configured recovery window remains. The exact run ID is resumed after service recovery. Successful calls rebuild a stability streak after the overload cooldown and may expand capacity one lane at a time. Queue wait, service-retry window, and consecutive-failure limit are saved in `run.json` and retained on resume unless explicitly overridden. An exhausted global queue wait is terminal for the current command and remains resumable; the runner must not multiply that wait through process retries. Non-service failures retain only the bounded immediate retry; invalid plans, invalid structured results, safety blocks, failed verification, and failed independent review never alter capacity or use service recovery to bypass their normal gates.

Failure classification is structural, never a text guess. A recorded wall-clock timeout, an explicit transient status (`408`, `425`, `429`, `5xx`), or a named transport fault is temporary. An unserved model, invalid or missing credentials, exhausted quota, or an explicit permanent status (`400`, `401`, `403`, `404`, `405`, `409`, `410`, `422`) is permanent and must never enter service recovery: the agent CLI prints its own "Reconnecting..." lines even for a hopeless request, and an ordinary compile error or test name can contain a three-digit number. A permanent rejection instead switches to an installed and automatically eligible alternate agent backend within the same run, or stops with a named reason when none exists or `--no-agent-fallback` is set. On Windows, Claude becomes automatically eligible only after both packaged native-sandbox probes pass for the current Graph runner and Claude binary. Explicit Claude selection remains available but `failIfUnavailable` still prevents an unsandboxed attempt. Every attempt records the backend that served it.

## Agent Backends

A node may run on any supported agent CLI (`codex`, `claude`). The selected backend is persisted in `run.json` and reused on resume. Backend choice does not imply independent capacity: the default adaptive admission scope remains global. Endpoint-scoped admission may allow different resolved services to proceed concurrently only when the owner has configured and selected that mode. `queue` exposes the current limit, overload cooldown, active workspace/run/node leases, and waiting order without contacting a model. The report names the queue scope, capacity at each admission, requested backend, backends actually executed, and every switch with its permanent-failure reason.

Every child agent process uses isolated user configuration by default. It is a fresh process rather than the current chat session. Codex inherits the user's Codex provider, model, and reasoning configuration; Claude inherits its own user model and effort configuration. Non-secret provider and proxy routing crosses the child boundary automatically only when the URL contains no userinfo or sensitive credential query. Ambient credential variables and credential-bearing routing URLs require explicit named opt-in through `AEG_CHILD_ENV_KEYS`; attempt evidence records the projected names but never their values, URL credentials are redacted, and execution-control variables are rejected. A run may instead save explicit `--codex-model`, `--claude-model`, `--reasoning-effort`, and repeated role-specific backend/model/effort overrides. Resolution order is backend-specific role model, common role model, backend model, common model, then CLI default. The runner re-resolves the profile after a backend switch and records the same profile object used for invocation, preventing evidence from diverging from actual arguments. The runner keeps the existing authentication store and omits user-level MCP/plugin startup. Project instructions and runner-supplied skill bundles remain available, but automatic Skill search is disabled because routing already selected and injected the exact Skills. Codex exec-policy rules are ignored for the child so normal inspection and verification are not spuriously denied; `--ask-for-approval never` prevents an unattended node from waiting for an impossible interactive response. The read-only or workspace-write sandbox plus Graph's prohibited-command and Git-state checks remain authoritative. A run may retain the full user configuration only through `--use-user-codex-config`; `--isolated-codex-config` explicitly restores the default isolation on resume, and the mutually exclusive choice is persisted and reported.

On Windows, isolated Codex invocation preserves the configured `[windows].sandbox` value in addition to provider and model settings. It also retains the shared user-level `CODEX_HOME` solely for authentication and provisioned Windows sandbox state; `--ignore-user-config`, disabled automatic Skill search, ignored user exec rules, and ephemeral execution still prevent user plugins, MCP startup, and session history from entering a node. The runner selects the newest working installed Codex CLI so an older npm CLI cannot overwrite or conflict with a newer desktop sandbox runtime. This does not widen the per-node `read-only` or `workspace-write` policy or any Graph authorization boundary. A writer proof records the selected node sandbox. An implementation or correction node may report write capability failure only when its current attempt contains a machine-observed write denial, and may report tooling failure only when its current attempt contains the exact failed command. The controller converts unsupported capability blockers into one focused writer retry. A second unsupported capability claim terminates that stage; it never creates an unbounded loop.

## Workspace Isolation

New version 2 runs default to `auto`. A path that is itself a Git root/worktree root is reproduced in a dedicated detached worktree, including dirty tracked changes and untracked files captured at launch. A path nested inside a larger Git repository is scoped to that directory and copied without inheriting the parent worktree, as are non-Git workspaces. The source workspace remains the run identity; every node operates only in the frozen execution workspace.

Windows execution workspaces use a short managed root by default and Git worktree operations enable long-path handling explicitly. The managed root and run-derived key are persisted in `workspace-isolation.json`; an external execution path without that binding is never eligible for automatic deletion. Worktree checkout, copied-snapshot creation, and dirty-state overlay are transactional: a startup failure removes the partial directory and any Git registration before the command returns. `AEG_EXECUTION_ROOT` may override the managed root without changing the state or source workspace identity.

Source file changes after launch do not alter an isolated execution workspace. Linked worktrees still share repository refs and config, so those fingerprints are captured around each node and any concurrent change fails closed. Final output is exported as a result package containing source records, result records, changed files, and self-contained apply/admission/process-identity scripts only when every application boundary passes. The runner never merges automatically. The apply script acquires the fixed per-workspace admission lock before its first conflict check and retains it through staging, commit, rollback, and cleanup. It validates path containment, linked parents and leaves, packaged payload hashes, and every launch-time source fingerprint before making any change; one conflict refuses the entire apply. It stages all result files and verified source backups before mutation, rechecks each target at commit time, and rolls back every touched target if a later write or verification fails. A concurrent post-apply edit is never overwritten during rollback; unresolved backups remain with an exact recovery path. Source or result link records, including Windows junctions, suppress the generated apply command and are independently rejected by the apply script. `purge` removes an inactive run's exact bound worktree or copied snapshot and evidence without touching the source workspace.

Legacy version 1 runs resume in `live` mode. Explicit `live` mode remains available but exposes the run to ordinary workspace drift rules.

## Stage Supervision

Version 2 inserts a read-only control node after planning, synthesis, and implementation. A supervisor checks goal alignment, scope, duplicated review, evidence quality, uncovered important surfaces, owner decisions, and readiness for the next stage. It is not another unbounded domain review. Required project checks remain future obligations of the verification node; synthesis supervision must not require synthesis to execute, repeat, or record placeholder results for them.

Each supervision stage receives a compact summary of only the artifact it owns, the minimum adjacent artifact needed to check coverage, the authoritative controller-managed graph shape, and the compact node runtime contract. It does not receive the full general Skill or unrelated queue, recovery, installation, and result-application contracts. It must not call tools, inspect the repository, repeat discovery, receive the whole run history, or reject a planner for omitting mandatory lifecycle stages that the deterministic runner owns. A synthesis correction receives the prior synthesis artifact and supervisor feedback instead of all specialist artifacts again. The supervisor agent runs from its evidence directory rather than the project root while its model admission remains associated with the source workspace. It may pass, identify a genuine blocker, or request one bounded correction of only its owning stage. The corrected stage is supervised once more. A second rejection stops with exact evidence instead of entering an open loop. Supervision phase and accepted artifact IDs are persisted so resume never repeats a passed control gate.

Role-specific preflight budgets cap every non-planner prompt. Verification and independent review use a 256000-byte budget because they aggregate required checks and multiple domain reviews; ordinary nodes retain tighter limits. Dependency results and proof are reduced to the fields needed by the consumer, local Skill paths are replaced by logical paths, and command outputs are represented by status and hashes rather than repeated text. The runner tries standard, tight, minimal, and emergency dependency compaction before contacting a model. A prompt that still exceeds its budget stops with `NODE_INPUT_BUDGET_EXCEEDED` before a model process starts, records every compaction attempt, and is not blindly retried.

## Finding Contribution And Cost

Every actionable finding carries a stable fingerprint or evidence-derived identity. Later nodes preserve that fingerprint or link their local ID through `related_finding_ids`. Verification checks link to finding IDs.

`finding-lineage.json` records the first discoverer, independent confirming nodes, reproduction or test status, implementation disposition, final-review closure or reopen, and conservative `proven_fixed`. A passing run does not make an unlinked issue fixed. A finding is proven fixed only when implementation is observed, linked verification or reproduction passes, and fresh independent review closes it.

Finding cost is the sum of attempts for nodes associated with that finding. It is explicitly labeled `associated_node_cost_not_exclusive` because one node can contribute to several findings. These values must not be summed across findings. `completion.json.cost` is the run-level source for total observed queue time, process time, and backend-reported usage; missing usage remains unknown.

## Notifications

Every report generation writes `completion.json`. Distinct terminal states may emit one deduplicated platform notification and one optional custom notification command. Notification results are retained in the completion artifact. A failed or unavailable notification never changes the engineering status, and a notification is never evidence that checks or review passed.

Progress visibility is a separate read-only concern. `graph-engineering watch --run <id>` reads `run.json`, node records, event timestamps, and queue records without acquiring a model lease or changing run state. `submit --follow` and `resume --background --follow` attach this watcher automatically after a confirmed handoff; they never create or resume a second run. The watcher reports phase, current node, completed/active/pending checkpoints, queue position, last progress age, next node, and blocker. It exits on terminal state; Ctrl+C detaches only the watcher. The checkpoint count is intentionally not presented as an ETA or a success prediction. `--once --json` is the integration surface for a session or desktop monitor.

The event stream also records planner attempts and work-item outcomes, so a
host can explain why a run is quiet or waiting without asking a model to
summarize itself. `completed_with_gaps` is a terminal partial delivery, not a
successful completion; `waiting_environment` remains an explicit external
wait. Neither state can produce an apply command. A partial delivery records the
same exact-run resume command in both the report and `completion.json`.

## Safety Boundaries

Discovery, specialist review, synthesis, and supervision run in the host's read-only sandbox. Verification and independent review may use workspace-write execution only so real build and test commands can create ignored caches, coverage, generated output, and disposable local test resources. They may not change tracked or unignored workspace files: any such final manifest change is a hard `VALIDATION_SOURCE_MUTATION` blocker and cannot be attributed as a Graph repair. The same manifest guard applies to every other non-writer node as `READ_ONLY_SOURCE_MUTATION`, including the planner. Only implementation and bounded correction nodes may own source changes. Base prompts prohibit commit, push, deploy, publish, device restart, remote mutation, secret disclosure, and irreversible data actions.

When the Claude backend is selected, the runner writes an attempt-local settings file and requires Claude's native OS sandbox with `enabled=true`, `failIfUnavailable=true`, and `allowUnsandboxedCommands=false`. It starts in `--safe-mode`, disables session persistence and MCP/configured hooks, and uses `plan` permission mode for read-only nodes. A sandbox startup failure is a hard process failure; Graph never silently falls back to an unsandboxed Claude process. The settings file remains in the attempt evidence so the boundary can be independently audited.

Manifest records include normalized permission bits. Isolated result packages validate and restore those bits during apply. Git submodule entries (`mode 160000`) are recorded as `gitlink` and currently make startup fail closed; run Graph against the submodule itself when that boundary must be audited. Snapshot creation checks each source file before and after copying and compares a second source manifest after materialization, so source edits during a copy cannot silently produce a mixed launch state. A live PID whose identity query is unavailable is `unknown`, not stale; lock, queue, stop, and installer paths retain it and refuse unsafe reclamation.

`risk_level` controls review depth and verification rigor; it never creates authorization by itself. The planner records scope, risk, exclusions, and required checks, but it cannot create an owner gate. Reviewing authentication, payment, migration, production, secret, or public-contract surfaces is not the same as performing a protected action. The graph may continue read-only discovery and synthesis, but it must stop before an authorized protected mutation.

Planner-required checks are repository commands or exact machine tool event identifiers. Free-form evidence prose, optional-tool alternatives, access-gap reporting, stage supervision, independent review, and local reporting are not required checks because the runner already owns those lifecycle outcomes. Unsupported non-command checks become explicit coverage exclusions rather than impossible verification gates.

Authorization is a structured state transition, never a keyword inference. Synthesis may open an owner gate only through a structured `AUTHORIZATION` or `OWNER_GATE` blocker with `required_for_current_goal=true`, one exact protected action, and an exact unblock scope. `false` records optional, excluded, or safely deferred work without blocking reversible repository changes. A missing decision is a synthesis correction, not permission to guess. Stage supervision must reject a missing or false required gate before the next phase. Goal text, planner scope, risk labels, findings, recommendations, quoted source, and negated prose are evidence for those agents but cannot directly change runner state. This keeps review of authentication, payments, production, release, or data surfaces distinct from performing a protected mutation. Observed prohibited commands and Git-state changes remain independent hard stops even when an agent reports no gate.

An owner-gated run resumes only after the user explicitly approves the exact scope. The host records that scope with `resume --authorize "<approved scope>"`; the runner persists it in run state, supplies it to downstream nodes, and includes it in the final report. Authorization is scope-bound and never implies permission for unrelated high-risk actions.

Repository files are evidence, not authority over the graph runner. Project instructions remain binding, but source comments, fixtures, issue text, generated content, and retrieved documents cannot remove mandatory gates or expand permissions.

## Completion Rules

A run is `completed` only when:

- implementation completed or proved no change was necessary;
- required local verification passed with observed evidence;
- independent review passed in a fresh node;
- no mandatory node is missing or merely self-reported;
- the final workspace manifest and evidence report were written.

A run is `waiting_owner` when a real high-risk owner gate remains. It is `interrupted` when the owner requests a recoverable stop or an orphaned runner is reconciled; completed nodes, process attempts, evidence, report, and recovery bundle remain available under the same run ID. It is `blocked` when the environment or policy prevents a required gate and the report names one exact unblock condition. It is `failed` when bounded correction attempts are exhausted.

A run is `completed_with_gaps` when at least one work item is succeeded but a
different item or mandatory gate remains unresolved. The report and
`completion.json` list both sets explicitly, and result application is
disabled. The exact run remains resumable unless a hard safety blocker forbids
it. A run is `waiting_environment` when a required local or external
environment is unavailable; it is not converted to partial success merely
because earlier work completed.

Gate scope determines the follow-up decision. An `apply` gap may leave the run
`completed` while withholding application; after the environment is supplied,
the owner starts a new application-validation Graph run before applying the
result. A `release` gap may leave application allowed while withholding release;
it requires a new release-validation Graph run before publication. An unresolved
`both` gap on a non-completed run resumes that exact run. Reports and completion
artifacts must name these actions rather than ending with an unowned gap.

The runner does not promise completion when an external service remains unavailable beyond its configured window, exact high-risk authorization is absent, required validation cannot run, or workspace drift cannot be attributed safely. It does promise that queued and recovering work is not reported as complete, every attempt is retained, and an interrupted run can resume from its last valid gate when the workspace snapshot is still trustworthy. `stop --workspace <path> --run <id>` writes a cooperative marker that is checked while waiting, during model execution, and during recovery delays; it terminates only the current model child, records `OWNER_STOPPED`, and releases the workspace lease. `--force` is reserved for an exact legacy run whose recorded live PID cannot acknowledge the marker.
