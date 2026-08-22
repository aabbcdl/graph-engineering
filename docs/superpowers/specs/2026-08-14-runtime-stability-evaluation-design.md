# Graph Runtime Stability And Evaluation Design

## Objective

Make the Graph runner fail fast on incompatible agent CLIs, preserve one shared
admission boundary during the queue-path rollout, keep runtime contracts aligned
with code, and produce evidence that can compare Graph with a normal single-agent
workflow without overstating one successful run.

## Runtime Decisions

### Codex invocation

- Do not infer CLI behavior from a version threshold.
- Probe each installed Codex candidate with the exact top-level unattended
  argument shape used by Graph.
- Select the newest candidate that accepts that shape.
- Keep `--ask-for-approval never` before `exec`; it is supported by the locally
  installed 0.145 and 0.147 CLIs and preserves the existing unattended contract.
- If no candidate accepts the required shape, stop before a model request with a
  precise compatibility error. Do not guess an automatic-approval replacement.
- Deterministic fake-agent tests must exercise the same argument order as real
  invocation rather than bypassing a version-dependent branch.

### Queue storage rollout

- Use `%USERPROFILE%/.graph-engineering/model-queue` as the new canonical queue
  root so Graph runtime metadata is separate from Codex-owned files.
- Preserve `AEG_MODEL_QUEUE_ROOT` as an explicit override.
- During installation, inspect both the new root and the legacy
  `%CODEX_HOME%/graph-runtime/model-queue` root for live leases.
- Refuse installation while either root or any default run lock is active.
- Do not delete or rewrite legacy queue evidence automatically.
- Install only after the old runtime is idle; after the atomic swap every normal
  launcher uses the new root, avoiding concurrent old/new admission domains.

### Contract alignment

- Planning records scope, risk, exclusions, and checks but cannot open an owner
  gate.
- Synthesis alone may request exact authorization for a concrete protected action
  required by the current goal.
- Documentation, schemas, prompts, and tests must express the same rule.

## Test Stability

- Queue tests must use isolated temporary roots and clean up every child process.
- The complete deterministic suite must terminate without relying on stale-record
  timeouts.
- Invocation tests cover exact argument order, incompatible candidate rejection,
  and selection of the newest compatible candidate.
- Installer tests cover live leases in both legacy and canonical queue roots.

## Real Acceptance Run

Use an isolated, disposable repository fixture and a real configured agent
backend. A successful acceptance run must:

1. reach `completed` rather than merely start;
2. run the standard graph, not `--minimal`;
3. retain planner, supervision, discovery/review, synthesis, implementation or a
   proved no-op, verification, and independent-review evidence;
4. leave the source fixture unchanged until an explicit result application;
5. contain no owner gate unless a concrete protected action is required;
6. report observed checks, changed files, blocker state, and model usage honestly.

## Paired Evaluation

Compare Graph and a normal single-agent audit on independent copies of the same
frozen seeded fixture. Both arms receive the same goal, backend model, reasoning
effort, token budget, and acceptance checks. Hidden truth is available only to the
deterministic scorer.

Primary metrics are validated-defect recall, finding precision, verified repair
rate, regression failures, completed-run rate, wall time, queue time, and tokens.
One pair is only a pipeline pilot. A claim that Graph is stronger requires at
least five complete comparable pairs and a paired 95 percent interval wholly on
the favorable side for the claimed metric. Results remain scoped to the tested
fixtures and configuration.

## Release Gates

- All deterministic runner tests pass to completion.
- Specialist-pack validation and evaluation-harness tests pass.
- Windows real-agent write smoke passes when the backend is available.
- The global launcher and installed Skill hashes match the verified source.
- One real standard Graph acceptance run completes.
- One paired-evaluation pilot completes; broader strength claims remain disabled
  until the sample threshold and confidence rule are satisfied.

## Rollback

The installer keeps its existing staged atomic swap. If validation or real-agent
acceptance fails, do not install the candidate build. If post-install verification
fails, reinstall the previous package copy or restore the preserved installer
backup before starting further Graph runs. Existing run evidence is never purged
as part of this work.
