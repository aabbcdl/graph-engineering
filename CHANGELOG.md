# Changelog

## 0.3.1 - 2026-08-30

- Make source and evaluation test commands deterministic across POSIX shells,
  PowerShell, and `cmd.exe` by enumerating test files in Node instead of using
  shell glob expansion.
- Make Codex path-resolution regression coverage use an external controlled CLI
  fixture, so CI does not depend on a Codex installation on the runner.
- Add macOS 14 to the public deterministic CI matrix for the Apple Silicon
  target path.
- Synchronize release, evidence, and migration documentation with the public
  GitHub repository and NPM release state.

This patch does not claim Windows real-agent readiness or Graph-vs-baseline
effectiveness. Those remain separately evidenced gates.

## 0.3.0 - 2026-08-28

- Published the durable, evidence-driven Graph Engineering control plane as a
  public NPM package.
- Included the bundled specialist pack, runtime state/event/artifact modules,
  isolated workspace modes, recovery, preview/diff/apply/recheck/runs/gc
  controls, package validation, and explicit installer flow.
- Kept evaluation fixtures, hidden tests, local run output, and protected
  real-agent smoke tooling outside the installable runtime surface.
