#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const GRAPH_SKILL_DIR = path.dirname(SCRIPT_DIR);
const SKILLS_ROOT = path.dirname(GRAPH_SKILL_DIR);
const MANIFEST_PATH = path.join(GRAPH_SKILL_DIR, "references", "specialist-pack.json");

function parseArgs(argv) {
  const options = { json: false, sourceRoot: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--source-root") {
      if (!argv[index + 1]) throw new Error("--source-root requires a path");
      options.sourceRoot = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return options;
}

async function sha256(target) {
  const content = await readFile(target);
  return createHash("sha256").update(content).digest("hex");
}

function resolvePortable(root, relative) {
  return path.join(root, ...relative.split("/"));
}

async function validate(options) {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const failures = [];
  const checks = [];
  const sources = new Set();
  const record = (ok, check, detail) => {
    checks.push({ ok, check, detail });
    if (!ok) failures.push(`${check}: ${detail}`);
  };

  const verifyReference = async ({ target, source, sha256: expected }, baseDir) => {
    const targetPath = resolvePortable(baseDir, target);
    try {
      const actual = await sha256(targetPath);
      record(actual === expected, "retained_reference_hash", `${targetPath} expected=${expected} actual=${actual}`);
    } catch (error) {
      record(false, "retained_reference_exists", `${targetPath}: ${error.message}`);
    }
    record(!sources.has(source), "source_mapped_once", source);
    sources.add(source);
    if (options.sourceRoot) {
      const sourcePath = resolvePortable(options.sourceRoot, source);
      try {
        const actualSource = await sha256(sourcePath);
        record(actualSource === expected, "source_hash", `${sourcePath} expected=${expected} actual=${actualSource}`);
      } catch (error) {
        record(false, "source_exists", `${sourcePath}: ${error.message}`);
      }
    }
  };

  for (const reference of manifest.shared_references || []) {
    await verifyReference(reference, GRAPH_SKILL_DIR);
  }

  for (const skill of manifest.skills || []) {
    const skillDir = path.join(SKILLS_ROOT, skill.name);
    const skillFile = path.join(skillDir, "SKILL.md");
    const agentFile = path.join(skillDir, "agents", "openai.yaml");
    try {
      const skillText = await readFile(skillFile, "utf8");
      record(new RegExp(`^name: ${skill.name}$`, "m").test(skillText), "skill_name", skillFile);
      record(!/\bTODO\b|\[TODO/i.test(skillText), "skill_has_no_placeholder", skillFile);
      for (const reference of skill.references || []) {
        record(skillText.includes(path.basename(reference.target)), "skill_links_reference", `${skill.name}:${reference.target}`);
        await verifyReference(reference, skillDir);
      }
    } catch (error) {
      record(false, "skill_exists", `${skillFile}: ${error.message}`);
    }
    try {
      const agentText = await readFile(agentFile, "utf8");
      record(agentText.includes(`$${skill.name}`), "agent_default_prompt", agentFile);
      const shortDescription = agentText.match(/short_description:\s*"([^"]+)"/)?.[1] || "";
      record(shortDescription.length >= 25 && shortDescription.length <= 64, "agent_short_description", `${agentFile}:${shortDescription.length}`);
    } catch (error) {
      record(false, "agent_metadata_exists", `${agentFile}: ${error.message}`);
    }
  }

  record((manifest.skills || []).length === 7, "specialist_count", String((manifest.skills || []).length));
  record(sources.size === 15, "source_coverage", `${sources.size}/15`);
  return { status: failures.length ? "fail" : "pass", failures, checks };
}

const options = parseArgs(process.argv.slice(2));
const result = await validate(options);
if (options.json) {
  console.log(JSON.stringify(result));
} else if (result.status === "pass") {
  console.log(`PASS: 7 specialist skills retain all 15 source prompts (${result.checks.length} checks)`);
} else {
  console.error(result.failures.join("\n"));
}
process.exitCode = result.status === "pass" ? 0 : 1;
