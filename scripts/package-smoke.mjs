#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageVersion = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")).version;
const root = await mkdtemp(path.join(os.tmpdir(), "graph-engineering-package-smoke-"));

function commandError(label, execution) {
  return new Error(
    `${label} failed with exit ${execution.status ?? "null"}: ` +
      String(execution.stderr || execution.stdout || execution.error?.message || "no output").trim(),
  );
}

function parseJsonCommand(label, execution, allowedExitCodes) {
  if (execution.error || !allowedExitCodes.includes(execution.status)) throw commandError(label, execution);
  try {
    return JSON.parse(String(execution.stdout || "").trim());
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error.message || error}`);
  }
}

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
  const installedPackage = path.join(installRoot, "node_modules", "graph-engineering");
  const binRoot = path.join(installRoot, "node_modules", ".bin");
  const cli = path.join(binRoot, process.platform === "win32" ? "graph-engineering.ps1" : "graph-engineering");
  const installerCli = path.join(
    binRoot,
    process.platform === "win32" ? "graph-engineering-install.ps1" : "graph-engineering-install",
  );
  await access(cli);
  await access(installerCli);
  const smokeEnvironment = {
    ...process.env,
    CODEX_HOME: path.join(root, "codex-home"),
    AEG_MODEL_QUEUE_ROOT: path.join(root, "model-queue"),
    AEG_EXECUTION_ROOT: path.join(root, "execution"),
  };
  for (const key of [
    "AEG_TEST_MODE",
    "AEG_FAKE_SCENARIO",
    "AEG_CODEX_COMMAND_JSON",
    "AEG_CLAUDE_COMMAND_JSON",
    "AEG_CODEX_CAPABILITY_FILE",
    "AEG_CLAUDE_CAPABILITY_FILE",
    "AEG_CLAUDE_SANDBOX_CAPABILITY_FILE",
  ]) delete smokeEnvironment[key];
  const installerEnvironment = {
    ...smokeEnvironment,
    AEG_TEST_MODE: "1",
    AEG_TEST_RUNTIME_CONTROL_ROOT: path.join(root, "install-control"),
  };
  const installedCodexHome = path.join(root, "installed-codex-home");
  const installedBinDir = path.join(root, "installed-bin");
  const runInstaller = (args) => process.platform === "win32"
    ? spawnSync(
        path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installerCli, ...args],
        { cwd: installedPackage, env: installerEnvironment, encoding: "utf8", windowsHide: true },
      )
    : spawnSync(installerCli, args, {
        cwd: installedPackage,
        env: installerEnvironment,
        encoding: "utf8",
        windowsHide: true,
      });
  const installExecution = runInstaller([
    "--codex-home", installedCodexHome,
    "--bin-dir", installedBinDir,
  ]);
  const installReport = parseJsonCommand("installed Skill installer", installExecution, [0]);
  const installedSkill = path.join(
    installedCodexHome,
    "skills",
    "autonomous-engineering-graph",
    "SKILL.md",
  );
  const installedLauncher = path.join(
    installedBinDir,
    process.platform === "win32" ? "graph-engineering.cmd" : "graph-engineering",
  );
  await access(installedSkill);
  await access(installedLauncher);
  if (
    installReport.status !== "installed" ||
    !Array.isArray(installReport.skills) ||
    !installReport.skills.includes("autonomous-engineering-graph")
  ) {
    throw new Error(`Installed Skill installer returned an invalid record: ${JSON.stringify(installReport)}`);
  }
  const runCli = (args) => process.platform === "win32"
    ? spawnSync(
        path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", cli, ...args],
        { cwd: installedPackage, env: smokeEnvironment, encoding: "utf8", windowsHide: true },
      )
    : spawnSync(cli, args, { cwd: installedPackage, env: smokeEnvironment, encoding: "utf8", windowsHide: true });

  const help = runCli(["help"]);
  if (help.status !== 0 || !/Graph Engineering/i.test(help.stdout)) {
    throw commandError("installed help", help);
  }
  const versionExecution = runCli(["version", "--json"]);
  const version = parseJsonCommand("installed package version", versionExecution, [0]);
  if (
    version.status !== "installed" ||
    version.installed?.package_name !== "graph-engineering" ||
    version.installed?.package_version !== packageVersion ||
    version.latest_checked !== false
  ) {
    throw new Error(`Installed package returned an invalid version record: ${JSON.stringify(version)}`);
  }
  const installedRuntime = path.join(
    installedCodexHome,
    "skills",
    "autonomous-engineering-graph",
    "scripts",
    "graph-runner.mjs",
  );
  const installedVersionExecution = spawnSync(
    process.execPath,
    [installedRuntime, "version", "--json"],
    { cwd: installedPackage, env: installerEnvironment, encoding: "utf8", windowsHide: true },
  );
  const installedVersion = parseJsonCommand("installed Skill version", installedVersionExecution, [0]);
  if (
    installedVersion.installed?.install_metadata !== "recorded" ||
    installedVersion.installed?.runtime?.integrity !== "verified" ||
    installedVersion.installed?.package_version !== packageVersion
  ) {
    throw new Error(`Installed Skill returned an invalid version record: ${JSON.stringify(installedVersion)}`);
  }
  const previewStateRoot = path.join(root, "preview-state");
  const previewExecution = runCli([
    "preview",
    "--workspace", installedPackage,
    "--goal", "Audit the installed package for release readiness",
    "--state-root", previewStateRoot,
    "--json",
  ]);
  const preview = parseJsonCommand("installed preview", previewExecution, [0]);
  const previewCreatedState = await access(previewStateRoot).then(() => true).catch(() => false);
  if (
    preview.status !== "preview" ||
    preview.plan?.mode !== "audit" ||
    preview.creates_state !== false ||
    previewCreatedState
  ) {
    throw new Error(`Installed preview violated its no-state audit contract: ${JSON.stringify(preview)}`);
  }

  const doctorExecution = runCli([
    "doctor",
    "--workspace", installedPackage,
    "--agent-backend", "codex",
    "--json",
  ]);
  const doctor = parseJsonCommand("installed doctor", doctorExecution, [0, 2]);
  if (!["ready", "blocked"].includes(doctor.status) || doctor.backend !== "codex" || !Array.isArray(doctor.checks)) {
    throw new Error(`Installed doctor returned an invalid readiness record: ${JSON.stringify(doctor)}`);
  }

  const validateExecution = runCli([
    "validate",
    "--workspace", installedPackage,
    "--agent-backend", "codex",
    "--state-root", path.join(root, "validate-state"),
    "--json",
  ]);
  const validation = parseJsonCommand("installed validate", validateExecution, [0, 2]);
  if (!Array.isArray(validation)) throw new Error("Installed validate did not return a check array");
  const skillsCheck = validation.find((check) => check.check === "skills");
  const skillsDiscovered = Number.parseInt(String(skillsCheck?.value || ""), 10);
  // The bundled control-plane Skill is intentionally excluded from planner
  // inputs; seven graph specialists are the stable runtime discovery count.
  if (skillsCheck?.status !== "PASS" || !Number.isInteger(skillsDiscovered) || skillsDiscovered < 7) {
    throw new Error(`Installed validate did not discover the packaged Skills: ${JSON.stringify(skillsCheck)}`);
  }
  const validationStatus = validation.some((check) => check.status === "FAIL") ? "blocked" : "ready";

  process.stdout.write(`${JSON.stringify({
    status: "pass",
    tarball: artifact,
    installed_root: installRoot,
    entrypoint: "npm-bin",
    commands: {
      install: {
        status: installReport.status,
        exit_code: installExecution.status,
        skills: installReport.skills.length,
      },
      help: { status: "pass", exit_code: help.status },
      version: {
        status: version.status,
        exit_code: versionExecution.status,
        package_version: version.installed.package_version,
        latest_checked: version.latest_checked,
      },
      installed_version: {
        status: installedVersion.status,
        exit_code: installedVersionExecution.status,
        metadata: installedVersion.installed.install_metadata,
        integrity: installedVersion.installed.runtime.integrity,
      },
      preview: {
        status: preview.status,
        exit_code: previewExecution.status,
        mode: preview.plan.mode,
        creates_state: preview.creates_state,
      },
      doctor: {
        status: doctor.status,
        exit_code: doctorExecution.status,
        backend: doctor.backend,
        gaps: doctor.gaps?.length || 0,
      },
      validate: {
        status: validationStatus,
        exit_code: validateExecution.status,
        checks: validation.length,
        skills_discovered: skillsDiscovered,
      },
    },
  })}\n`);
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
