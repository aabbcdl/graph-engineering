# Contributing

## Source Of Truth

Develop in this repository. Do not patch globally installed Skill copies directly. Do not use Graph Engineering to modify Graph Engineering; use the normal development workflow so runtime failures remain diagnosable.

## Before A Change

- preserve explicit opt-in behavior;
- preserve version 1 resume compatibility;
- add a deterministic reproducer before changing runner behavior;
- avoid tests that contact real model services or consume quota;
- keep the autonomous Skill concise and move public documentation to the repository root.

## Required Checks

```bash
npm test
npm run test:archive
npm run test:package-policy
npm run test:eval
npm run validate
npm run validate:package
npm run test:package-smoke
```

When retained lifecycle references change, update their source copies and `specialist-pack.json` hashes together. The validator must pass before installation.

## NPM Release Preparation

The public package is intentionally limited to the runner, bundled Skills,
runtime references, and user-facing documentation. Source-only evaluation and
smoke tooling stays in GitHub. Before a release, run:

```bash
npm run validate:package
npm run test:package-smoke
npm run release:check
```

`release:check` must be `ready` before publishing. It verifies the real GitHub
repository metadata, placeholder-free public docs, the explicit
`graph-engineering-install` bin, private-content absence, and the final tarball
boundary. The
`prepublishOnly` hook runs the same check; no npm lifecycle hook silently edits
the user's `~/.codex/skills` directory.

## Installation Testing

Use a temporary `--codex-home` and `--bin-dir` in tests. Never replace a live global installation. The production installer intentionally refuses while any live run lock or model lease exists.

## Pull Requests

Explain the behavioral contract being changed, the failure the new test reproduces, version-compatibility impact, and exact verification results. Do not claim improved defect discovery or repair without paired evaluation evidence.
