# Paired Evaluation Protocol

The evaluation harness answers a narrow question: on the same frozen repository fixture and constraints, what did Graph Engineering find and repair compared with a normal single-agent workflow?

It does not turn one successful run into a general performance claim.

## Fairness Rules

Every pair must use the same:

- fixture SHA-256;
- goal SHA-256;
- declared model;
- reasoning effort;
- token budget;
- runner identity: both arms must self-report the SHA-256 of the `graph-runner.mjs` they executed, and the Graph arm must additionally report its Run schema version.

Both arms must complete, report backend token usage, remain within budget, and satisfy the adapter contract. A mismatch or overrun rejects the entire pair. Arm order alternates by repetition to reduce first-run and cache bias.

To isolate orchestration value, configure every Graph role to the same model used by the baseline. A separate role-optimized experiment may measure an operational profile, but it must not be presented as a pure Graph-versus-single-agent causal comparison.

## Harness Binding

Every evaluation records a `harness` fingerprint block in `pairs.json` and `score-input.json`:

- `revision`: the repository Git HEAD at run time;
- `runner_sha256`, `runtime_sha256`, `evals_lib_sha256`, `adapters_sha256`: content hashes of everything that executed;
- `graph_run_version_expected`: the Run schema version the harness requires (currently 3);
- `environment`: Node version, platform, and architecture.

Each adapter self-reports what it executed through `harness_identity` in its result. The scorer rejects any pair whose identity is missing, whose arms disagree on the runner hash, or whose Run schema version differs from the harness expectation. Score inputs without a `harness` block are `harness_binding: "missing"` and can never become `claim_ready`; their results remain descriptive history. Evaluations produced by older protocol versions (for example the August 2026 v2 Run pilots) therefore cannot be merged into new comparable sets.

Rejected pairs are classified as `infrastructure` (the measurement itself failed: adapter contract, identity, unknown usage, declaration mismatch) or `negative_result` (the measured system genuinely did not finish or exceeded its budget). Both block comparability, but only the latter is evidence about the system under test.

## Fixtures And Hidden Truth

Each fixture is a repository snapshot plus a hidden truth file containing seeded defect IDs and acceptance criteria. The harness hashes the source, creates one frozen copy, gives Graph and baseline independent working copies, and verifies the frozen copy remains unchanged.

`pairs.json` is written during execution without hidden truth. After all arms finish, the harness writes `score-input.json` containing truth for the deterministic scorer. Adapters are trusted local code and must never pass the truth file or scoring input to an agent process.

## Adapter Contract

Each arm command receives these appended arguments:

```text
--workspace <independent fixture copy>
--goal-file <UTF-8 goal file>
--output <required JSON result path>
--model <exact declared model>
--reasoning-effort <level>
--token-budget <integer>
--arm <graph|baseline>
--fixture-id <id>
--repetition <integer>
```

The adapter must run its workflow inside `--workspace`, enforce or monitor the supplied budget, and write:

```json
{
  "status": "completed",
  "model": "exact actual model",
  "reasoning_effort": "high",
  "token_budget": 120000,
  "usage": { "input_tokens": 1000, "output_tokens": 200 },
  "findings": [
    {
      "defect_id": "seeded-defect-id-or-null",
      "validated": true,
      "fixed": true,
      "repair_verified": true
    }
  ],
  "regression_checks": [{ "id": "tests", "status": "pass" }],
  "completed_gates": true,
  "queue_ms": 0
}
```

For the baseline, `completed_gates` means its declared acceptance and regression checks completed, not that it imitated Graph's internal stages.

## Run And Score

Create a manifest from `manifest.example.json`, using adapter command paths that exist on your machine:

```powershell
npm run eval:run -- --manifest evals/manifest.json --output-dir evals/results/run-001
npm run eval:score -- --input evals/results/run-001/score-input.json --output evals/results/run-001/report.json
```

Repository tests exercise the harness with `evals/tests/fake-arm.mjs`; they never run a real model.

## Metrics

The scorer reports:

- validated defect recall;
- finding precision against hidden truth;
- verified repair rate;
- regression failures;
- completed-run rate;
- wall time, queue time, and tokens;
- cost efficiency: `validated_defects_per_mtok`, `verified_repairs_per_mtok`, and `tokens_per_validated_defect`;
- paired mean deltas with 95% intervals.

At least five complete comparable pairs with harness binding are required before `claim_ready` becomes true. Even then, `statistically_supported_advantages` names a direction only when its paired 95% interval lies wholly on the favorable side of zero — including the cost-efficiency metrics, so a quality advantage that costs disproportionate tokens will not be named as an unqualified win. All conclusions remain scoped to the tested fixtures, models, budgets, and versions.
