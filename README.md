# Graph Engineering

Graph Engineering is a durable multi-agent workflow for explicitly approved repository engineering. One approved project goal becomes a persisted graph of planning, stage supervision, discovery, specialist review, synthesis, implementation, verification, and fresh independent review.

It is a standalone project. The installable Skills are the user-facing entry point; the runner, tests, evaluation harness, and release tooling live here as the source of truth.

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

Graph is explicit opt-in. It starts only when the current task names Graph Engineering or accepts a concrete Graph recommendation. Task size, review scope, multiple files, autonomous wording, and approval from another task never select it automatically; ordinary repository work stays in the current task. The host records that current approval with `--user-approved`, which does not authorize protected mutations. The runner does not commit, push, deploy, publish, restart devices, or perform irreversible data operations on its own.

## Requirements

- Node.js 20 or newer
- Codex CLI or Claude Code CLI
- Git-root paths use worktree isolation; non-Git and nested folders use safe copy isolation

## Install

```powershell
npm run install:global
graph-engineering validate
```

The installer refuses to replace a live Graph runtime. Every runner registers outside its per-run state root, so custom `--state-root` runs remain visible to this gate. The installer stages and validates all eight Skills and launchers, swaps them in one rollback boundary, and restores both the prior Skills and launchers if the update fails.
It writes both PowerShell and CMD launchers to the configured npm global binary directory; `--bin-dir` can override that destination.

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
does not guess an install command. Preparation that may execute project code
is isolated and lifecycle scripts are disabled by default.

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

Do not claim that Graph finds or fixes more defects from one run. The paired harness freezes one fixture, gives independent copies to Graph and a single-agent baseline, enforces matching goal/model/effort/budget declarations, rejects budget overruns, and reports paired 95% intervals. At least five complete comparable pairs are required before any fixture-scoped performance statement is allowed.

See [docs/usage.md](docs/usage.md), [docs/architecture.md](docs/architecture.md), and [evals/README.md](evals/README.md).

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

```powershell
npm test
npm run test:eval
npm run validate
npm run validate:package
npm run test:package-smoke
```

Repository tests use deterministic fake agent processes and do not spend model quota.

On Windows, run the opt-in real-agent smoke tests after changing agent invocation or sandbox handling:

```powershell
npm run test:windows-write-smoke
$env:AEG_WRITE_SMOKE_BACKEND = "claude"
npm run test:windows-write-smoke
Remove-Item Env:AEG_WRITE_SMOKE_BACKEND
npm run test:windows-claude-sandbox-smoke
npm run test:windows-codex-write-smoke
npm run test:windows-claude-write-smoke
```

Each command creates one temporary Git repository, makes one small real model call, and removes only that exact temporary directory with bounded Windows sharing retries. The default write probe invokes Codex with Graph's isolated `workspace-write` arguments and requires a native patch and read-back. Graph preserves the configured `[windows].sandbox` implementation because omitting it can silently turn a nominal writer into a read-only process. Claude attempts use a runner-generated native sandbox settings file with fail-closed startup. The Claude writer and read-only denial probes must both pass before Windows automatic fallback may select Claude; the capability record is bound to the current Graph runner and Claude binary. Explicit Claude selection remains available and fails closed when the native sandbox is unavailable.

## Status

Version `0.3.0` is suitable for local evaluation and controlled repository work. Production automation still depends on the reliability and permissions of the configured agent CLIs and model services. The protected Windows real-agent workflow is manual/nightly only and is not part of ordinary pull-request model spend.

## License

Apache-2.0.
