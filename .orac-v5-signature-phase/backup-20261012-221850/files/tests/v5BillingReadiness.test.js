import assert from "node:assert/strict";
import test from "node:test";
import { getV5BillingReadiness } from "../src/controllers/timesheetWorkflowController.js";
import { V5_MASTER_FLAG } from "../src/v5CommercialWorkflow.js";

function response() { return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }

function database() {
  return {
    users: [{ id: "sales-1", role: "Sales", is_active: true }],
    dispatch_cards: [{ id: "job-1", quotation_id: "quote-1" }],
    quotes: [{ id: "quote-1", quote_number: "Q-0001-R1", v5_commercial_workflow: true }],
    quote_lines: [{ id: "line-1", quotation_id: "quote-1", description: "Labour", pricing_basis: "hourly", unit_price: 25 }],
    field_worksheets: [
      { id: "ws-linked", dispatch_card_id: "job-1", status: "Supervisor_Approved", hours: 8, quote_line_id: "line-1" },
      { id: "ws-unmapped", dispatch_card_id: "job-1", status: "Supervisor_Approved", hours: 2 }
    ]
  };
}

function call(db) {
  const res = response();
  getV5BillingReadiness({ user: { id: "sales-1" }, params: { id: "job-1" }, db }, res);
  return res;
}

function withV5(callback) {
  const prior = process.env[V5_MASTER_FLAG];
  process.env[V5_MASTER_FLAG] = "enabled";
  try { callback(); } finally { if (prior === undefined) delete process.env[V5_MASTER_FLAG]; else process.env[V5_MASTER_FLAG] = prior; }
}

test("V5 billing readiness is dark by default", () => {
  const res = call(database());
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "FEATURE_DISABLED");
});

test("billing readiness is rate-free and blocks an unmapped verified Timesheet", () => withV5(() => {
  const res = call(database());
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.ready_for_pricing_review, false);
  assert.equal(res.body.data.lines[0].canonical_hours, 8);
  assert.deepEqual(res.body.data.unmapped, { hours: 2, source_ids: ["ws-unmapped"] });
  assert.equal(JSON.stringify(res.body.data).includes("unit_price"), false);
  assert.equal(JSON.stringify(res.body.data).includes("hourly_rate"), false);
}));

test("billing readiness becomes review-ready when every verified Timesheet is linked", () => withV5(() => {
  const db = database();
  db.field_worksheets[1].quote_line_id = "line-1";
  const res = call(db);
  assert.equal(res.body.data.ready_for_pricing_review, true);
  assert.equal(res.body.data.lines[0].canonical_hours, 10);
}));
