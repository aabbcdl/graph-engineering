# Usage

## Mac-First Installation

Graph Engineering is currently distributed as a Mac-first local tool. Give the
GitHub repository URL to a coding Agent and ask it to read the repository
README.md, check Node.js 20+, verify a configured Codex or Claude CLI, and run
the explicit installer. The equivalent terminal flow is:

~~~bash
git clone https://github.com/aabbcdl/graph-engineering.git
cd graph-engineering
npm run install:global
graph-engineering validate
graph-engineering doctor --agent-backend codex --json
~~~

The repository is the canonical source, and the published package provides the
same Mac-first workflow without a source checkout. The current package has no
runtime dependencies; the target project's own tools are needed only when its
requested checks use them. Windows smoke instructions later in this document are
a separate compatibility gate and are not required for the Mac workflow.

The NPM install flow is:

~~~bash
npm install -g graph-engineering
graph-engineering-install
~~~

`graph-engineering-install` is an explicit, transactional Skill installation
step. The package does not use an npm `postinstall` hook to silently modify the
user's `~/.codex/skills` directory.

## Explicit Opt-In

The installed Skill selects Graph only when the user names Graph Engineering
in the current task or accepts a concrete Graph recommendation from the host.
Task size, multiple files, review scope, autonomous wording, or approval from a
previous task is not enough. Ordinary review, debugging, implementation,
refactoring, testing, configuration, documentation, and release work stays in
the current task.

After current-task approval, the host passes `--user-approved` as the machine
record for creating one run. That marker does not approve owner-gated work. A
Graph node and Graph maintenance/control commands never start another run.

Before launch, state the workspace, exact goal, that several independent agent processes will run, and that the model service may queue them for tens of minutes.

## Foreground And Background

Use `start` when the invoking host will wait on the same runner process:

```powershell
graph-engineering start --workspace "D:\project\example" --goal "<goal>" --user-approved
```

Use `submit --follow` for normal unattended work with automatic in-task visibility:

```powershell
graph-engineering submit --workspace "D:\project\example" --goal "<goal>" --user-approved --follow
```

Do not add `--background` to `submit`; it already launches a background runner. `--follow` keeps only the read-only display attached after the confirmed handoff. If the display or parent task closes, the runner continues and terminal notifications remain available. Use `resume --background --follow` only for one exact saved run. A confirmed background handoff includes the exact watcher command.

On Windows PowerShell, use the generated `graph-engineering.ps1` launcher (PowerShell selects it automatically when the `.ps1` and `.cmd` launchers share one directory). It forwards arguments as an array, so a multiline `--goal` cannot consume or discard later flags such as `--user-approved`. Do not call `graph-engineering.cmd` directly with multiline values; `%*` is only reliable for ordinary single-line CMD arguments.

## Default Version 3 Behavior

- `--workspace-mode auto`: use a detached worktree when the supplied path is the Git root/worktree root, and a safe copied snapshot for non-Git or nested paths;
- `--supervision stage`: supervise planning, synthesis, and implementation;
- `--notify`: send one terminal-state system notification when the platform supports it;
- global adaptive model admission: begin with two processes, grow to four after stable success, contract on structured overload;
- one workspace may use two read-only lanes when capacity is free, while writers remain exclusive.

## Run Budget And Assurance

The default v3 Run budget is 6,000,000 observed tokens, 240 effective
execution minutes, and 96 model-process attempts. Use `--budget extended` for
12,000,000 / 480 / 192, or select `--budget unlimited` explicitly. Individual
ceilings are available through `--max-run-tokens`, `--max-run-minutes`, and
`--max-run-attempts`. A resume can raise a saved ceiling but never resets the
historical attempt, token, time, or cost snapshot.

Use `--max-run-cost-usd` only with backend-reported cost or a verified
`--pricing-file`. A missing usage or unverifiable cost source pauses the Run as
`waiting_budget` before the next model call. A single finite token overrun is
recorded and bounded to the completed call; a second call at the ceiling is
never started.

Before each model process starts, run-level admission reserves a bounded token
amount and computes capacity from observed usage plus active reservations. A
node without a reservation waits as `waiting_budget`; it does not launch an
unreserved process. A process that has already started may finish with a
bounded terminal usage overrun, so the contract is not an absolute zero-overrun
guarantee. `budget_exceeded` ends the attempt as a budget stop rather than an
ordinary worker failure and does not trigger an automatic retry. The first
budget stop, user stop, or host interruption cancels unfinished siblings in
the same review wave while preserving completed nodes. Reservation ledger
entries and `RunBudgetReserved`, `RunBudgetReservationReleased`, and
`RunBudgetReservationsReclaimed` events explain the accounting; resume clears
reservations that have no matching live process.

`--assurance auto` selects `standard` for ordinary work and `high` for
`audit` plans or release checks. High assurance requires an independent review
on a different backend or with an explicitly different model. When that
capability is unavailable, the Run enters `waiting_environment` and does not
silently downgrade.

## Read-Only Control Operations

`preview` reads the workspace, deterministic plan shape, backend capability
matrix, and preflight contract. It creates no Run, isolated workspace, or
state file:

```powershell
graph-engineering preview --workspace "D:\project\example" --goal "Audit the repository" --json
```

For one exact Run, use `diff` to inspect additions, modifications, deletions,
and mode-only changes. `runs` lists status, size, update time, workspace, and
recoverability. `gc` previews cleanup by default; `gc --execute` is required to
remove only terminal Runs older than 30 days outside the newest three per
workspace. Active or recoverable Runs are excluded, and execution leaves a
deletion manifest under the state root. A state root above 20 GiB is warned
about but is never deleted automatically.

```powershell
graph-engineering runs --state-root "D:\GraphEngineering\runs" --json
graph-engineering gc --state-root "D:\GraphEngineering\runs" --json
graph-engineering gc --state-root "D:\GraphEngineering\runs" --execute --json
```

`apply --dry-run` runs the actual apply qualification, link checks, payload
hash checks, and source conflict checks with zero writes. `apply --file
"path/to/file"` applies exactly one path from the result manifest and marks
the result as a partial application. `recheck --scope apply|release` executes
only unsatisfied saved checks in one read-only sandbox; it does not re-plan or
re-implement, and appends evidence to lineage and completion artifacts.

```powershell
graph-engineering diff --workspace "D:\project\example" --run "<run-id>" --json
graph-engineering apply --workspace "D:\project\example" --run "<run-id>" --dry-run --json
graph-engineering apply --workspace "D:\project\example" --run "<run-id>" --file "src/fix.mjs"
graph-engineering recheck --workspace "D:\project\example" --run "<run-id>" --scope release --json
```

All these commands are read-only except an explicitly requested `apply` or
`gc --execute`. They never commit, push, deploy, publish, start Graph, or
delete source workspace files.

## Private Real-Run Archive

The source checkout includes a maintainer-only archive utility for consolidating
real-repository Run history without copying source code, workspace contents, or
report bodies. It records sanitized status/budget/node summaries plus hashes and
presence of selected evidence files. The output is operational feedback only;
it is not a public effectiveness claim and should remain outside the repository
unless it has passed a separate privacy review.

This utility is intentionally source-checkout tooling and is not part of the
published NPM runtime surface:

```bash
node scripts/archive-run-records.mjs \
  --root "/path/to/run-root-one" \
  --root "/path/to/run-root-two" \
  --output "/path/to/private-archive/index.json"
```

The utility skips managed workspace directories and does not follow symlinked
summary files. The generated index explicitly keeps `claim_ready=false` until
the separate bound paired-evaluation protocol has completed.

Use `--max-review-nodes <1-6>` only when you intentionally want a bounded
review fan-out. The default is six specialist nodes for a broad audit; lowering
it is recorded in the run and is preserved when the run is resumed. Results
from a reduced run must be labeled as such because it trades coverage for cost.
When you set no review limit explicitly, tiny workspaces (30 files and 256 KiB
or less) auto-scale the fan-out: audits keep exactly their four required
domain reviews and ordinary tasks keep two review nodes, with the decision and
measurements recorded in `coverage.auto_review_scaling`. Explicit limits are
never overridden, and saved runs keep their recorded limits on resume.

Correction rounds are incremental. After a failed verification round, the next
round re-verifies only the checks that were unsatisfied (plus any satisfied
check whose covering surface the correction changed); the independent review
in that round re-examines the previously flagged findings and the changed
surfaces while keeping full independent access to the frozen workspace. The
runner merges per-round check evaluations by id, so an earlier recorded pass
stays valid unless a later round re-ran that check.

Use `--workspace-mode live` only when in-place changes are deliberately required. Version 1 saved runs preserve their legacy live/no-supervision behavior when resumed.

On Windows, isolated worktrees and copies are stored under `%LOCALAPPDATA%\GraphEngineering\w` rather than below the longer run-evidence path. This avoids the legacy 260-character Git worktree materialization failure while `report.md` and all evidence remain under the state directory. Set `AEG_EXECUTION_ROOT` before launch only when another short local volume should hold managed execution workspaces. `purge` removes that exact managed workspace together with the run evidence; it never removes the source project.

Isolated `worktree` and `copy` modes refuse source symlinks and Windows junctions before creating a snapshot. Recreating a link would allow a child process to read the source workspace or an unrelated external path. Remove the link, materialize its target, or use `--workspace-mode live` only when the loss of isolation is intentional and understood.

Every startup records normalized file permission bits and refuses Git submodule
gitlinks (`mode 160000`) in `auto`, `worktree`, `copy`, and `live` mode rather
than silently omitting their contents.
Run Graph against the submodule as its own workspace when needed. During copy,
Graph verifies each file against the launch manifest and checks the source again
after materialization; a source edit during that window stops startup with a
snapshot-drift error.

Claude nodes use a runner-generated native OS sandbox. Read-only nodes deny
workspace writes and use `--safe-mode`, `--no-session-persistence`, and
`failIfUnavailable`; implementation/correction nodes receive workspace write
access only. If Claude cannot start its sandbox, the node fails closed and no
unsandboxed command is attempted. On Windows, an explicitly selected Claude
backend may always make that fail-closed attempt. Automatic fallback from Codex
to Claude is enabled only after both packaged Claude sandbox smoke probes pass
for the current Graph runner and Claude binary.

`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, and proxy routing are inherited when
their URLs contain no userinfo or sensitive credential query. Ambient
credential variables remain excluded. When a CLI is authenticated only through
environment variables, explicitly name the required variables, for example
`$env:AEG_CHILD_ENV_KEYS = "ANTHROPIC_API_KEY"`, before submit/resume. A routing
URL that embeds credentials also requires its own exact variable name in that
list; moving the credential to a dedicated key variable is preferred. Graph
passes only named values, records only their names in attempt evidence, redacts
URL userinfo and credential queries, and rejects execution-control names such
as `NODE_OPTIONS`, `GIT_*`, and `CLAUDE_CONFIG_DIR`.

For a Codex custom provider, set `model_providers.<id>.env_key` to the name of
the provider key variable and include that same name in `AEG_CHILD_ENV_KEYS`.
The child receives the variable name in its isolated config and the value only
through the explicitly projected environment. Remove any
`experimental_bearer_token` field and migrate it to an environment-backed key
before running Graph or the paired evaluation; a real isolated child rejects
the legacy field. Never put the provider secret in `--config`, command
arguments, repository files, or evaluation artifacts.

Installer updates, runner registration, live runs, and result application use
the fixed user-level control root `~/.graph-engineering/runtime-control` (under
`%USERPROFILE%` on Windows). It is intentionally independent of custom
`--state-root` and model-queue paths. A live run and `results/apply.mjs` are
mutually exclusive for the same workspace, and concurrent applies fail closed
instead of interleaving.

## Environment And Release Checks

Graph records whether a required check needs a browser, container, database,
device, local service, or external service. It infers this contract when a
project plan omits it, and an unavailable runtime is reported as
`waiting_environment` with an exact resume command. A failed assertion is not
silently converted into an environment wait.

Workspace preflight detects locked dependency and browser preparation commands,
but does not execute a repository-selected package manager or project-local
Playwright CLI with host privileges by default. The recorded command is run later
inside an implementation or verification node sandbox when the selected checks
need it. A standard-library-only Go module (no external `require`) is ready
without `go.sum`; a module with external requirements still needs the sum file.
Preparation evidence is stored in `workspace-preflight.json` and contains both
`status` (inspection outcome) and `readiness`/`ready` (whether the environment is
executable); it is setup evidence, not a rendering pass.

Every Run additionally stores the deterministic `workspace-module-map.json`.
This is an orientation artifact, not a replacement for the exact source
snapshot. For Android/Gradle it records settings-declared modules, paths,
source/test directories, manifests, declared tasks, and missing modules. For
Node/Worker repositories it records bounded package, lockfile, script, and
backend-candidate metadata, together with discovered rule files. Planner and
review nodes receive a bounded focus-ranked map context to avoid repeatedly
walking a large repository. The snapshot rules remain unchanged: Graph does
not automatically omit `build`, `.gradle`, `node_modules`, or local
configuration, and submodules remain fail-closed. The public
`--submodules separate` interface is intentionally not part of this phase.

Android/Gradle checks are opt-in and have two distinct levels:

- `--machine-preflight` performs static module/path/manifest checks only and
  writes `machine-preflight.json` without running Gradle.
- `--machine-preflight-gradle` adds the wrapper's `projects` command and up to
  twelve safe planned-task `--dry-run` probes in the isolated execution
  workspace, with a filtered environment and private `GRADLE_USER_HOME`.

The second level executes repository Gradle configuration code by design, so
it must be explicitly requested. It does not run the full test suite, device
operations, publish, or deploy commands. Each probe records the exact cwd,
argv, exit code or signal, timeout, duration, redacted output, and before/after
workspace surface. A missing wrapper or an unavailable Java/Android toolchain
is an environment gap. `not_requested` and `not_run` mean that no probe was
executed, not that the repository command failed. For example, a declared but
missing `:screenshot-demo` module is reported by the static pass before model
review.

```powershell
graph-engineering start --workspace "D:\project\example" --goal "Review Android modules" --mode review --machine-preflight --user-approved
graph-engineering start --workspace "D:\project\example" --goal "Review Android modules" --mode review --machine-preflight-gradle --user-approved
```

For a trusted repository, host preparation can be enabled explicitly before
launch:

```powershell
$env:AEG_ALLOW_HOST_DEPENDENCY_PREPARE = "1"
$env:AEG_ALLOW_HOST_BROWSER_PREPARE = "1"
```

The two permissions are independent. `AEG_PLAYWRIGHT_BROWSERS` selects revisions
(`chromium` by default), and `AEG_AUTO_PREPARE_BROWSERS=0` disables browser
preparation. A browser cache matches only the same action, complete browser list,
project-local CLI path, and host identity; `disabled` or `deferred` evidence
cannot satisfy a later install request.

Host preparation uses a minimal environment allowlist rather than inheriting
ambient API keys, tokens, or passwords. A private registry or authenticated
proxy that genuinely requires a variable must opt into both the host dependency
step and the exact variable name, for example:

```powershell
$env:AEG_ALLOW_HOST_DEPENDENCY_PREPARE = "1"
$env:AEG_PREFLIGHT_ENV_KEYS = "NPM_TOKEN,HTTPS_PROXY"
```

Those values are passed only to the preparation process and remain excluded from
model-node environments.

`package.json#packageManager` decides which lockfile Graph uses. If its manager
does not match an available lockfile, preflight stops with
`DEPENDENCY_LOCK_MISMATCH`. Without `packageManager`, lockfiles belonging to
multiple managers stop with `DEPENDENCY_LOCK_AMBIGUOUS`; Graph never guesses.
Dependencies without a supported lockfile also stop before planner/model
execution with `WORKSPACE_ENVIRONMENT_GAP`. Because an isolated Run has already
frozen that source state, correct the source workspace and start a new Run rather
than resuming the not-ready snapshot.

Use the strict capability doctor before a real Windows run:

```powershell
graph-engineering doctor --workspace "D:\project\example" --agent-backend codex --json
```

The doctor is fail-closed on a missing or stale read-only/workspace-write
record. The record is bound to the current runner hash, platform, architecture,
and the content SHA-256 of every executable/script file in the resolved invocation;
rerun the protected Codex/Claude smoke workflow
after any CLI or runner update. The test-only assurance bypass is accepted only
when the process is bound to the repository's exact `fake-codex.mjs` fixture;
setting `AEG_TEST_MODE=1` in an ordinary run does
not bypass capability or assurance gates, and the doctor always disables it.

The Mac implementation can prepare the runner and its evidence format, but it
cannot satisfy the Windows smoke gate. Until real protected Windows
read-only/workspace-write runs exist, Windows readiness stays
`UNKNOWN`/`waiting_environment`.

Every npm, pnpm, Yarn, or Bun dependency install disables lifecycle scripts. An
isolated run removes `node_modules` before dependency preparation and never
reuses that directory across run boundaries. Live mode may reuse an existing
directory because the owner deliberately selected in-place operation. If a
repository needs a native addon build, code generation, or another install hook,
make it an explicit implementation or verification command so it runs inside
the node sandbox and appears in machine evidence.

Required checks default to `blocking_scope=both`, which blocks local completion,
result application, and release readiness. Use `blocking_scope=apply` for a
check that may be deferred while still withholding the isolated result package;
use `blocking_scope=release` for a check that only decides publish readiness.
The completion artifact exposes `application_ready` and `release_ready`, along
with the unresolved check IDs, so these decisions remain explicit. After an
`apply` gap, provide the missing environment and start a new Graph run that
revalidates application before applying the package. After a `release` gap,
start a new release-validation Graph run before publishing. A non-completed run
with a `both` gap resumes the same exact run.

## Queue And Concurrency

```powershell
graph-engineering queue
```

The Skill itself consumes no model capacity. Each graph node is a separate model process. For one shared endpoint, two simultaneous projects is the normal maximum; additional submitted projects wait without consuming model tokens. Use `--queue-scope endpoint` only when the configured backends truly use independent model services.

Three consecutive temporary service failures pause the run as `waiting_service`, release capacity, retain the same run ID, and stop issuing requests. Resume after service recovery:

```powershell
graph-engineering resume --background --workspace "D:\project\example" --run "<run-id>"
```

A background resume succeeds only when it prints `handoff: confirmed`.

## Automatic Live Progress Without Model Usage

Every Skill-launched submit or background resume includes `--follow`. The host
keeps that stream attached, reports meaningful state changes, and reads the
final artifacts as soon as the stream reaches a terminal state. The user does
not need to ask for status or say "continue". Unchanged snapshots are not
narrated, and the host does not create model-powered polling turns.

To reattach a display to one exact run:

```powershell
graph-engineering watch `
  --workspace "D:\project\example" `
  --run "<run-id>"
```

The display shows the current stage and node, attempt number, completed/active/pending checkpoints, runner and model activity, queue position, time since the last persisted event, blocker, and a concrete next action when one is known. It never starts, resumes, stops, or contacts an agent model. Press Ctrl+C to detach without stopping the run.

Use `--once` for one snapshot, `--json` for machine-readable output, `--interval-seconds <n>` to change refresh frequency, `--stale-seconds <n>` to tune the quiet warning, and `--no-clear` to retain prior snapshots. The checkpoint count is deliberately not shown as a percentage or ETA because node duration varies substantially.

For an exact, replayable timeline, use the event reader:

```powershell
graph-engineering events `
  --workspace "D:\project\example" `
  --run "<run-id>" `
  --since 0 `
  --type WorkItemFailed
```

`--type` is repeatable. The command reads `events/events.jsonl` and never
contacts a model or changes run state. `--json` returns the event records and
the path to the stream, which is suitable for a desktop/session monitor.

## Delivery States

The node graph is an execution plan; the runtime state is the delivery record.
Each work item is independently marked `pending`, `running`, `succeeded`,
`failed`, `blocked`, `deferred`, or `superseded`. Run-level status follows
these rules:

- `completed`: every mandatory work item and verification gate passed.
- `completed_with_gaps`: at least one work item succeeded, but another item or
  final gate remains unresolved. The report lists both delivered and missing
  work, no apply command is generated, and the CLI returns a non-zero exit
  code so automation cannot mistake it for full success. Both `report.md` and
  `completion.json` contain the exact same-run resume command.
- `waiting_service`: the model endpoint was temporarily unavailable; the
  circuit breaker released capacity and the exact run can be resumed later.
- `waiting_environment`: a required repository environment is unavailable;
  the report names the missing evidence and the next check.
- `waiting_owner`: one exact protected action needs explicit authorization.
- `failed`/`blocked`: no safe completion claim is possible; the report retains
  the failed attempt and one concrete recovery condition.

This distinction is intentional. A late verification outage must not erase a
successful review or repair, while a partial result must never be presented as
a release-ready run.

## Oversized Node Input

Verification and independent review aggregate implementation evidence, required checks, and selected domain reviews, so they use a 256000-byte budget. Graph automatically retries prompt construction with standard, tight, minimal, and emergency dependency compaction before it contacts a model. The selected level and every attempted byte count are saved in `nodes/<node-id>/input-compaction.json`.

If all levels still exceed the limit, the run stops with `NODE_INPUT_BUDGET_EXCEEDED` before spending model tokens. Reduce the named Skill or upstream artifact source, or install a compatible newer Graph runtime, then resume the same run ID so only the blocked node input is rebuilt. Start a new run only if the saved snapshot no longer passes freshness checks. `watch` detects when the installed runtime's budget is already higher than the budget recorded by an older blocked run and recommends the exact-run resume path.

## Exact Run Control

```powershell
graph-engineering status --workspace "D:\project\example" --run "<run-id>" --json
graph-engineering stop --workspace "D:\project\example" --run "<run-id>"
graph-engineering resume --workspace "D:\project\example" --run "<run-id>"
graph-engineering purge --workspace "D:\project\example" --run "<run-id>"
```

`stop` is recoverable and preserves completed nodes and evidence. `purge` deletes one inactive run's local evidence and its exact managed isolated worktree or copy; it does not delete source workspace files.

When several incomplete runs exist, always provide the exact run ID. Never guess.

## Owner Gates

High-risk mutation stops at `waiting_owner`. Read the exact authorization scope from `completion.json` or `report.md`, obtain explicit user approval for that scope, then pass it unchanged:

```powershell
graph-engineering resume `
  --workspace "D:\project\example" `
  --run "<run-id>" `
  --authorize "<exact approved scope>"
```

Do not use `--authorize` for ordinary interrupted or service-paused runs.

## Role Profiles

Roles are `planner`, `supervisor`, `discovery`, `review`, `synthesis`, `implementation`, `correction`, `verification`, and `independent-review`.

```powershell
graph-engineering submit `
  --workspace "D:\project\example" `
  --goal "<goal>" `
  --user-approved `
  --role-backend "planner=codex,review=claude" `
  --role-model "codex.planner=gpt-strong" `
  --role-model "claude.review=sonnet" `
  --role-effort "planner=xhigh,review=medium,independent-review=high"
```

Planner, supervisor, synthesis, and independent review default to high reasoning effort. Discovery, review, implementation, correction, and verification default to medium. A global `--reasoning-effort` overrides those defaults unless a role-specific value is supplied.

All requested and actual attempt settings are persisted in the report. Model names are backend-specific; do not reuse a Codex model name for Claude without verifying it exists.

## Notifications

Terminal states are `completed`, `failed`, `blocked`, `waiting_owner`, `waiting_service`, and `interrupted`. Graph sends at most one notification per distinct terminal state.

Use a custom integration command when desktop notifications are insufficient:

```powershell
graph-engineering submit `
  --workspace "D:\project\example" `
  --goal "<goal>" `
  --user-approved `
  --notification-command "your-notifier-command"
```

The command receives `GRAPH_RUN_ID`, `GRAPH_STATUS`, `GRAPH_WORKSPACE`, `GRAPH_EXECUTION_WORKSPACE`, `GRAPH_REPORT`, and `GRAPH_COMPLETION_JSON`. Notification failure is recorded but does not change the engineering result. Use `--no-notify` to disable notifications.

## Applying Isolated Results

The source workspace is untouched during an isolated run. On completion, inspect `report.md`, `completion.json`, and the diff in the run's `results` directory. Execute the exact `apply_command` recorded in `run.json` or the report only when `application_ready=true`. A completed run with an apply-scoped gap deliberately has no apply command; resolve the gap and run the application-validation decision recorded in `next_actions`.

The apply script verifies every source record and packaged file against its launch hash before writing. A conflict stops the entire apply before any file changes. It also stages verified backups and result payloads before commit. If a later file write or final verification fails, already touched targets are restored and newly created empty directories are removed. If another process changes a touched target during rollback, the script refuses to overwrite it and prints the preserved backup directory for manual recovery. Symlinks and Windows junctions are never applied from an isolated result package; any linked source, result, parent, leaf, or payload path is rejected. Graph never commits or merges the result automatically.
