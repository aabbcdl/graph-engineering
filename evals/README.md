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
- one positive `timeout_minutes` upper bound;
- the complete launch fingerprint, including runner, runtime, harness libraries, adapters, manifest, revision, and Node environment.

Both arms must complete, report backend token usage as non-negative safe
integers, remain within positive safe-integer token/time budgets, and satisfy
the adapter contract. A mismatch, malformed budget, unknown usage, or overrun
rejects the entire pair. Arm order alternates by repetition to reduce first-run
and cache bias.

To isolate orchestration value, configure every Graph role to the same model used by the baseline. A separate role-optimized experiment may measure an operational profile, but it must not be presented as a pure Graph-versus-single-agent causal comparison.

## Harness Binding

Every evaluation records a `harness` fingerprint block in `pairs.json` and `score-input.json`:

- `revision`: the repository Git HEAD at run time;
- `runner_sha256`, `runtime_sha256`, `evals_lib_sha256`, `adapters_sha256`: content hashes of the execution code;
- `manifest_sha256`: the exact evaluation manifest;
- each fixture may declare `truth_sha256`; when present, the runner verifies
  the canonical parsed truth content before launching either arm and records the
  observed hash in every score input;
- `graph_run_version_expected`: the Run schema version the harness requires (currently 3);
- `budget_contract` and `toolchain_contract`: canonical launch constraints that
  every adapter identity must echo when declared. A manifest may carry a
  `toolchain.platforms` map; the harness resolves exactly one current-host
  platform/hash contract before either arm starts;
- `environment`: Node version, platform, and architecture.

The runner persists this block in `harness.json`, passes it to both arms through `--harness-file`, and each adapter recomputes and self-reports what it actually executed through `harness_identity`. The scorer requires every fingerprint field to match the launch record, requires the two arms to agree, and requires the Graph arm's actual Run schema version and persisted token/time budgets to match the declaration.

`harness_binding` is `bound` only for a complete, valid fingerprint, `missing` when no launch fingerprint exists, and `invalid` for a malformed or incomplete fingerprint. Only `bound` data can become `claim_ready`; the other states are descriptive history. Evaluations produced by older protocol versions (for example the August 2026 v2 Run pilots) therefore cannot be merged into new comparable sets.

The truth hash is computed from a recursively key-sorted canonical JSON
representation of the parsed value, followed by one trailing newline. Arrays
retain their original order, so formatting-only whitespace changes do not
silently create a new truth version. A declared hash mismatch fails before an
arm process starts. The scorer repeats the check on `score-input.json`.

Claim-ready evaluation requires the harness itself to run from a Git checkout with a resolvable HEAD. A package-only installation cannot supply that revision and is deliberately fail-closed as descriptive history rather than producing a version-unbound claim.

Rejected pairs are classified as `infrastructure` (the measurement itself failed: adapter contract, identity, unknown usage, declaration mismatch) or `negative_result` (the measured system genuinely did not finish or exceeded its budget). Both block comparability, but only the latter is evidence about the system under test. An `infrastructure` rejection is persisted and stops later repetitions; a measured `negative_result` is retained without truncating the remaining repetitions, so the sample is not biased toward successful completions.

## Fixtures And Hidden Truth

Each fixture is a repository snapshot plus a hidden truth file containing seeded defect IDs and acceptance criteria. The harness hashes the source, creates one frozen copy, gives Graph and baseline independent working copies, and verifies the frozen copy remains unchanged.

`pairs.json` is written during execution without hidden truth. After all arms finish, the harness writes `score-input.json` containing truth for the deterministic scorer. Adapters are trusted local code and must never pass the truth file or scoring input to an agent process.

Natural-language findings are eligible for truth mapping only when the arm marks
them `validated: true`; an unvalidated hypothesis does not contribute to
recall or precision. Hidden acceptance may independently verify a repair even
when an arm did not report the finding.

## Adapter Contract

Each arm command receives these appended arguments:

```text
--workspace <independent fixture copy>
--goal-file <UTF-8 goal file>
--output <required JSON result path>
--model <exact declared model>
--reasoning-effort <level>
--token-budget <integer>
--timeout-minutes <positive integer>
--harness-file <launch fingerprint JSON>
--arm <graph|baseline>
--fixture-id <id>
--repetition <integer>
```

The adapter must run its workflow inside `--workspace`, enforce or monitor the supplied budget, and write the declared `timeout_minutes` and a recomputed `harness_identity`. A manifest may declare a `budget_contract`; the JobQueue pilot requires hard aggregate token and wall-time enforcement from both arms. The Graph adapter passes `--max-run-tokens` and `--max-run-minutes` to `graph-runner.mjs`, then the scorer verifies the persisted Run budget. The single-agent adapter uses the same runner's streaming aggregate token guard plus its process deadline and reports `budget_enforcement` explicitly. When a manifest declares a budget or toolchain contract, every adapter identity must echo the exact canonical contract and the scorer compares it to the launch fingerprint. Missing or asymmetric enforcement or identity binding is infrastructure-invalid and cannot become comparable.

```json
{
  "status": "completed",
  "model": "exact actual model",
  "reasoning_effort": "high",
  "token_budget": 120000,
  "timeout_minutes": 180,
  "usage": { "input_tokens": 1000, "output_tokens": 200 },
  "harness_identity": { "runner_sha256": "...", "graph_run_version_expected": 3 },
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

Repository tests exercise the harness with `evals/tests/fake-arm.mjs`; they never run a real model. The paired evaluation harness is source-checkout tooling and is intentionally excluded from the npm package; controlled evaluator modules, truth files, and hidden tests never become an installable runtime surface. The JobQueue pilot pins Go 1.27.0 binary SHA-256 values for each declared host (`win32-x64`, `linux-x64`, and `darwin-arm64`); CI provisions that exact Go version, and the harness selects only the current platform contract before build/test evidence is accepted.

### Mac pilot status

`manifest.pilot-jobqueue.json` is preflight-validated for Apple Silicon on
2026-08-30: it selects the `darwin-arm64` Go 1.27.0 contract, freezes fixture
SHA-256 `24fa2993897318991d9d8db6d4be5806f4e02a2b5fcdae1f20bf3431e21a3754`,
and binds the truth SHA-256 declared in the manifest. Both adapters are the
Codex-backed Graph and single-agent workflows, and the manifest currently
declares model `gpt-5.6-sol` at `medium` reasoning effort.

The pilot has five alternating repetitions, so it can start up to ten real
model arm runs. Each arm is bounded by the declared 2,500,000-token aggregate
budget and 240-minute timeout. Run it only after the owner confirms that exact
backend/model choice and accepts the quota/time exposure:

```bash
npm run eval:run -- \
  --manifest evals/manifest.pilot-jobqueue.json \
  --output-dir evals/results/run-001
npm run eval:score -- \
  --input evals/results/run-001/score-input.json \
  --output evals/results/run-001/report.json
```

The owner confirmed the pilot budget on 2026-08-31 and changed the exact model
to `gpt-5.6-sol` on 2026-09-01. The first real launch, using the earlier model
selection, passed the Mac state-root isolation preflight, then both Codex arms
were rejected by the configured custom provider with `401 API_KEY_REQUIRED`;
neither arm reported backend token usage, so the pair was
infrastructure-invalid. The incomplete run is retained outside the checkout
for operational debugging and cannot replace the five bound comparable pairs.
The harness now persists an infrastructure-invalid pair and stops before
launching a later repetition; legitimate measured negative results remain
eligible for later repetitions.

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

`tokens_per_validated_defect` is undefined when an arm has no validated defect;
undefined cost metrics produce no delta, confidence interval, or named
advantage. At least five distinct complete comparable pairs, identified by
unique `(fixture_id, repetition)` values, with `harness_binding: "bound"` are
required before `claim_ready` becomes true; the manifest, scorer library, and
`evals/score.mjs` all reject a lower threshold or duplicate pair identity. The scorer also
revalidates each arm's positive safe-integer token/time budgets, so a hand-edited
score input cannot bypass the manifest contract with fractional or unsafe
numbers. Only findings carrying an explicit `validated: true` may contribute to
defect, precision, repair, or cost-efficiency metrics. Every comparable arm must
also retain at least one passing regression check plus non-negative safe-integer
wall and queue timing evidence. Even then,
`statistically_supported_advantages` names a direction only
when its paired 95% interval lies wholly on the favorable side of zero —
including the cost-efficiency metrics, so a quality advantage that costs
disproportionate tokens will not be named as an unqualified win. All conclusions
remain scoped to the tested fixtures, models, budgets, and versions.
