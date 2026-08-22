#!/usr/bin/env node

// Analyzes backend-reported token usage from a saved Graph run state
// directory (the graph-state folder of an evaluation arm or any run state
// root). Read-only: it never starts a model process.
//
// Usage:
//   node evals/scripts/analyze-run-tokens.mjs <graph-state-dir> [<graph-state-dir> ...]

import fs from "node:fs";
import path from "node:path";

function findRunDir(root) {
  const stack = [path.resolve(root)];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      continue;
    }
    if (fs.existsSync(path.join(current, "nodes")) && fs.statSync(path.join(current, "nodes")).isDirectory()) {
      return current;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
    }
  }
  throw new Error(`No run directory with a nodes/ folder found under ${root}`);
}

function stageOf(node) {
  if (node.startsWith("review-")) return "review";
  if (node.includes("supervision")) return "supervision";
  if (node.startsWith("correction")) return "correction";
  if (node.startsWith("planner")) return "planner";
  return node.replace(/-r\d+$/, "");
}

function analyzeState(stateRoot) {
  const runDir = findRunDir(stateRoot);
  const rows = [];
  for (const node of fs.readdirSync(path.join(runDir, "nodes"))) {
    const nodeDir = path.join(runDir, "nodes", node);
    const usage = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 };
    let attempts = 0;
    try {
      attempts = JSON.parse(fs.readFileSync(path.join(nodeDir, "attempts.json"), "utf8")).length;
    } catch {}
    try {
      const proof = JSON.parse(fs.readFileSync(path.join(nodeDir, "proof.json"), "utf8"));
      Object.assign(usage, proof.usage || {});
    } catch {}
    let inputBytes = 0;
    try {
      inputBytes = fs.statSync(path.join(nodeDir, "input.md")).size;
    } catch {}
    rows.push({
      node,
      attempts,
      inputBytes,
      input: usage.input_tokens || 0,
      cached: usage.cached_input_tokens || 0,
      output: usage.output_tokens || 0,
      total: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    });
  }
  return { runDir, rows };
}

function report(stateRoot) {
  const { runDir, rows } = analyzeState(stateRoot);
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  const input = rows.reduce((sum, row) => sum + row.input, 0);
  const cached = rows.reduce((sum, row) => sum + row.cached, 0);
  console.log(`===== ${runDir} =====`);
  console.log("node | attempts | input_tok | cached | output_tok | total | pct | input.md bytes");
  for (const row of rows.slice().sort((left, right) => right.total - left.total)) {
    console.log(
      `${row.node} | ${row.attempts} | ${row.input} | ${row.cached} | ${row.output} | ${row.total} | ${(100 * row.total / total).toFixed(1)}% | ${row.inputBytes}`,
    );
  }
  const byStage = new Map();
  for (const row of rows) {
    const stage = stageOf(row.node);
    const aggregate = byStage.get(stage) || { total: 0, nodes: 0, attempts: 0 };
    aggregate.total += row.total;
    aggregate.nodes += 1;
    aggregate.attempts += row.attempts;
    byStage.set(stage, aggregate);
  }
  console.log("--- by stage ---");
  for (const [stage, aggregate] of [...byStage.entries()].sort((left, right) => right[1].total - left[1].total)) {
    console.log(
      `${stage}: ${aggregate.total} tokens (${(100 * aggregate.total / total).toFixed(1)}%) across ${aggregate.nodes} nodes, ${aggregate.attempts} attempts`,
    );
  }
  console.log(`TOTAL: ${total} (input ${input}, cached ${cached}, output ${total - input})`);
  console.log("");
}

const targets = process.argv.slice(2);
if (!targets.length) {
  console.error("Usage: node evals/scripts/analyze-run-tokens.mjs <graph-state-dir> [...]");
  process.exitCode = 1;
} else {
  for (const target of targets) report(target);
}
