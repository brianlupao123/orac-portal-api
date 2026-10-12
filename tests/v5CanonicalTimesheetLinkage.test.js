import assert from "node:assert/strict";
import test from "node:test";
import { createWorksheet } from "../src/controllers/dispatchController.js";
import { canonicalHoursByQuoteLine, V5_MASTER_FLAG } from "../src/v5CommercialWorkflow.js";

function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

function baseDb() {
  return {
    users: [{ id: "tech-1", role: "Technician", name: "Technician", trade: "Boilermaker", is_active: true }],
    dispatch_cards: [{ id: "job-1", quotation_id: "quote-v5", assigned_technician_id: "tech-1" }],
    quotes: [{ id: "quote-v5", v5_commercial_workflow: true }],
    quote_lines: [{ id: "line-labour", quotation_id: "quote-v5", pricing_basis: "hourly", unit_price: 10 }],
    field_worksheets: [],
    audit_logs: []
  };
}

function request(db, body) {
  let counter = 0;
  return {
    user: { id: "tech-1" },
    params: { id: "job-1" },
    db,
    body: {
      activity: "Repair work completed",
      work_date: "2026-10-12",
      hours_breakdown: { normal: 8, ot_15: 0, ot_20: 0 },
      signatures: { employee: { name: "Technician", date: "2026-10-12", method: "on_device", attest: true } },
      ...body
    },
    store: { id(prefix) { counter += 1; return `${prefix}-${counter}`; }, audit() {} }
  };
}

function withV5Enabled(callback) {
  const prior = process.env[V5_MASTER_FLAG];
  process.env[V5_MASTER_FLAG] = "enabled";
  try { callback(); } finally { if (prior === undefined) delete process.env[V5_MASTER_FLAG]; else process.env[V5_MASTER_FLAG] = prior; }
}

test("a V5 Timesheet requires a quotation line on its own dispatch quotation", () => withV5Enabled(() => {
  const db = baseDb();
  const missing = response();
  createWorksheet(request(db, {}), missing);
  assert.equal(missing.statusCode, 400);
  assert.match(missing.body.message, /quotation labour line/);

  const foreign = response();
  createWorksheet(request(db, { quote_line_id: "line-foreign" }), foreign);
  assert.equal(foreign.statusCode, 400);

  const created = response();
  createWorksheet(request(db, { quote_line_id: "line-labour" }), created);
  assert.equal(created.statusCode, 200);
  assert.equal(created.body.data.quote_line_id, "line-labour");
}));

test("canonical aggregation is rate-free and reports eligible legacy records that are unmapped", () => {
  const db = {
    field_worksheets: [
      { id: "ws-1", dispatch_card_id: "job-1", status: "Supervisor_Approved", hours: 8, quote_line_id: "line-a" },
      { id: "ws-2", dispatch_card_id: "job-1", status: "Supervisor_Approved", hours: 2, quote_line_id: null },
      { id: "ws-3", dispatch_card_id: "job-1", status: "Draft", hours: 5, quote_line_id: "line-a" }
    ]
  };
  const result = canonicalHoursByQuoteLine(db, "job-1");
  assert.deepEqual(result.by_quote_line, { "line-a": { hours: 8, source_ids: ["ws-1"] } });
  assert.deepEqual(result.unmapped, { hours: 2, source_ids: ["ws-2"] });
});
