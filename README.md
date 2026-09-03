# Graph Engineering

> A Mac-first, evidence-driven control plane for long-running multi-agent repository work.

Graph Engineering turns one explicitly approved project goal into a persisted graph of planning, stage supervision, discovery, specialist review, synthesis, implementation, verification, and fresh independent review. It is designed for work where one conversational agent is not enough: the run needs bounded capacity, isolated execution, resumability, machine-observed evidence, and an honest final state.

It is a standalone project. The installable Skills are the user-facing entry point; the runner, tests, evaluation harness, and release tooling live here as the source of truth.

## Give This Repository to Your Agent

The simplest onboarding path is agent-first: copy this GitHub repository URL into
your coding Agent and ask it to install Graph Engineering on the current Mac.
The Agent can inspect the repository, check prerequisites, run the installer, and
report any environment gap without requiring the user to understand the runtime
layout.

Use this prompt after pasting the repository URL:

~~~text
Please install Graph Engineering from the repository URL above on this Mac.

1. Read README.md, AGENTS.md if present, CONTRIBUTING.md, and SECURITY.md.
2. Check that Node.js is 20 or newer, and check whether Codex CLI or Claude Code CLI is installed and authenticated.
3. Clone the repository if it is not already available locally.
4. Run npm run install:global from the repository root.
5. Run graph-engineering validate and the appropriate graph-engineering doctor --agent-backend codex --json or --agent-backend claude --json check.
6. Do not publish to NPM, push to GitHub, modify another project, or start a real Graph Run without my explicit approval.
7. Report exactly what was installed, which checks passed, and any remaining waiting_environment or waiting_budget condition.
~~~

The Agent should show the exact paths and commands it used. Installation is an
explicit local setup action; it does not grant permission to run Graph against a
project or to apply any generated change.

## One Prompt, One Run

Once Graph Engineering is installed, one clear prompt takes an Agent from a
repository path to an isolated, evidence-backed result. Name the repository,
state one bounded goal, and choose the outcome you want. The Agent handles the
preview, Graph run, specialist work, progress tracking, and final evidence.

Use this prompt when you want an assessment only:

~~~text
Use Graph Engineering (`graph-engineering`) for this repository.

Repository: /absolute/path/to/repository
Mode: review (read-only)
Goal: <one concrete question or bounded area to assess>
Scope: <directories, files, or commit to inspect>
Exclusions: do not modify code; do not apply, commit, push, publish, deploy,
or perform other external mutations.

I explicitly approve creating this Graph run. Before launch, confirm the
workspace, isolation mode, selected backend/model, budget, and that several
fresh Agent processes may run or queue. Run a read-only preview, then submit
exactly one review run with progress tracking and follow it to a terminal state.
Read the final report and machine evidence. Separate verified facts,
hypotheses, deferred or unverified checks, blockers, and the next action. Do
not call the result complete if a required gate is waiting or failed.
~~~

Use this prompt when you want a bounded repair prepared for your approval:

~~~text
Use Graph Engineering (`graph-engineering`) for this repository.

Repository: /absolute/path/to/repository
Mode: task
Goal: <one concrete defect or change to implement>
Scope: <directories or files that may be inspected and changed>
Acceptance: <tests, behavior, or other evidence that must pass>
Permissions: work only in Graph's isolated workspace. Do not write back to
the source repository; do not apply, commit, push, publish, deploy, or perform
other protected actions.

I explicitly approve creating this Graph run. Before launch, confirm the
workspace, isolation mode, selected backend/model, budget, and that several
fresh Agent processes may run or queue. Run a preview, then submit exactly one
task run with progress tracking and follow it to a terminal state. Read the
report, completion evidence, and exact diff and test results. Stop after the
isolated result is ready and wait for my separate decision before applying it.
~~~

Replace the bracketed fields with a real path and a specific outcome. This
single prompt is the normal user interface; `apply`, `commit`, `push`,
`publish`, and deployment remain separate decisions so the source repository
cannot be changed accidentally.

## Why Use Graph

A single Agent can often produce a patch. Graph is for the harder cases where
the process itself must be inspectable:

- a long run can pause and resume from persisted checkpoints;
- model calls are admitted against a Run-level budget before they start;
- specialist reviews can run in parallel while completed work remains visible;
- isolated workspaces keep review and repair away from the source tree by default;
- independent review, command evidence, hashes, and lifecycle events make the final claim auditable.

These are control-plane guarantees and design goals, not proof that Graph always
finds more defects or uses fewer tokens. See [docs/marketing-kit.md](docs/marketing-kit.md)
for the evidence model, demo script, metrics, and ready-to-use launch copy.

## What Version 3 Adds

- isolated Git worktree or copy execution by default, so normal development can continue;
- Windows-safe short execution paths, explicit Git long-path support, and transactional cleanup of partial snapshots;
- artifact-only control gates after planning, synthesis, and implementation, with one bounded correction per stage and no repeated repository discovery;
- backend, model, and reasoning-effort selection by role;
- terminal notifications and a machine-readable `completion.json`;
- a read-only live watcher that shows real checkpoints, runner/model activity, queue state, quiet time, and blockers without using model tokens;
- an append-only lifecycle event stream and content-addressed artifacts, so every work item can be inspected and resumed independently;
- work-item delivery states and `completed_with_gaps`/`waiting_environment` outcomes, so a late failure cannot erase already verified results or masquerade as a full success;
- per-finding lineage from first discovery through confirmation, repair, verification, and final review;
- Windows workspace-write smoke validation plus machine-enforced evidence for permission and tooling blockers;
- a compact runner-enforced node contract, bounded dependency context, and preflight input budgets that stop oversized prompts before a model call;
- structured authorization decisions, so optional or excluded protected work stays deferred instead of blocking reversible repairs;
- associated node time and backend-reported token use, explicitly not presented as exclusive per-finding cost;
- a paired evaluation harness for comparing Graph with a normal single-agent review on the same frozen fixture.
- strict normalized argv matching for required checks; `check_id` cannot substitute for command evidence;
- Run schema version 3 with persisted budget, assurance, repository-root, requested-scope, and execution-root identities;
- default run limits of 6M observed tokens, 240 active minutes, and 96 model-process attempts, with explicit `extended` and `unlimited` profiles;
- fail-closed `high` assurance for audits and release checks unless the independent review uses a distinct backend or model;
- read-only `preview`, `diff`, `runs`, and `gc` operations, transactional `apply --dry-run` and selective `--file`, plus saved-check `recheck`;
- sparse event-log head/index metadata, lazy legacy metadata rebuild, and explicit storage retention rules;
- monorepo-root snapshots with scoped execution cwd and Node, Python, Go, Rust, Java, and .NET preflight detection.
- `--mode review` for a genuinely read-only assessment graph that stops after independent review and never produces an applicable result;
- copy-mode source Git provenance, so a copied execution workspace can satisfy the launch-time Git-state check from a recorded source snapshot without probing the user's repository during node execution.

Graph is explicit opt-in. It starts only when the current task names Graph Engineering or accepts a concrete Graph recommendation. Task size, review scope, multiple files, autonomous wording, and approval from another task never select it automatically; ordinary repository work stays in the current task. The host records that current approval with `--user-approved`, which does not authorize protected mutations. The runner does not commit, push, deploy, publish, restart devices, or perform irreversible data operations on its own.

## Requirements (macOS)

- macOS; the current supported target is Mac, with primary validation on Apple Silicon
- Node.js 20 or newer
- Codex CLI or Claude Code CLI, installed and authenticated separately
- Git is recommended for repository history and worktree isolation; non-Git and nested folders can use safe copy isolation
- The target repository's own toolchain (for example Java/Android SDK, Node, Go, or Rust) only when its requested checks need it

Graph has no separate Python package, database, daemon, or model SDK to install.
The model work is performed by the selected Codex or Claude CLI. package.json
has no runtime dependencies; the installer and runner use Node's standard library.

### Platform support status

Graph Engineering is currently Mac-first. macOS, especially Apple Silicon, is
the primary supported and documented workflow. Windows is only partially
adapted at this stage: path handling, process isolation, and real-agent sandbox
behavior may still be unreliable. Windows users should treat the status as
experimental/`UNKNOWN`, run the protected smoke checks first, and not assume
that a successful Mac run implies Windows readiness.

## Install on macOS

```bash
# If the repository is not already on disk:
git clone https://github.com/aabbcdl/graph-engineering.git
cd graph-engineering

# No separate npm install is required for the current zero-runtime-dependency package.
npm run install:global
graph-engineering validate
graph-engineering doctor --agent-backend codex --json
```

The installer copies the bundled Skills into ~/.codex/skills and writes the
graph-engineering launcher into the global npm binary directory. It refuses to
replace a live Graph runtime, stages and validates all eight Skills, swaps them
in one rollback boundary, and restores the previous Skills and launcher if the
update fails. `--codex-home`, `--bin-dir`, and `--state-root` can be supplied to the
installer when a different local layout is intentional.

The GitHub repository is the canonical source. This release also provides an
NPM installation shortcut:

~~~bash
npm install -g graph-engineering
graph-engineering-install
~~~

The package provides the explicit `graph-engineering-install` command; it must
not silently mutate ~/.codex/skills from an npm postinstall hook. The installer
is deliberately separate from the runtime CLI so an npm upgrade can be inspected
before it replaces the user-level Skills.

### Windows is not required for the Mac workflow

The Windows smoke commands below document a separate, currently incomplete
compatibility gate. Windows is not the primary target, is not required for Mac
users, and is not part of the current Mac release claim. The package may install
on Windows while a real-agent Run still fails or remains `waiting_environment`.

On Windows, validate the selected backend's sandbox before the first real Run:

```powershell
npm run test:windows-codex-readonly-smoke
npm run test:windows-codex-write-smoke
graph-engineering doctor --agent-backend codex --json
```

Run the matching Claude read-only and writer probes before selecting Claude.
The doctor must report `ready`; an installed but unprobed CLI is intentionally
not treated as task-ready. Until those probes exist, `validate`/`doctor` may
exit with code 2 and list the missing sandbox records; that is a readiness
diagnostic, not a package-install failure.

## Start One Approved Run

Background execution is the normal unattended form:

```powershell
graph-engineering submit `
  --workspace "D:\project\example" `
  --goal "Audit and repair validated repository defects without regressions" `
  --user-approved `
  --follow
```

`submit` reports only after the child confirms startup and ownership with `handoff: confirmed`. `--follow` then keeps the invoking task attached to a read-only progress stream until completion, failure, a service pause, or an owner decision. It uses no model capacity and detaching it does not stop the background runner. Version 3 defaults to `--workspace-mode auto` and `--supervision stage`.

For a static assessment before any repair or runtime probe, select review mode explicitly:

```bash
graph-engineering start \
  --workspace "/path/to/project" \
  --goal "Review the repository for macOS compatibility gaps" \
  --mode review \
  --user-approved
```

Review mode runs discovery, specialist reviews, synthesis, synthesis supervision, and a fresh independent review in read-only sandboxes. It does not prepare dependencies, run implementation or correction nodes, execute runtime/device/release checks, or export an applyable result. Any deferred environment coverage is reported as deferred coverage rather than as a review failure. `--minimal` does not override this safety property.

## Preview, Diff, Apply, And Recheck

Use `preview` to inspect the workspace, plan shape, backend capability matrix,
and preflight contract without creating a Run or state residue:

```powershell
graph-engineering preview --workspace "D:\project\example" --goal "Audit the repository" --json
```

For one exact saved Run, `diff` reports added, modified, deleted, and mode-only
changes. `apply --dry-run` performs the same eligibility, path, link, payload,
and source-hash checks without writing. `apply --file "path/to/file"` applies
one manifest path transactionally and records a partial application. `recheck
--scope apply` or `--scope release` runs only unsatisfied saved checks in one
read-only sandbox after the frozen result and prior independent review remain
valid.

```powershell
graph-engineering diff --workspace "D:\project\example" --run "<run-id>" --json
graph-engineering apply --workspace "D:\project\example" --run "<run-id>" --dry-run --json
graph-engineering apply --workspace "D:\project\example" --run "<run-id>" --file "src/fix.mjs"
graph-engineering recheck --workspace "D:\project\example" --run "<run-id>" --scope apply --json
```

`preview` is strictly read-only. No command in this section commits, pushes,
publishes, deploys, or automatically applies a result.

## Budgets And Assurance

New Runs use the `default` budget: 6,000,000 observed tokens, 240 effective
execution minutes, and 96 model-process attempts. `--budget extended` doubles
those limits; `--budget unlimited` is an explicit opt-in. The limits can also
be set with `--max-run-tokens`, `--max-run-minutes`, and `--max-run-attempts`.
`--max-run-cost-usd` is accepted only when the backend reports cost or a
verifiable `--pricing-file` can price every call. Missing usage or cost pauses
before another model call as `waiting_budget`; resume may increase limits but
cannot erase historical consumption.

Model admission is run-scoped. Before a model process starts, Graph records a
bounded token reservation and calculates new capacity from observed usage plus
active reservations. A node that cannot reserve capacity waits as
`waiting_budget`; it does not start an unreserved call. A call that has already
started may finish with a bounded terminal overrun, so this is not a promise of
zero overshoot. `budget_exceeded` is normalized to a budget termination, is not
treated as an ordinary worker failure, and is not automatically retried. The
first budget termination, user stop, or host interruption cancels unfinished
siblings in the same review wave; completed nodes remain preserved. Reservation
records and `RunBudgetReserved`/`RunBudgetReservationReleased`/
`RunBudgetReservationsReclaimed` events make this visible, and resume reclaims
reservations that have no corresponding live process.

`--assurance auto` uses `standard` for ordinary tasks and `high` for audits or
release checks. High assurance requires a different backend or an explicitly
different model for independent review; otherwise the Run remains
`waiting_environment` instead of silently downgrading.

## Monorepos And Preflight

When the requested workspace is nested inside a Git repository, Graph snapshots
the complete repository, includes root manifests and lockfiles in preflight,
and runs agents from the requested subdirectory inside that snapshot. Apply
authorization remains limited to the requested scope; tracked writes outside
it are recorded as `OUT_OF_SCOPE_WRITE` and make the result ineligible.

Preflight detects trusted lock inputs for Node, Python, Go, Rust, Java, and
.NET. Missing or ambiguous lock inputs are explicit environment gaps; Graph
does not guess an install command. A Go module with no external `require`
entries is standard-library-only and does not need a synthetic `go.sum`.
Every preflight record separates inspection `status` from `readiness`/`ready`,
so a successful scan cannot be mistaken for an executable environment.
When inspection succeeds but `ready=false`, Graph records a
`WORKSPACE_ENVIRONMENT_GAP` before the planner or any model call. Correct the
dependency inputs in the source workspace and start a new Run; the blocked
Run retains its frozen not-ready snapshot as evidence.
Preparation that may execute project code is isolated and lifecycle scripts
are disabled by default.

Each Run also writes a deterministic `workspace-module-map.json` for repository
orientation. Android/Gradle entries include declared modules, module paths,
source/test directories, manifests, declared tasks, and missing modules;
Node entries include bounded package, lockfile, backend-candidate, and script
metadata. Planner and review prompts use a bounded focus-ranked context from
this map, which reduces repeated whole-repository browsing. The map is
orientation evidence only: exact snapshots remain unchanged, no new automatic
exclusion of `build`, `.gradle`, `node_modules`, or local configuration is
introduced, and fail-closed submodule handling remains in place. There is no
public `--submodules separate` mode in this phase.

Android/Gradle machine checks are opt-in. `--machine-preflight` performs only
static declaration/path checks and records `machine-preflight.json`; it does not
execute Gradle. `--machine-preflight-gradle` additionally runs the wrapper's
`projects` command and bounded planned-task `--dry-run` probes in the isolated
execution workspace with a filtered environment and a private Gradle user home.
Gradle configuration code therefore executes only when explicitly requested;
full tests, device actions, and publish/deploy commands are never part of this
probe. Every command records cwd, argv, exit code, timing, output, and before /
after surface evidence. `not_requested` and `not_run` mean that a probe did not
execute; they are not reported as command failures. A declared missing module,
such as KopiAI's `screenshot-demo` when absent, is reported by the static map
before model review.

Examples:

```bash
graph-engineering start --workspace "/path/to/repository" \
  --goal "Review the Android module layout" --mode review \
  --machine-preflight --user-approved

graph-engineering start --workspace "/path/to/repository" \
  --goal "Review the Android module layout" --mode review \
  --machine-preflight-gradle --user-approved
```

On Windows, a real Run requires the selected agent backend to have current
read-only and workspace-write smoke records bound to the runner hash, the
resolved agent command's content SHA-256, and any prefixed CLI script files.
Run `graph-engineering doctor --json` after the
protected smoke workflow; an unverified backend is blocked before a Run or
model call is created. `preview` infers audit goals and shows the four-domain
audit floor and high-assurance routing without creating state.

For a deliberately smaller, cost-bounded run (for example, a pilot on a small
fixture), set `--max-review-nodes <1-6>`. The default remains `6` for broad
repository audits, and the selected limit is persisted and retained on resume.
When no review limit is set explicitly, Graph auto-scales the fan-out for tiny
workspaces (currently 30 files and 256 KiB or less): audits shrink to their
four required domain reviews and ordinary tasks to two review nodes, so a
handful of files is not re-read by five parallel specialists. The decision and
its measurements are recorded in `coverage.auto_review_scaling`; explicitly
set limits are never overridden.

Inspect or stop one exact run without starting another:

```powershell
graph-engineering status --workspace "D:\project\example" --run "<run-id>"
graph-engineering watch --workspace "D:\project\example" --run "<run-id>"
graph-engineering stop --workspace "D:\project\example" --run "<run-id>"
```

`watch` stays attached until the run reaches a terminal state. It reads only persisted files and queue records, so it does not start an agent or consume model capacity. `--follow` uses the same watcher automatically after an approved submit or background resume. The node count is a checkpoint count, not a fabricated completion percentage or ETA. Press Ctrl+C to detach the display without stopping Graph; use `--once --json` for desktop or automation integration.

For a detailed timeline, read the durable event stream without contacting a
model:

```powershell
graph-engineering events `
  --workspace "D:\project\example" `
  --run "<run-id>" `
  --since 0
```

Use `--type WorkItemFailed` (repeatable) to narrow the output. Events are
observations, not commands: this view never starts, resumes, stops, or applies
results.

Verification and independent review receive a 256000-byte aggregate input budget. Before failing, Graph rebuilds their input through standard, tight, minimal, and emergency dependency compaction. An input that still exceeds its budget is stopped before any model call, with every attempted size recorded. After installing a runtime with a compatible budget or reducing the oversized input source, resume the same isolated run; create a replacement only when snapshot freshness checks reject resume.

## Results

Every report directory includes:

- `report.md`: human-readable evidence report;
- `completion.json`: status, checks, changed files, blocker, review result, and total observed cost;
- `finding-lineage.json`: first discoverer, independent confirmations, validation, repair, final review, reopen count, and associated node cost;
- `results/`: conflict-checked files plus the self-contained `apply.mjs`,
  `runtime-admission.mjs`, `process-identity.mjs`, and `runtime/manifest.mjs`
  helpers for eligible isolated runs.

The same directory also contains `runtime-state.json`, an append-only
`events/events.jsonl` stream, and content-addressed `artifacts/`. A work item
is independently reported as `succeeded`, `failed`, `blocked`, `deferred`, or
`pending`. A run becomes `completed_with_gaps` when useful work items finished
but a separate item or final gate did not; that state never produces an apply
command, returns a non-zero CLI exit code, and records the exact same-run resume
command in both `report.md` and `completion.json`. `waiting_service`,
`waiting_environment`, and `waiting_owner` remain explicit waits and are never
converted into partial success.

Isolated results are never merged automatically. Read the report, then use the generated apply command. It refuses to overwrite any source file that changed after Graph started, serializes the full transaction against other applies and live Graph runs for that workspace, and generates no apply command for symlink or Windows-junction results.

Repository-selected package managers and project-local browser CLIs are not run
with host privileges by default. Workspace preflight records the locked commands
for an implementation or verification node to run inside its sandbox. A trusted
repository may explicitly opt into host preparation with
`AEG_ALLOW_HOST_DEPENDENCY_PREPARE=1` and
`AEG_ALLOW_HOST_BROWSER_PREPARE=1`; see [docs/usage.md](docs/usage.md) for the
lockfile, cache, and credential rules.

## Model Routing

```powershell
graph-engineering submit `
  --workspace "D:\project\example" `
  --goal "Audit and repair the repository" `
  --user-approved `
  --role-model "planner=strong-model" `
  --role-model "supervisor=strong-model" `
  --role-model "review=standard-model" `
  --role-effort "planner=xhigh,supervisor=high,review=medium"
```

Use `codex.planner=<model>` or `claude.planner=<model>` when names differ by backend. Child agents are new CLI processes; they do not inherit the current chat's selected model unless the underlying CLI configuration happens to match.

## Proving Value

Do not claim that Graph finds or fixes more defects from one run. The paired harness freezes one fixture, gives independent copies to Graph and a single-agent baseline, enforces matching goal/model/effort/budget declarations, rejects budget overruns, and reports paired 95% intervals. At least five distinct complete comparable pairs, identified by unique `(fixture_id, repetition)` values, are required before any fixture-scoped performance statement is allowed.

Windows compatibility remains an external and currently incomplete gate. Until
the protected Codex / Claude read-only and workspace-write smokes run on a real
Windows host, the status is `UNKNOWN`/`waiting_environment`; Mac-side
preparation is not Windows evidence. Likewise, no claim that Graph saves tokens
or improves effectiveness is allowed until at least five distinct complete
paired evaluations (unique `(fixture_id, repetition)`) bind the same fixture,
goal, model, effort, and budget.

See [docs/usage.md](docs/usage.md) and [docs/architecture.md](docs/architecture.md).
The paired evaluation harness is maintained in the source checkout under
`evals/`; it is deliberately excluded from the npm package and is not an
installed runtime command.

## Why The Control Plane Changed

Earlier Graph versions persisted a mostly linear document flow. That made a
long run depend too heavily on one runner process and made a late node failure
look like total failure. The current design moves facts into a deterministic
control plane: it owns run/work-item state, event ordering, artifact hashes,
permissions, recovery points, and machine-observed checks; model agents remain
replaceable workers that propose findings or changes. The graph still expresses
dependencies, and the loop still performs bounded correction, but neither is
allowed to invent lifecycle truth.

This boundary was chosen for three practical reasons:

1. A process or model outage must pause and resume from a saved checkpoint
   instead of replaying every prior node.
2. Partial, independently verified work must remain visible even when a later
   gate fails.
3. Review claims must be separated from host-observed commands, hashes, and
   permissions so a convincing response cannot turn a failed check into a pass.

The design record and phased implementation plan are in
[`docs/superpowers/specs/2026-08-17-durable-control-plane-design.md`](docs/superpowers/specs/2026-08-17-durable-control-plane-design.md)
and [`docs/implementation-plan.md`](docs/implementation-plan.md).

## Development

```bash
npm test
npm run test:archive
npm run test:package-policy
npm run test:eval
npm run validate
npm run validate:package
npm run test:package-smoke
```

Repository tests use deterministic fake agent processes and do not spend model quota.
The package smoke installs the generated tarball and exercises `help`, `preview`,
`doctor`, and `validate` through npm's public bin shim with an isolated temporary
`CODEX_HOME`. Validation must discover the seven bundled planning specialists;
the control-plane Skill itself is intentionally excluded from node selection.

On Windows, run the opt-in real-agent smoke tests after changing agent invocation or sandbox handling:

```powershell
npm run test:windows-write-smoke
$env:AEG_WRITE_SMOKE_BACKEND = "claude"
npm run test:windows-write-smoke
Remove-Item Env:AEG_WRITE_SMOKE_BACKEND
npm run test:windows-claude-sandbox-smoke
npm run test:windows-codex-readonly-smoke
npm run test:windows-codex-write-smoke
npm run test:windows-claude-write-smoke
```

Each command creates one temporary Git repository, makes one small real model call, and removes only that exact temporary directory with bounded Windows sharing retries. The read-only probe must pass before the writer probe is meaningful. The default write probe invokes Codex with Graph's isolated `workspace-write` arguments and requires a native patch and read-back. Graph preserves the configured `[windows].sandbox` implementation because omitting it can silently turn a nominal writer into a read-only process. Claude attempts use a runner-generated native sandbox settings file with fail-closed startup. The Claude writer and read-only denial probes must both pass before Windows automatic fallback may select Claude; the capability record is bound to the current Graph runner and Claude binary. Explicit Claude selection remains available and fails closed when the native sandbox is unavailable.

## Status

`package.json` declares the `0.3.2` release line. A release claim is valid only
when the exact Git commit, Node 20 Ubuntu/macOS CI run, NPM tarball identity,
dist-tag, and clean-install smoke agree; see the
[release runbook](docs/release-runbook.md). The published `0.3.1` artifact and
tag remain the documented rollback baseline. The source checkout also contains
a separate paired-evaluation harness, but the npm artifact is only the
installable control plane. Production automation still depends on the
reliability and permissions of the configured agent CLIs and model services.
The protected Windows real-agent workflow is manual/nightly only, currently
not fully validated, and is not part of ordinary pull-request model spend.

## License

Apache-2.0.
