import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  GITHUB_MAIN_ENDPOINT,
  NPM_LATEST_ENDPOINT,
  compareSemver,
  graphVersionReport,
  latestVersionCheck,
  normalizedRepositoryUrl,
  updateGuidance,
} from "../version-info.mjs";

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(value),
  };
}

function sourceIdentity(overrides = {}) {
  return {
    package_version: "0.3.2",
    source: {
      type: "git",
      canonical_repository: true,
      commit: "a".repeat(40),
      modified: false,
      ...overrides,
    },
    runtime: { integrity: "verified" },
  };
}

test("semantic version comparison handles releases and prereleases", () => {
  assert.equal(compareSemver("0.3.1", "0.3.2"), -1);
  assert.equal(compareSemver("1.0.0", "1.0.0"), 0);
  assert.equal(compareSemver("1.0.1", "1.0.0"), 1);
  assert.equal(compareSemver("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareSemver("1.0.0-rc.2", "1.0.0-rc.10"), -1);
  assert.equal(compareSemver("not-a-version", "1.0.0"), null);
});

test("repository normalization accepts only credential-free canonical GitHub shapes", () => {
  assert.equal(
    normalizedRepositoryUrl("git+https://github.com/aabbcdl/graph-engineering.git"),
    "https://github.com/aabbcdl/graph-engineering.git",
  );
  assert.equal(
    normalizedRepositoryUrl("git@github.com:aabbcdl/graph-engineering.git"),
    "https://github.com/aabbcdl/graph-engineering.git",
  );
  assert.equal(
    normalizedRepositoryUrl("ssh://git@github.com/aabbcdl/graph-engineering.git"),
    "https://github.com/aabbcdl/graph-engineering.git",
  );
  assert.equal(normalizedRepositoryUrl("https://example.com/aabbcdl/graph-engineering.git"), null);
  assert.equal(normalizedRepositoryUrl("https://user:secret@github.com/aabbcdl/graph-engineering.git"), null);
  assert.equal(normalizedRepositoryUrl("ssh://owner@github.com/aabbcdl/graph-engineering.git"), null);
});

test("Git update guidance never pulls an unverified origin", () => {
  const canonical = updateGuidance({
    source: { type: "git", canonical_repository: true, root: "/tmp/graph-engineering" },
  });
  assert.equal(canonical.method, "agent-managed-git");
  assert.equal(canonical.source_root, "/tmp/graph-engineering");

  const fork = updateGuidance({
    source: { type: "git", canonical_repository: false, root: "/tmp/graph-engineering-fork" },
  });
  assert.equal(fork.method, "agent-managed-reinstall");
  assert.equal(fork.source_root, null);
  assert.match(fork.instruction, /fresh https:\/\/github\.com\/aabbcdl\/graph-engineering\.git checkout/i);
  assert.doesNotMatch(fork.instruction, /update canonical origin/i);
});

test("source version check compares the recorded commit with canonical GitHub main", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url === GITHUB_MAIN_ENDPOINT) return jsonResponse({ sha: "a".repeat(40) });
    if (url === NPM_LATEST_ENDPOINT) return jsonResponse({ version: "0.3.1" });
    return jsonResponse({}, 404);
  };
  const result = await latestVersionCheck(sourceIdentity(), { fetchImpl, timeoutMs: 100 });
  assert.equal(result.channel, "github-main");
  assert.equal(result.status, "current");
  assert.equal(result.current_for_channel, true);
  assert.equal(result.stable.version, "0.3.1");
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.options.credentials, "omit");
    assert.equal(request.options.redirect, "error");
    assert.equal("Authorization" in request.options.headers, false);
  }

  const behind = await latestVersionCheck(sourceIdentity(), {
    fetchImpl: async (url) => url === GITHUB_MAIN_ENDPOINT
      ? jsonResponse({ sha: "b".repeat(40) })
      : jsonResponse({ version: "0.3.1" }),
    timeoutMs: 100,
  });
  assert.equal(behind.status, "update_available");
  assert.equal(behind.current_for_channel, false);
});

test("package version check distinguishes an available update from an unreleased newer copy", async () => {
  const packageIdentity = (version) => ({
    package_version: version,
    source: { type: "package" },
    runtime: { integrity: "verified" },
  });
  const fetchImpl = async (url) => {
    assert.equal(url, NPM_LATEST_ENDPOINT);
    return jsonResponse({ version: "0.3.2" });
  };
  const behind = await latestVersionCheck(packageIdentity("0.3.1"), { fetchImpl, timeoutMs: 100 });
  assert.equal(behind.status, "update_available");
  assert.equal(behind.current_for_channel, false);

  const ahead = await latestVersionCheck(packageIdentity("0.3.3"), { fetchImpl, timeoutMs: 100 });
  assert.equal(ahead.status, "ahead_of_stable");
  assert.equal(ahead.current_for_channel, true);
  assert.equal(ahead.source.status, "not-applicable");
});

test("an unpacked package without installation provenance is not reported as current", async () => {
  const result = await latestVersionCheck(
    {
      package_version: "0.3.2",
      source: { type: "package" },
      runtime: { integrity: "unrecorded" },
    },
    {
      fetchImpl: async (url) => {
        assert.equal(url, NPM_LATEST_ENDPOINT);
        return jsonResponse({ version: "0.3.2" });
      },
      timeoutMs: 100,
    },
  );
  assert.equal(result.status, "unknown");
  assert.equal(result.current_for_channel, null);
});

test("network failures remain unknown and redact credential-shaped error text", async () => {
  const result = await latestVersionCheck(
    {
      package_version: "0.3.1",
      source: { type: "package" },
      runtime: { integrity: "verified" },
    },
    {
      fetchImpl: async () => {
        throw new Error("proxy https://user:password@example.test/?token=do-not-print Bearer do-not-print");
      },
      timeoutMs: 100,
    },
  );
  assert.equal(result.status, "unknown");
  assert.equal(result.current_for_channel, null);
  assert.match(result.stable.error, /\[REDACTED\]/);
  assert.doesNotMatch(result.stable.error, /password|do-not-print/);
});

test("legacy installs without metadata report an unknown identity instead of guessing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-version-legacy-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const skillDir = path.join(root, "skills", "autonomous-engineering-graph");
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), "legacy\n", "utf8");
  const report = await graphVersionReport({
    skillDir,
    runnerSha256: "c".repeat(64),
    checkLatest: true,
    fetchImpl: async (url) => {
      assert.equal(url, NPM_LATEST_ENDPOINT);
      return jsonResponse({ version: "0.3.2" });
    },
    timeoutMs: 100,
  });
  assert.equal(report.status, "unknown");
  assert.equal(report.installed.package_version, null);
  assert.equal(report.installed.install_metadata, "legacy-missing");
  assert.equal(report.latest.stable.version, "0.3.2");
  assert.equal(report.latest.current_for_channel, null);
  assert.equal(report.update.method, "agent-managed-reinstall");
  assert.match(report.update.instruction, /do not assume NPM latest is newer/i);
});
