# Changelog

## 0.3.2

- Add installation provenance plus offline `version` and explicit
  `version --check` commands so users and Agents can distinguish the installed
  Git source or package and the complete deployed Skill set from canonical
  GitHub `main` and NPM `latest`.
- Document the complete first-user flow, one-prompt repository runs, and
  Agent-managed updates without introducing silent self-update behavior.
- Add source-checkout-only Run archive tooling that exports sanitized operational
  metadata and evidence-file hashes without copying workspace or report content.
- Harden paired-evaluation state-root isolation and stop later repetitions after
  an infrastructure-invalid pair while retaining measured negative results.
- Reject fractional or unsafe token and timeout budgets and duplicate pair
  identities in scorer-only inputs so malformed data cannot unlock
  `claim_ready` outside the manifest contract.
- Require explicit `validated: true` findings before defect or repair metrics
  can contribute to a paired-evaluation advantage.
- Require non-empty passing regression evidence and valid wall/queue timing for
  every arm counted as comparable.
- Add package-content privacy checks and deterministic archive/package-policy
  regression tests to the local and CI release gates.
- Route every installed lifecycle Skill to the packaged canonical workflow
  contract while retaining a source-compatible legacy entrypoint.
- Add a release runbook with an explicit owner, post-publish identity and
  clean-install checks, a zero-tolerance failure threshold, and a reversible
  NPM dist-tag rollback to `0.3.1`.

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
