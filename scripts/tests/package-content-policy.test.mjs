import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  scanPackagedContent,
  scanPackagedFiles,
  validateReleaseDocuments,
} from "../package-content-policy.mjs";

async function writeFixture(root, relative, content) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

test("package content policy rejects machine paths, credentials, and key material", () => {
  const content = [
    "placeholder /Users/<user>/project",
    "actual /Users/example-user/project",
    "placeholder C:\\Users\\<user>\\project",
    "actual C:\\Users\\example-user\\project",
    "temporary /private/tmp/private-project",
    "credentials https://user:password@example.test/path",
    "-----BEGIN RSA PRIVATE KEY-----",
    `ghp_${"a".repeat(24)}`,
    `sk-${"b".repeat(24)}`,
    `AIza${"c".repeat(24)}`,
    `AKIA${"D".repeat(16)}`,
  ].join("\n");
  const violations = scanPackagedContent("docs/example.md", content);
  assert.deepEqual(
    violations.map((item) => item.rule).sort(),
    [
      "absolute-mac-user-path",
      "absolute-private-temp-path",
      "absolute-windows-user-path",
      "aws-access-key",
      "google-api-key",
      "github-token",
      "private-key-material",
      "provider-api-key",
      "uri-embedded-credentials",
    ].sort(),
  );
});

test("package content policy scans packed files and ignores binary content", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-package-policy-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, "safe.md"), "Use /Users/<user>/project as a placeholder.\n", "utf8");
  await writeFile(path.join(root, "unsafe.md"), "Recorded /Users/example-user/private-project.\n", "utf8");
  await writeFile(path.join(root, "binary.dat"), Buffer.from([0, 1, 2, 3]));

  const violations = await scanPackagedFiles({
    projectRoot: root,
    files: ["safe.md", "unsafe.md", "binary.dat"],
  });
  assert.deepEqual(violations, [{ path: "unsafe.md", rule: "absolute-mac-user-path" }]);
});

test("package content policy rejects path traversal and symlinked package entries", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-package-policy-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "graph-package-policy-outside-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  });
  await writeFile(path.join(outside, "secret.md"), "outside package root\n", "utf8");
  await assert.rejects(
    scanPackagedFiles({ projectRoot: root, files: ["../outside/secret.md"] }),
    /escapes project root/,
  );
  try {
    await symlink(path.join(outside, "secret.md"), path.join(root, "linked.md"));
  } catch (error) {
    if (["EACCES", "EPERM", "ENOTSUP"].includes(error?.code)) {
      t.skip(`symlink unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(
    scanPackagedFiles({ projectRoot: root, files: ["linked.md"] }),
    /must not be a symlink/,
  );
});

test("release document policy accepts canonical contract routing and complete rollback controls", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-release-docs-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const canonical = "skills/autonomous-engineering-graph/references/lifecycle-contract.md";
  const compat = "生命周期扩展/统一工作流契约.md";
  const runbook = "docs/release-runbook.md";
  const skill = "skills/graph-release-assurance/references/final-audit.md";
  await writeFixture(root, canonical, "# Canonical contract\n");
  await writeFixture(root, compat, `See ../${canonical}\n`);
  await writeFixture(root, skill, "Read ../../autonomous-engineering-graph/references/lifecycle-contract.md\n");
  await writeFixture(root, runbook, [
    "<!-- release-controls",
    "release_owner=aabbcdl",
    "monitoring_owner=aabbcdl",
    "rollback_baseline=graph-engineering@0.3.1",
    "failure_threshold=any_identity_mismatch_or_smoke_failure",
    "-->",
    "graph-engineering@0.3.2",
    "npm dist-tag add graph-engineering@0.3.1 latest",
    "npm deprecate graph-engineering@0.3.2 withdrawn",
    "gitHead dist.shasum dist.integrity dist.fileCount dist-tags.latest",
    "help preview doctor validate",
  ].join("\n"));
  const violations = await validateReleaseDocuments({
    projectRoot: root,
    files: [canonical, compat, runbook, skill],
    packageJson: {
      name: "graph-engineering",
      version: "0.3.2",
      repository: { url: "git+https://github.com/aabbcdl/graph-engineering.git" },
    },
  });
  assert.deepEqual(violations, []);
});

test("release document policy rejects stale contract paths and incomplete release controls", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-release-docs-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const canonical = "skills/autonomous-engineering-graph/references/lifecycle-contract.md";
  const compat = "生命周期扩展/统一工作流契约.md";
  const runbook = "docs/release-runbook.md";
  const skill = "skills/graph-release-assurance/references/final-audit.md";
  await writeFixture(root, canonical, "# Canonical contract\n");
  await writeFixture(root, compat, `See ../${canonical}\n`);
  await writeFixture(root, skill, "Read 生命周期扩展/统一工作流契约.md and `lifecycle-contract.md`\n");
  await writeFixture(root, runbook, [
    "<!-- release-controls",
    "release_owner=someone-else",
    "monitoring_owner=someone-else",
    "rollback_baseline=graph-engineering@not-semver",
    "failure_threshold=none",
    "-->",
    "npm unpublish graph-engineering@0.3.2",
  ].join("\n"));
  const violations = await validateReleaseDocuments({
    projectRoot: root,
    files: [canonical, compat, runbook, skill],
    packageJson: {
      name: "graph-engineering",
      version: "0.3.2",
      repository: { url: "git+https://github.com/aabbcdl/graph-engineering.git" },
    },
  });
  const rules = new Set(violations.map((item) => item.rule));
  for (const expected of [
    "release-owner-mismatch",
    "monitoring-owner-mismatch",
    "invalid-rollback-baseline",
    "invalid-failure-threshold",
    "unsafe-unpublish-rollback",
    "legacy-workflow-contract-reference",
    "noncanonical-workflow-contract-target",
  ]) {
    assert.equal(rules.has(expected), true, `missing ${expected}: ${JSON.stringify(violations)}`);
  }
});
