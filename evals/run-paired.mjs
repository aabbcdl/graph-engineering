#!/usr/bin/env node

import path from "node:path";
import { runPairedEvaluation } from "./lib/pair-runner.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const manifestPath = path.resolve(argument("--manifest") || "evals/manifest.json");
const outputDirectory = path.resolve(
  argument("--output-dir") || path.join("evals", "results", new Date().toISOString().replace(/[:.]/g, "-")),
);

try {
  const result = await runPairedEvaluation({ manifestPath, outputDirectory });
  process.stdout.write(`${JSON.stringify({ status: "completed", output_directory: result.output_directory, pairs: result.pairs.length, pairs_path: result.pairs_path })}\n`);
} catch (error) {
  console.error(`ERROR: ${error.message || error}`);
  process.exitCode = 1;
}
