#!/usr/bin/env node

import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function lexicalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function testFilesUnder(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await testFilesUnder(absolute));
    } else if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
      files.push(absolute);
    }
  }
  return files;
}

async function main() {
  const [relativeDirectory, ...forwardedArgs] = process.argv.slice(2);
  if (!relativeDirectory || relativeDirectory.startsWith("-")) {
    throw new Error("usage: node scripts/run-tests.mjs <test-directory> [node-test-options]");
  }

  const directory = path.resolve(projectRoot, relativeDirectory);
  const files = (await testFilesUnder(directory)).sort(lexicalCompare);
  if (files.length === 0) throw new Error(`No .test.mjs files found under ${relativeDirectory}`);

  const result = spawnSync(process.execPath, ["--test", ...forwardedArgs, ...files], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
