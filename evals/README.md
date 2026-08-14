# Paired Evaluation Protocol

The evaluation harness answers a narrow question: on the same frozen repository fixture and constraints, what did Graph Engineering find and repair compared with a normal single-agent workflow?

It does not turn one successful run into a general performance claim.

## Fairness Rules

Every pair must use the same:

- fixture SHA-256;
- goal SHA-256;
- declared model;
- reasoning effort;
- token budget.

Both arms must complete, report backend token usage, remain within budget, and satisfy the adapter contract. A mismatch or overrun rejects the entire pair. Arm order alternates by repetition to reduce first-run and cache bias.

To isolate orchestration value, configure every Graph role to the same model used by the baseline. A separate role-optimized experiment may measure an operational profile, but it must not be presented as a pure Graph-versus-single-agent causal comparison.

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
- paired mean deltas with 95% intervals.

At least five complete comparable pairs are required before `claim_ready` becomes true. Even then, `statistically_supported_advantages` names a direction only when its paired 95% interval lies wholly on the favorable side of zero. All conclusions remain scoped to the tested fixtures, models, budgets, and versions.
