#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { aggregatePairs, scorePair } from "./lib/scorer.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const inputPath = path.resolve(argument("--input") || "evals/results/score-input.json");
const outputPath = path.resolve(argument("--output") || "evals/results/report.json");
const minimumPairs = Number.parseInt(argument("--minimum-pairs") || "5", 10);
const input = JSON.parse(await readFile(inputPath, "utf8"));
const harness = input.harness || null;
const truthByFixture = new Map((input.fixtures || []).map((fixture) => [fixture.id, fixture.truth]));
const scored = (input.pairs || []).map((pair) => {
  const truth = truthByFixture.get(pair.fixture_id);
  if (!truth) throw new Error(`Missing hidden truth for fixture ${pair.fixture_id}`);
  return scorePair(pair, truth, harness);
});
const report = { generated_at: new Date().toISOString(), ...aggregatePairs(scored, minimumPairs, harness), pairs: scored };
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ status: "scored", output: outputPath, claim_ready: report.claim_ready, conclusion: report.conclusion })}\n`);
