#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { aggregatePairs, MINIMUM_PAIRS_FOR_CLAIM, scorePair, validateMinimumPairs } from "./lib/scorer.mjs";
import { canonicalJsonSha256 } from "./lib/pair-runner.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const inputPath = path.resolve(argument("--input") || "evals/results/score-input.json");
const outputPath = path.resolve(argument("--output") || "evals/results/report.json");
const input = JSON.parse(await readFile(inputPath, "utf8"));
const declaredMinimumPairs = input.minimum_pairs_for_claim === undefined
  ? MINIMUM_PAIRS_FOR_CLAIM
  : validateMinimumPairs(input.minimum_pairs_for_claim);
const minimumPairsArgument = argument("--minimum-pairs");
const minimumPairs = validateMinimumPairs(
  minimumPairsArgument === null ? declaredMinimumPairs : Number(minimumPairsArgument),
);
if (minimumPairs < declaredMinimumPairs) {
  throw new Error(`--minimum-pairs cannot be lower than input minimum_pairs_for_claim (${declaredMinimumPairs})`);
}
const harness = input.harness || null;
for (const fixture of input.fixtures || []) {
  if (!fixture.truth) throw new Error("Missing hidden truth for fixture " + fixture.id);
  if (fixture.truth_sha256 && fixture.truth_sha256 !== canonicalJsonSha256(fixture.truth)) {
    throw new Error("Fixture " + fixture.id + " truth SHA-256 differs from score input");
  }
}
const truthByFixture = new Map((input.fixtures || []).map((fixture) => [fixture.id, fixture.truth]));
const scored = (input.pairs || []).map((pair) => {
  const truth = truthByFixture.get(pair.fixture_id);
  if (!truth) throw new Error(`Missing hidden truth for fixture ${pair.fixture_id}`);
  return scorePair(pair, truth, harness);
});
const report = { generated_at: new Date().toISOString(), ...aggregatePairs(scored, minimumPairs, harness), pairs: scored };
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ status: "scored", output: outputPath, claim_ready: report.claim_ready, conclusion: report.conclusion })}\n`);
