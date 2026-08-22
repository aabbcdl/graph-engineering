#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(path.join(os.tmpdir(), "graph-engineering-package-smoke-"));
try {
  const npmPackArgs = ["pack", "--json", "--pack-destination", root];
  const packed = process.platform === "win32"
    ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `npm.cmd ${npmPackArgs.join(" ")}`], {
        cwd: projectRoot,
        encoding: "utf8",
        windowsHide: true,
      })
    : spawnSync("npm", npmPackArgs, {
        cwd: projectRoot,
        encoding: "utf8",
        windowsHide: true,
      });
  if (packed.error) throw new Error(`Unable to invoke npm: ${packed.error.message}`);
  if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout || "npm pack failed");
  const artifact = JSON.parse(packed.stdout).at(-1)?.filename;
  if (!artifact) throw new Error("npm pack did not return a tarball filename");
  const installRoot = path.join(root, "install");
  const installArgs = ["install", "--prefix", installRoot, "--ignore-scripts", "--no-audit", "--no-fund", path.join(root, artifact)];
  const installed = process.platform === "win32"
    ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `npm.cmd ${installArgs.join(" ")}`], {
        cwd: projectRoot,
        encoding: "utf8",
        windowsHide: true,
      })
    : spawnSync("npm", installArgs, {
        cwd: projectRoot,
        encoding: "utf8",
        windowsHide: true,
      });
  if (installed.error) throw new Error(`Unable to invoke npm: ${installed.error.message}`);
  if (installed.status !== 0) throw new Error(installed.stderr || installed.stdout || "temporary tarball install failed");
  const runner = path.join(installRoot, "node_modules", "graph-engineering", "skills", "autonomous-engineering-graph", "scripts", "graph-runner.mjs");
  const help = spawnSync(process.execPath, [runner, "help"], { cwd: installRoot, encoding: "utf8", windowsHide: true });
  if (help.status !== 0 || !/Graph Engineering/i.test(help.stdout)) {
    throw new Error(help.stderr || help.stdout || "installed CLI smoke failed");
  }
  process.stdout.write(`${JSON.stringify({ status: "pass", tarball: artifact, installed_root: installRoot })}\n`);
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
