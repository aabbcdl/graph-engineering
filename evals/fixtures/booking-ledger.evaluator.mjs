import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

const DEFINITIONS = [
  { id: "tenant-isolation", pattern: /tenant|cross[- ]tenant|data (?:leak|isolation)/i },
  { id: "list-input-mutation", pattern: /mutat|in[- ]place sort|caller(?:'s)? array/i },
  { id: "token-history-loss", pattern: /token.{0,40}(?:history|delet|preserv|rotat)|history.{0,40}token/i },
  { id: "expiry-boundary", pattern: /expir|boundary|now\s*>=/i },
  { id: "csv-formula-injection", pattern: /csv|spreadsheet|formula injection/i },
  { id: "refunded-revenue", pattern: /refund|net revenue/i },
];

async function loadModule(workspace, relative) {
  const target = path.join(workspace, ...relative.split("/"));
  return import(`${pathToFileURL(target).href}?evaluation=${Date.now()}-${Math.random()}`);
}

async function observedDefects(workspace) {
  const [appointments, tokens, csv, revenue] = await Promise.all([
    loadModule(workspace, "src/appointments.mjs"),
    loadModule(workspace, "src/checkin-tokens.mjs"),
    loadModule(workspace, "src/csv.mjs"),
    loadModule(workspace, "src/revenue.mjs"),
  ]);
  const checks = [];
  const check = async (id, action) => {
    try {
      await action();
      checks.push({ id, repaired: true, detail: "hidden acceptance passed" });
    } catch (error) {
      checks.push({ id, repaired: false, detail: String(error.message || error) });
    }
  };

  await check("tenant-isolation", () => {
    const rows = [
      { id: "other", tenantId: "tenant-b", startsAt: "2026-08-14T08:00:00Z", deletedAt: null },
      { id: "mine", tenantId: "tenant-a", startsAt: "2026-08-14T09:00:00Z", deletedAt: null },
      { id: "deleted", tenantId: "tenant-a", startsAt: "2026-08-14T07:00:00Z", deletedAt: "2026-08-13T00:00:00Z" },
    ];
    assert.deepEqual(appointments.listAppointments(rows, "tenant-a").map((row) => row.id), ["mine"]);
  });

  await check("list-input-mutation", () => {
    const rows = [
      { id: "later", tenantId: "tenant-a", startsAt: "2026-08-14T10:00:00Z", deletedAt: null },
      { id: "earlier", tenantId: "tenant-a", startsAt: "2026-08-14T09:00:00Z", deletedAt: null },
    ];
    const before = rows.map((row) => row.id);
    const output = appointments.listAppointments(rows, "tenant-a");
    assert.deepEqual(rows.map((row) => row.id), before);
    assert.deepEqual(output.map((row) => row.id), ["earlier", "later"]);
  });

  await check("token-history-loss", () => {
    const history = [
      { id: "old-active", appointmentId: "appointment-a", active: true, createdAt: "2026-08-14T08:00:00Z", expiresAt: "2026-08-14T09:00:00Z", usedAt: null },
      { id: "old-used", appointmentId: "appointment-a", active: false, createdAt: "2026-08-13T08:00:00Z", expiresAt: "2026-08-13T09:00:00Z", usedAt: "2026-08-13T08:30:00Z" },
      { id: "other", appointmentId: "appointment-b", active: true, createdAt: "2026-08-14T08:00:00Z", expiresAt: "2026-08-14T10:00:00Z", usedAt: null },
    ];
    const rotated = tokens.rotateCheckinToken(
      history,
      "appointment-a",
      "new-token",
      "2026-08-14T11:00:00Z",
      "2026-08-14T09:00:00Z",
    );
    assert.equal(rotated.length, 4);
    assert.equal(rotated.find((row) => row.id === "old-active").active, false);
    assert.equal(rotated.find((row) => row.id === "old-used").usedAt, "2026-08-13T08:30:00Z");
    assert.equal(rotated.find((row) => row.id === "other").active, true);
    assert.equal(history[0].active, true);
  });

  await check("expiry-boundary", () => {
    const rows = [{ id: "token", appointmentId: "a", active: true, createdAt: "2026-08-14T08:00:00Z", expiresAt: "2026-08-14T09:00:00Z", usedAt: null }];
    assert.throws(
      () => tokens.redeemCheckinToken(rows, "token", "2026-08-14T09:00:00Z"),
      (error) => error?.code === "TOKEN_EXPIRED",
    );
    assert.equal(rows[0].active, true);
  });

  await check("csv-formula-injection", () => {
    const output = csv.exportAppointments([
      { id: "=1+1", customer: "  @SUM(A1:A2)", status: "+booked" },
    ]);
    const dataLine = output.trimEnd().split("\n")[1];
    assert.match(dataLine, /^'=1\+1,'  @SUM\(A1:A2\),'\+booked$/);
  });

  await check("refunded-revenue", () => {
    assert.deepEqual(
      revenue.summarizeRevenue([
        { id: "kept", status: "paid", amountCents: 1500, refundedAt: null },
        { id: "refunded", status: "paid", amountCents: 900, refundedAt: "2026-08-14T10:00:00Z" },
        { id: "pending", status: "pending", amountCents: 700, refundedAt: null },
      ]),
      { paidOrders: 1, netCents: 1500 },
    );
  });

  return checks;
}

function findingText(finding) {
  return [
    finding?.title,
    finding?.summary,
    finding?.evidence,
    ...(Array.isArray(finding?.files) ? finding.files : []),
  ].filter(Boolean).join("\n");
}

function gradeFindings(rawFindings, defects) {
  const unmatched = new Set((rawFindings || []).map((_, index) => index));
  const findings = [];
  for (const definition of DEFINITIONS) {
    const matching = [];
    (rawFindings || []).forEach((finding, index) => {
      if (finding?.validated === true && definition.pattern.test(findingText(finding))) {
        matching.push(finding);
        unmatched.delete(index);
      }
    });
    const repaired = defects.find((defect) => defect.id === definition.id)?.repaired === true;
    if (matching.length || repaired) {
      findings.push({
        defect_id: definition.id,
        title: matching[0]?.title || definition.id,
        validated: true,
        fixed: repaired,
        repair_verified: repaired,
      });
    }
  }
  for (const index of unmatched) {
    const finding = rawFindings[index];
    if (finding?.validated !== true) continue;
    findings.push({
      defect_id: null,
      title: finding.title || "Unmapped validated finding",
      validated: true,
      fixed: finding.fixed === true,
      repair_verified: false,
    });
  }
  return findings;
}

async function evaluate(workspace, rawFindings = []) {
  const defects = await observedDefects(workspace);
  const npmExecPath = process.env.npm_execpath;
  const testCommand = npmExecPath ? process.execPath : process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npm";
  const testArguments = npmExecPath
    ? [npmExecPath, "test"]
    : process.platform === "win32"
      ? ["/d", "/s", "/c", "npm.cmd test"]
      : ["test"];
  const tests = spawnSync(testCommand, testArguments, {
    cwd: workspace,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    defects,
    findings: gradeFindings(rawFindings, defects),
    regression_checks: [
      {
        id: "public-tests",
        status: tests.status === 0 ? "pass" : "fail",
        detail: String(tests.status === 0 ? tests.stdout || "" : tests.stderr || tests.stdout || tests.error || "").trim().slice(-2000),
      },
    ],
  };
}

export { DEFINITIONS, evaluate, gradeFindings, observedDefects };
