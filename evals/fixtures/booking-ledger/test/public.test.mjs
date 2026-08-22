import assert from "node:assert/strict";
import test from "node:test";

import { listAppointments } from "../src/appointments.mjs";
import { redeemCheckinToken, rotateCheckinToken } from "../src/checkin-tokens.mjs";
import { exportAppointments } from "../src/csv.mjs";
import { summarizeRevenue } from "../src/revenue.mjs";

test("lists active appointments in chronological order", () => {
  const records = [
    { id: "a", tenantId: "tenant-a", startsAt: "2026-08-14T09:00:00Z", deletedAt: null },
    { id: "b", tenantId: "tenant-a", startsAt: "2026-08-14T10:00:00Z", deletedAt: null },
  ];
  assert.deepEqual(listAppointments(records, "tenant-a").map((record) => record.id), ["a", "b"]);
});

test("rotates and redeems a new check-in token", () => {
  const rotated = rotateCheckinToken(
    [],
    "appointment-a",
    "token-new",
    "2026-08-14T10:00:00Z",
    "2026-08-14T09:00:00Z",
  );
  const redeemed = redeemCheckinToken(rotated, "token-new", "2026-08-14T09:30:00Z");
  assert.equal(redeemed[0].active, false);
  assert.equal(redeemed[0].usedAt, "2026-08-14T09:30:00Z");
});

test("quotes ordinary CSV delimiters", () => {
  const csv = exportAppointments([{ id: "a", customer: "Doe, Jane", status: "booked" }]);
  assert.match(csv, /"Doe, Jane"/);
});

test("summarizes paid orders in cents", () => {
  assert.deepEqual(
    summarizeRevenue([
      { id: "a", status: "paid", amountCents: 1250, refundedAt: null },
      { id: "b", status: "pending", amountCents: 900, refundedAt: null },
    ]),
    { paidOrders: 1, netCents: 1250 },
  );
});
