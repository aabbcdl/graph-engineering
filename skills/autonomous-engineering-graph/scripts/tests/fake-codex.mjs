#!/usr/bin/env node

import { mkdir, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

function schemaTypeMatches(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  return typeof value === type;
}

function assertSchemaFixture(value, definition, location = "$") {
  const types = Array.isArray(definition.type) ? definition.type : definition.type ? [definition.type] : [];
  if (types.length && !types.some((type) => schemaTypeMatches(value, type))) {
    throw new Error(`Fake Codex fixture at ${location} does not match schema type ${types.join("|")}`);
  }
  if (definition.enum && !definition.enum.some((candidate) => Object.is(candidate, value))) {
    throw new Error(`Fake Codex fixture at ${location} is not one of the schema enum values`);
  }
  if (value === null) return;
  if (Array.isArray(value)) {
    if (definition.minItems !== undefined && value.length < definition.minItems) {
      throw new Error(`Fake Codex fixture at ${location} has fewer than ${definition.minItems} items`);
    }
    if (definition.maxItems !== undefined && value.length > definition.maxItems) {
      throw new Error(`Fake Codex fixture at ${location} has more than ${definition.maxItems} items`);
    }
    if (definition.items) value.forEach((item, index) => assertSchemaFixture(item, definition.items, `${location}[${index}]`));
    return;
  }
  if (typeof value === "string") {
    if (definition.minLength !== undefined && value.length < definition.minLength) {
      throw new Error(`Fake Codex fixture at ${location} is shorter than ${definition.minLength}`);
    }
    if (definition.maxLength !== undefined && value.length > definition.maxLength) {
      throw new Error(`Fake Codex fixture at ${location} is longer than ${definition.maxLength}`);
    }
    if (definition.pattern && !new RegExp(definition.pattern).test(value)) {
      throw new Error(`Fake Codex fixture at ${location} does not match ${definition.pattern}`);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const key of definition.required || []) {
      if (!Object.hasOwn(value, key)) throw new Error(`Fake Codex fixture is missing ${location}.${key}`);
    }
    if (definition.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(definition.properties || {}, key)) {
          throw new Error(`Fake Codex fixture contains unsupported property ${location}.${key}`);
        }
      }
    }
    for (const [key, child] of Object.entries(definition.properties || {})) {
      if (Object.hasOwn(value, key)) assertSchemaFixture(value[key], child, `${location}.${key}`);
    }
  }
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const scenario = process.env.AEG_FAKE_SCENARIO || "happy";
if (scenario === "exit-before-input") {
  process.stdin.destroy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.stderr.write("fixture closed stdin before reading the prompt\n");
  process.exit(91);
}

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;

const schema = optionValue("--output-schema");
const output = optionValue("--output-last-message");
const workspace = optionValue("--cd") || process.cwd();
if (!schema || !output) throw new Error("Fake Codex requires schema and output paths");
if (process.argv.filter((argument) => argument === "--model").length > 1) {
  process.stderr.write("fixture received duplicate --model arguments\n");
  process.exit(92);
}
if (process.env.AEG_FAKE_REQUIRE_HARDENED_ARGS === "1") {
  const approvalIndex = process.argv.indexOf("--ask-for-approval");
  const execIndex = process.argv.indexOf("exec");
  const disableIndex = process.argv.indexOf("--disable");
  const hardened =
    approvalIndex >= 0 &&
    process.argv[approvalIndex + 1] === "never" &&
    execIndex >= 0 &&
    approvalIndex < execIndex &&
    process.argv.includes("--ignore-rules") &&
    disableIndex >= 0 &&
    process.argv[disableIndex + 1] === "skill_search";
  if (!hardened) {
    process.stderr.write(`fixture missing hardened Codex arguments: ${JSON.stringify(process.argv.slice(2))}\n`);
    process.exit(93);
  }
}

let overlapGuard = null;
const overlapGuardPath = process.env.AEG_FAKE_ACTIVE_GUARD;
if (overlapGuardPath) {
  try {
    overlapGuard = await open(overlapGuardPath, "wx", 0o600);
    await overlapGuard.writeFile(`${process.pid}\n`, "utf8");
    const holdMs = Number.parseInt(process.env.AEG_FAKE_HOLD_MS || "0", 10);
    if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
  } catch (error) {
    if (error.code === "EEXIST") {
      if (process.env.AEG_FAKE_EXPECT_OVERLAP === "1") {
        await writeFile(`${overlapGuardPath}.overlap`, `${process.pid}\n`, "utf8");
        const holdMs = Number.parseInt(process.env.AEG_FAKE_HOLD_MS || "0", 10);
        if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
      } else {
        process.stderr.write("fixture model overlap detected\n");
        process.exitCode = 97;
      }
    } else {
      throw error;
    }
  }
}

let result;
let nodeKind = "planner";
let nodeId = "planner";
let expectedFailure = false;
let nodeProcessFailure = false;
let nodeTransientFailure = false;
let unprovenCapabilityAttempt = false;
let scopedCheckId = null;
let scopedCheckCommand = null;
const plannerProcessFailure =
  path.basename(schema) === "planner-result.schema.json" &&
  (
    scenario === "planner-always-fails" ||
    (scenario === "planner-transient" && output.includes("attempt-1")) ||
    (scenario === "planner-transient-twice" && /attempt-[12]/.test(output)) ||
    (scenario === "planner-transient-three-checkpoint" && /attempt-[123]/.test(output))
  );
if (plannerProcessFailure) {
  if (scenario === "planner-transient-three-checkpoint") {
    process.stdout.write(
      `${JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "fake-check partial-planning",
          exit_code: 0,
          status: "completed",
          aggregated_output: "partial planning evidence retained",
        },
      })}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Observed the project rules before planning was interrupted." },
      })}\n`,
    );
  }
  process.stderr.write("fixture 502 Bad Gateway\n");
  process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "fake-planner-failure" })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "error", message: "502 Bad Gateway" })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "turn.failed", error: { message: "502 Bad Gateway" } })}\n`);
  process.exitCode = 1;
} else if (path.basename(schema) === "planner-result.schema.json") {
  const plannerHoldMs = Number.parseInt(process.env.AEG_FAKE_PLANNER_HOLD_MS || "0", 10);
  if (plannerHoldMs > 0) await new Promise((resolve) => setTimeout(resolve, plannerHoldMs));
  if (scenario === "planner-source-mutation") {
    await writeFile(path.join(workspace, "planner-mutation.txt"), "planner must remain read-only\n", "utf8");
  }
  result = {
    task_summary: "Exercise the complete autonomous graph",
    mode: "task",
    scope: ["fixture.txt"],
    risk_level: "low",
    completion_criteria: ["graph-output.txt exists", "verification and independent review pass"],
    required_checks: [
      {
        id: "fixture-verification",
        description: "Run the fixture verification",
         command: "fake-check verification",
         evidence_tool: null,
         source: "fixture project rules",
          equivalent_commands: [],
          environment_required: false,
          gap_policy: "fail",
          environment_kind: null,
        blocking_scope: "both",
      },
    ],
    discovery_skills: ["fixture-review"],
    review_nodes: [
      { id: "behavior", title: "Behavior review", focus: "Review expected behavior", skills: ["fixture-review"] },
      { id: "risk", title: "Risk review", focus: "Review regression risk", skills: ["fixture-review"] },
    ],
    review_waves: [],
    coverage: {
      required_domains: [],
      optional_domains: [],
      omitted_domains: [],
      verification_gaps: [],
    },
    implementation_skills: ["fixture-review"],
    verification_skills: ["fixture-review"],
    excluded_surfaces: [],
  };
  if (scenario === "supervision-correction" && /attempt-2/.test(output)) {
    result = {
      ...result,
      completion_criteria: [...result.completion_criteria, "planner supervision feedback is explicitly addressed"],
    };
  }
  if (scenario === "specialist-routing") {
    result = {
      ...result,
      task_summary: "Broad evidence-backed audit and automatic reversible repair",
      mode: "audit",
      scope: ["current workspace"],
      discovery_skills: ["graph-requirements-design"],
      review_nodes: [
        { id: "engineering", title: "Engineering quality", focus: "Review architecture and correctness", skills: ["graph-engineering-quality"] },
        { id: "product", title: "Product quality", focus: "Review product value and journeys", skills: ["graph-product-quality"] },
        { id: "experience", title: "Experience quality", focus: "Review UX and accessibility", skills: ["graph-experience-quality"] },
        { id: "security", title: "Security and privacy", focus: "Review trust boundaries and data flow", skills: ["graph-security-privacy"] },
      ],
      implementation_skills: ["graph-engineering-quality", "graph-product-quality", "graph-experience-quality"],
      verification_skills: ["graph-release-assurance"],
    };
  }
  if (scenario === "storepulse-plan") {
    result = {
      ...result,
      task_summary: "Comprehensively audit and reversibly repair a frozen StorePulse-like repository snapshot",
      mode: "audit",
      scope: [
        "Audit requirements, engineering, product, experience, authentication, payment, privacy, and production configuration without deploying or deleting data.",
        "Make only reversible repository-local repairs and preserve the dirty frozen baseline.",
      ],
      risk_level: "high",
      required_checks: [
        ...result.required_checks,
        {
          id: "miniprogram-rendered-probe",
          description: "Probe optional rendered mini-program tooling and otherwise report an exact coverage gap.",
          command: null,
          evidence_tool: "Host command events followed by screenshots or an access-gap artifact",
          source: "optional mini-program tooling",
          equivalent_commands: [],
          environment_required: true,
          gap_policy: "waiting_environment",
          environment_kind: "device",
          blocking_scope: "both",
        },
        {
          id: "independent-release-review",
          description: "Perform the Graph fresh-context independent final review.",
          command: null,
          evidence_tool: "Fresh-context graph-release-assurance review artifact in host events",
          source: "Graph lifecycle final-review requirement",
          equivalent_commands: [],
          environment_required: false,
          gap_policy: "fail",
          environment_kind: null,
          blocking_scope: "both",
        },
      ],
    };
  }
  if (["release-only-gap", "apply-only-gap"].includes(scenario)) {
    const scope = scenario === "apply-only-gap" ? "apply" : "release";
    const checkId = scenario === "apply-only-gap" ? "apply-environment" : "release-environment";
    result = {
      ...result,
      required_checks: [
        ...result.required_checks,
        {
          id: checkId,
          description: scope === "apply" ? "Verify the external apply environment" : "Verify the external release environment",
          command: `fake-check ${checkId}`,
          evidence_tool: null,
          source: "fixture release workflow",
          equivalent_commands: [],
          environment_required: true,
          gap_policy: "waiting_environment",
          environment_kind: "external_service",
          blocking_scope: scope,
        },
      ],
    };
  }
  if (scenario === "owner-gate") {
    // P2: the planner schema no longer carries owner_gate, so a legacy planner
    // owner-gate fixture now exercises only the downgrade path: the planner
    // result is non-blocking and the run continues. A true owner gate must be
    // derived from synthesis evidence (scenario synthesis-owner-gate).
    result = {
      ...result,
      task_summary: "Change authentication behavior in the fixture",
      risk_level: "high",
    };
  }
} else {
  const match = prompt.match(/You are node ([^ ]+) \(([^)]+)\)/);
  nodeId = match?.[1] || "unknown";
  nodeKind = match?.[2] || "review";
  nodeTransientFailure =
    (scenario === "node-transient-twice" && nodeId === "review-risk" && /attempt-[12]/.test(output)) ||
    (scenario === "node-transient-three-checkpoint" && nodeId === "discovery" && /attempt-[123]/.test(output));
  nodeProcessFailure =
    ((scenario === "node-always-fails" && nodeId === "review-risk") || nodeTransientFailure);
  unprovenCapabilityAttempt =
    scenario === "unproven-capability-blocker" && nodeKind === "implementation" && output.includes("attempt-1");
  if (nodeKind === "implementation" && !unprovenCapabilityAttempt) {
    await writeFile(path.join(workspace, "graph-output.txt"), "implemented by fake Codex\n", "utf8");
    if (scenario === "recovery") await writeFile(path.join(workspace, "fixture.txt"), "changed by fake Codex\n", "utf8");
    if (scenario === "result-link") {
      const target = path.join(workspace, "graph-link-target");
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "payload.txt"), "linked payload\n", "utf8");
      await symlink(target, path.join(workspace, "graph-link"), process.platform === "win32" ? "junction" : "dir");
    }
  }
  if (nodeKind === "correction") {
    await writeFile(path.join(workspace, "graph-output.txt"), "corrected by fake Codex\n", "utf8");
  }
  const skills = [...prompt.matchAll(/<required_skill name="([^"]+)" path="[^"]+" sha256="([a-f0-9]+)">([\s\S]*?)<\/required_skill>/g)].map(
    (match) => {
      const references = [...match[3].matchAll(/<required_reference path="([^"]+)"/g)].map((reference) => reference[1]);
      return {
        name: match[1],
        sha256: match[2],
        requirements_applied: references.length
          ? references.map((reference) => `Applied fixture requirement from ${reference}`)
          : ["fixture instruction supplied"],
      };
    },
  );
  const command = `fake-check ${nodeKind}`;
  scopedCheckId = scenario === "apply-only-gap"
    ? "apply-environment"
    : scenario === "release-only-gap"
      ? "release-environment"
      : null;
  scopedCheckCommand = scopedCheckId ? `fake-check ${scopedCheckId}` : null;
  expectedFailure = (scenario === "correction" && nodeId === "verification-r0") ||
    (scenario === "failed-command-pass" && nodeKind === "verification");
  const implementationFailure = scenario === "implementation-failure" && nodeKind === "implementation";
  const blockedGate = scenario === "blocked-gate-pass" && nodeKind === "verification";
  const recordedBlocker = scenario === "recorded-blocker" && nodeId === "review-behavior";
  const synthesisOwnerGate = ["synthesis-owner-gate", "deferred-synthesis-owner-gate"].includes(scenario) && nodeKind === "synthesis";
  const deferredSynthesisOwnerGate = scenario === "deferred-synthesis-owner-gate" && nodeKind === "synthesis";
  const missingSkillEvidence =
    (scenario === "missing-skill-evidence" && nodeKind === "review") ||
    (scenario === "missing-skill-evidence-once" && nodeId === "review-behavior" && output.includes("attempt-1"));
  const artifactOnlySupervision = nodeKind === "supervision";
  const supervisionRejection =
    (scenario === "supervision-correction" &&
      ["planner-supervision", "synthesis-supervision", "implementation-supervision"].includes(nodeId)) ||
    (scenario === "planner-no-progress" && nodeId === "planner-supervision") ||
    (scenario === "implementation-failure" && nodeId === "implementation-supervision");
  const nodeFailure = expectedFailure || implementationFailure;
  result = {
    status: recordedBlocker || synthesisOwnerGate || unprovenCapabilityAttempt ? "blocked" : (nodeFailure && scenario !== "failed-command-pass") || supervisionRejection ? "needs_retry" : "completed",
    gate: blockedGate || unprovenCapabilityAttempt ? "blocked" : (nodeFailure && scenario !== "failed-command-pass") || supervisionRejection ? "fail" : ["verification", "independent_review", "supervision"].includes(nodeKind) ? "pass" : "not_applicable",
    summary: `${nodeId} completed by the deterministic fixture`,
    skills_applied: missingSkillEvidence ? [] : skills,
    evidence: [{
      claim: `${nodeKind} executed`,
      source: artifactOnlySupervision ? "supplied stage artifact and controller contract" : command,
      kind: artifactOnlySupervision ? "document" : "tool",
      finding_ids: [],
    }],
    findings: nodeFailure || supervisionRejection
      ? [{
          id: "FIXTURE-FAIL",
          severity: "high",
          title: "Fixture requires correction",
          evidence: supervisionRejection ? `${nodeId} requested one correction` : "first verification failed",
          recommended_action: "run correction",
          fingerprint: "fixture-failure",
          related_finding_ids: [],
          evidence_anchors: [command],
          validation: "reproduced",
          disposition: "confirmed",
        }]
      : [],
    commands: artifactOnlySupervision || unprovenCapabilityAttempt
      ? []
      : [
          { command, exit_code: nodeFailure ? 1 : 0, summary: nodeFailure ? "fixture command failed" : "fixture command passed" },
          ...(scopedCheckCommand
            ? [{ command: scopedCheckCommand, exit_code: 1, summary: "external environment unavailable" }]
            : []),
        ],
    checks: nodeKind === "verification"
      ? [
          { id: "fixture-verification", status: expectedFailure ? "fail" : "pass", evidence: command, command, finding_ids: [] },
          ...(["release-only-gap", "apply-only-gap"].includes(scenario)
             ? [{
                 id: scopedCheckId,
                 status: "fail",
                 evidence: `${scenario === "apply-only-gap" ? "apply" : "release"} environment unavailable`,
                 command: scopedCheckCommand,
                 finding_ids: [],
               }]
            : []),
        ]
      : [],
    files_changed: ["implementation", "correction"].includes(nodeKind) && !unprovenCapabilityAttempt
      ? scenario === "result-link" && nodeKind === "implementation"
        ? ["graph-output.txt", "graph-link-target/payload.txt", "graph-link"]
        : ["graph-output.txt"]
      : [],
    blockers: unprovenCapabilityAttempt
      ? [
          { type: "SCOPE", reason: "The current implementation file system is read-only.", unblock_condition: "Retry in a workspace-write implementation node." },
          { type: "TOOLING", reason: "The upstream pnpm checks were blocked.", unblock_condition: "Run pnpm in an allowed environment." },
        ]
      : recordedBlocker
      ? [{ type: "EVIDENCE_GAP", reason: "Fixture review could not inspect one optional artifact.", unblock_condition: "Continue with independent evidence or inspect the artifact in a later gate." }]
      : synthesisOwnerGate
        ? [{
            type: "AUTHORIZATION",
            reason: "The synthesized fixture change needs explicit owner approval.",
            unblock_condition: "Approve only the synthesized fixture scope.",
            ...(deferredSynthesisOwnerGate
              ? {
                  required_for_current_goal: false,
                  protected_action: "Deploy the optional production TLS configuration.",
                }
              : {
                  required_for_current_goal: true,
                  protected_action: "Perform the synthesized fixture change.",
                }),
          }]
        : [],
    next_actions: [],
  };
  if (scenario === "finding-lineage") {
    const observations = {
      "review-behavior": {
        id: "FIXTURE-BEHAVIOR",
        disposition: "discovered",
        validation: "reproduced",
      },
      "review-risk": {
        id: "FIXTURE-RISK",
        disposition: "confirmed",
        validation: "reproduced",
      },
      synthesis: {
        id: "FIXTURE-PLAN",
        disposition: "planned",
        validation: "reproduced",
      },
      implementation: {
        id: "FIXTURE-IMPLEMENTED",
        disposition: "implemented",
        validation: "reproduced",
      },
      "verification-r0": {
        id: "FIXTURE-VERIFIED",
        disposition: "fixed",
        validation: "test_confirmed",
      },
      "independent-review-r0": {
        id: "FIXTURE-REVIEWED",
        disposition: "fixed",
        validation: "test_confirmed",
      },
    };
    const observation = observations[nodeId];
    if (observation) {
      result.findings = [{
        ...observation,
        severity: "high",
        title: "Fixture output is missing",
        evidence: "fixture.txt requires graph-output.txt to be generated and verified",
        recommended_action: "Generate graph-output.txt and verify it with the fixture command",
        fingerprint: "fixture-shared-defect",
        related_finding_ids: nodeId === "review-behavior" ? [] : ["FIXTURE-BEHAVIOR"],
        evidence_anchors: ["fixture.txt", "graph-output.txt"],
      }];
      result.evidence = [{
        claim: `${nodeKind} observed the shared fixture defect`,
        source: command,
        kind: nodeKind === "verification" ? "test" : "tool",
        finding_ids: [observation.id],
      }];
      if (nodeKind === "verification") {
        result.checks = [{
          id: "fixture-verification",
          status: "pass",
          evidence: command,
          command,
          finding_ids: [observation.id],
        }];
      }
    }
  }
  result.blockers = (result.blockers || []).map((blocker) => ({
    required_for_current_goal: null,
    protected_action: null,
    ...blocker,
  }));
}

if (nodeProcessFailure) {
  if (scenario === "node-transient-three-checkpoint") {
    process.stdout.write(
      `${JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "fake-check partial-discovery",
          exit_code: 0,
          status: "completed",
          aggregated_output: "partial repository evidence retained",
        },
      })}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Observed the fixture scope before the service interruption." },
      })}\n`,
    );
  }
  process.stderr.write(nodeTransientFailure ? "fixture 503 Service Unavailable\n" : "fixture node process failure\n");
  process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: `fake-${nodeId}-failure` })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "error", message: "fixture node process failure" })}\n`);
  process.exitCode = 1;
} else if (!plannerProcessFailure) {
  assertSchemaFixture(result, JSON.parse(await readFile(schema, "utf8")));
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: `fake-${nodeId}` })}\n`);
  if (nodeKind !== "supervision") {
    const commandEvents = [
      {
        command: `fake-check ${nodeKind}`,
        exit_code: expectedFailure ? 1 : 0,
        status: expectedFailure ? "failed" : "completed",
        aggregated_output: expectedFailure ? "fixture command failed" : "fixture command passed",
      },
      ...(scopedCheckCommand
        ? [{
            command: scopedCheckCommand,
            exit_code: 1,
            status: "failed",
            aggregated_output: "external environment unavailable",
          }]
        : []),
    ];
    for (const commandEvent of commandEvents) {
      process.stdout.write(
        `${JSON.stringify({ type: "item.completed", item: { type: "command_execution", ...commandEvent } })}\n`,
      );
    }
  }
  if (["implementation", "correction"].includes(nodeKind) && !unprovenCapabilityAttempt) {
    process.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "file_change", status: "completed" } })}\n`);
  }
  process.stdout.write(
    `${JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 120, cached_input_tokens: 40, output_tokens: 30 },
    })}\n`,
  );
}

if (overlapGuard) {
  await overlapGuard.close().catch(() => {});
  await rm(overlapGuardPath, { force: true }).catch(() => {});
}
