import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildWorkspaceModuleMap,
  captureWorkspaceSurface,
  gradleTasksFromChecks,
  moduleMapContext,
  staticMachinePreflight,
  workspaceSurfaceDiff,
} from "../runtime/workspace-map.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aeg-workspace-map-"));
  await mkdir(path.join(root, "app", "src", "main"), { recursive: true });
  await mkdir(path.join(root, "app", "src", "test"), { recursive: true });
  await mkdir(path.join(root, "backend"), { recursive: true });
  await mkdir(path.join(root, "packages", "ui"), { recursive: true });
  await writeFile(path.join(root, "settings.gradle.kts"), [
    'rootProject.name = "fixture"',
    'include(":app", ":screenshot-demo")',
    'project(":app").projectDir = file("app")',
  ].join("\n"));
  await writeFile(path.join(root, "build.gradle.kts"), 'tasks.register("rootCheck") {}\n');
  await writeFile(path.join(root, "app", "build.gradle.kts"), [
    'plugins { id("com.android.application") }',
    'tasks.register("assembleFixture") {}',
  ].join("\n"));
  await writeFile(path.join(root, "app", "src", "main", "AndroidManifest.xml"), "<manifest package=\"fixture.app\" />\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "fixture-root",
    private: true,
    workspaces: ["packages/*"],
    scripts: { build: "echo build" },
  }));
  await writeFile(path.join(root, "package-lock.json"), "{}\n");
  await writeFile(path.join(root, "backend", "package.json"), JSON.stringify({
    name: "fixture-backend",
    scripts: { start: "node server.js" },
  }));
  await writeFile(path.join(root, "packages", "ui", "package.json"), JSON.stringify({ name: "@fixture/ui" }));
  await writeFile(path.join(root, "CLAUDE.md"), "Use the fixture rules.\n");
  return root;
}

test("workspace module map is deterministic and exposes Gradle gaps without changing snapshot rules", async () => {
  const root = await fixture();
  try {
    const first = await buildWorkspaceModuleMap(root);
    const second = await buildWorkspaceModuleMap(root);
    assert.equal(first.fingerprint, second.fingerprint);
    assert.deepEqual(first.gradle.missing_modules, [{
      project_path: ":screenshot-demo",
      path: "screenshot-demo",
      missing: ["module_directory"],
      status: "missing",
    }]);
    assert.ok(first.gradle.modules.some((module) => module.project_path === ":app" && module.manifest.exists));
    assert.deepEqual(first.gradle.root_project.declared_tasks, ["rootCheck"]);
    assert.deepEqual(first.node.lockfiles, ["package-lock.json"]);
    assert.ok(first.node.packages.some((pkg) => pkg.path === "backend" && pkg.backend_candidate));
    assert.deepEqual(first.rule_files, ["CLAUDE.md"]);
    const context = moduleMapContext(first, { focus: "screenshot demo", maxBytes: 20_000 });
    assert.match(context, /screenshot-demo/);
    assert.match(context, /exact workspace snapshot/);

    const preflight = staticMachinePreflight(first, { requested: true });
    assert.equal(preflight.status, "pass");
    assert.equal(preflight.readiness, "gaps");
    assert.ok(preflight.gaps.some((gap) => gap.kind === "gradle-module" && gap.project_path === ":screenshot-demo"));
    assert.equal(preflight.probe.status, "not_requested");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("machine surface evidence sees ignored-style files and Gradle task probes stay command-bounded", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aeg-workspace-surface-"));
  try {
    await writeFile(path.join(root, "before.txt"), "before\n");
    const before = await captureWorkspaceSurface(root);
    await writeFile(path.join(root, "generated.txt"), "after\n");
    const after = await captureWorkspaceSurface(root);
    assert.deepEqual(workspaceSurfaceDiff(before, after), ["generated.txt"]);
    assert.deepEqual(gradleTasksFromChecks([
      { id: "test", command: "./gradlew :app:testDebugUnitTest --no-daemon --console=plain" },
      { id: "unsafe", command: "cd app && ./gradlew test" },
      { id: "shell", command: "./gradlew test && rm -rf ." },
    ]), [":app:testDebugUnitTest"]);
    await chmod(path.join(root, "before.txt"), 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
