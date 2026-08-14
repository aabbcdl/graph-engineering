# Graph Engineering

Graph Engineering is an explicit, durable multi-agent workflow for repository audit and repair. One approved goal becomes a persisted graph of planning, stage supervision, discovery, specialist review, synthesis, implementation, verification, and fresh independent review.

It is a standalone project. The installable Skills are the user-facing entry point; the runner, tests, evaluation harness, and release tooling live here as the source of truth.

## What Version 2 Adds

- isolated Git worktree or copy execution by default, so normal development can continue;
- artifact-only control gates after planning, synthesis, and implementation, with one bounded correction per stage and no repeated repository discovery;
- backend, model, and reasoning-effort selection by role;
- terminal notifications and a machine-readable `completion.json`;
- per-finding lineage from first discovery through confirmation, repair, verification, and final review;
- Windows workspace-write smoke validation plus machine-enforced evidence for permission and tooling blockers;
- a compact runner-enforced node contract, bounded dependency context, and preflight input budgets that stop oversized prompts before a model call;
- structured authorization decisions, so optional or excluded protected work stays deferred instead of blocking reversible repairs;
- associated node time and backend-reported token use, explicitly not presented as exclusive per-finding cost;
- a paired evaluation harness for comparing Graph with a normal single-agent review on the same frozen fixture.

Graph never starts implicitly. A user must name Graph Engineering in the current task or explicitly approve a concrete recommendation. The runner does not commit, push, deploy, publish, restart devices, or perform irreversible data operations on its own.

## Requirements

- Node.js 20 or newer
- Codex CLI or Claude Code CLI
- Git for worktree isolation; non-Git folders use safe copy isolation

## Install

```powershell
npm run install:global
graph-engineering validate
```

The installer refuses to replace a live Graph runtime. It stages and validates all eight Skills, swaps them transactionally, and restores the prior installation if the update fails.
It writes both PowerShell and CMD launchers to the configured npm global binary directory; `--bin-dir` can override that destination.

## Start One Approved Run

Background execution is the normal unattended form:

```powershell
graph-engineering submit `
  --workspace "D:\project\example" `
  --goal "Audit and repair validated repository defects without regressions" `
  --user-approved
```

`submit` returns only after the child confirms startup and ownership with `handoff: confirmed`. Version 2 defaults to `--workspace-mode auto` and `--supervision stage`.

Inspect or stop one exact run without starting another:

```powershell
graph-engineering status --workspace "D:\project\example" --run "<run-id>"
graph-engineering stop --workspace "D:\project\example" --run "<run-id>"
```

## Results

Every report directory includes:

- `report.md`: human-readable evidence report;
- `completion.json`: status, checks, changed files, blocker, review result, and total observed cost;
- `finding-lineage.json`: first discoverer, independent confirmations, validation, repair, final review, reopen count, and associated node cost;
- `results/`: conflict-checked files and `apply.mjs` for isolated runs.

Isolated results are never merged automatically. Read the report, then use the generated apply command. It refuses to overwrite any source file that changed after Graph started.

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

## Development

```powershell
npm test
npm run test:eval
npm run validate
```

Repository tests use deterministic fake agent processes and do not spend model quota.

On Windows, run the opt-in real-agent write smoke test after changing agent invocation or sandbox handling:

```powershell
npm run test:windows-write-smoke
```

This creates a temporary Git repository, invokes Codex with the same isolated `workspace-write` arguments used by Graph, requires a native patch and read-back, and then removes the temporary repository. It makes one small real model call. Graph preserves the configured `[windows].sandbox` implementation because omitting it can silently turn a nominal writer into a read-only process.

## Status

Version `0.2.0` is suitable for local evaluation and controlled repository work. Production automation still depends on the reliability and permissions of the configured agent CLIs and model services.

## License

Apache-2.0.
