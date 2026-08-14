# Usage

## Explicit Approval

Graph Engineering is never selected merely because a task is broad, difficult, multi-file, review-oriented, or autonomous. Start a new run only after the user names Graph in the current task or explicitly accepts a concrete Graph recommendation.

Before launch, state the workspace, exact goal, that several independent agent processes will run, and that the model service may queue them for tens of minutes.

## Foreground And Background

Use `start` when the invoking host will wait on the same runner process:

```powershell
graph-engineering start --workspace "D:\project\example" --goal "<goal>" --user-approved
```

Use `submit` when the run should continue after the parent task returns:

```powershell
graph-engineering submit --workspace "D:\project\example" --goal "<goal>" --user-approved
```

Do not add `--background` to `submit`; it is already the background command. Use `resume --background` only for one exact saved run.

On Windows PowerShell, use the generated `graph-engineering.ps1` launcher (PowerShell selects it automatically when the `.ps1` and `.cmd` launchers share one directory). It forwards arguments as an array, so a multiline `--goal` cannot consume or discard later flags such as `--user-approved`. Do not call `graph-engineering.cmd` directly with multiline values; `%*` is only reliable for ordinary single-line CMD arguments.

## Default Version 2 Behavior

- `--workspace-mode auto`: use a detached worktree for Git repositories and a safe copied snapshot otherwise;
- `--supervision stage`: supervise planning, synthesis, and implementation;
- `--notify`: send one terminal-state system notification when the platform supports it;
- global adaptive model admission: begin with two processes, grow to four after stable success, contract on structured overload;
- one workspace may use two read-only lanes when capacity is free, while writers remain exclusive.

Use `--workspace-mode live` only when in-place changes are deliberately required. Version 1 saved runs preserve their legacy live/no-supervision behavior when resumed.

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

## Exact Run Control

```powershell
graph-engineering status --workspace "D:\project\example" --run "<run-id>" --json
graph-engineering stop --workspace "D:\project\example" --run "<run-id>"
graph-engineering resume --workspace "D:\project\example" --run "<run-id>"
graph-engineering purge --workspace "D:\project\example" --run "<run-id>"
```

`stop` is recoverable and preserves completed nodes and evidence. `purge` deletes one inactive run's local evidence and isolated worktree; it does not delete source workspace files.

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

The source workspace is untouched during an isolated run. On completion, inspect `report.md`, `completion.json`, and the diff in the run's `results` directory. Then execute the exact `apply_command` recorded in `run.json` or the report.

The apply script verifies every source record against its launch hash before writing. A conflict stops the entire apply before any file changes. Graph never commits or merges the result automatically.
