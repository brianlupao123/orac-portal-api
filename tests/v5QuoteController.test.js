import assert from "node:assert/strict";
import test from "node:test";
import { createQuoteRevision, recordAmendedPoEvidence } from "../src/controllers/quoteController.js";
import { V5_MASTER_FLAG } from "../src/v5CommercialWorkflow.js";

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function store() {
  let counter = 0;
  return {
    id(prefix) { counter += 1; return `${prefix}-v5-${counter}`; },
    audit(db, actor, entityType, entityId, action) {
      db.audit_logs.push({ entityType, entityId, action, userId: actor.id });
    }
  };
}

function database() {
  return {
    company_profile: { v5_commercial_policy: { currency: "USD", tax_rate: null } },
    users: [
      { id: "sales-1", role: "Sales", is_active: true },
      { id: "admin-1", role: "Admin", is_active: true }
    ],
    quotes: [{
      id: "quote-1",
      quote_number: "Q-0001",
      client_id: "client-1",
      status: "Approved_Pending_PO",
      total_amount: 100
    }],
    quote_lines: [{ id: "ql-1", quotation_id: "quote-1", description: "Original labour", quantity: 1, unit_price: 100, line_total: 100 }],
    audit_logs: []
  };
}

function revisionBody() {
  return {
    reason: "Actual hours differ from the original scope.",
    lines: [{ description: "Revised labour", quantity: 8, unit_price: 12.5, pricing_basis: "hourly", planned_hours: 8 }],
    client_po_reference: "PO-REVISED-1",
    client_po_date: "2026-10-12"
  };
}

function withV5Enabled(callback) {
  const previous = process.env[V5_MASTER_FLAG];
  process.env[V5_MASTER_FLAG] = "enabled";
  try {
    callback();
  } finally {
    if (previous === undefined) delete process.env[V5_MASTER_FLAG];
    else process.env[V5_MASTER_FLAG] = previous;
  }
}

test("quote revisions stay dark until the V5 master flag is enabled", () => {
  const db = database();
  const res = response();
  createQuoteRevision({ user: { id: "sales-1" }, db, store: store(), params: { id: "quote-1" }, body: revisionBody() }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "V5_WORKFLOW_DISABLED");
  assert.equal(db.quotes.length, 1);
});

test("Sales creates an immutable revision with a root-based quotation number", () => withV5Enabled(() => {
  const db = database();
  const transactionStore = store();
  const first = response();
  createQuoteRevision({ user: { id: "sales-1" }, db, store: transactionStore, params: { id: "quote-1" }, body: revisionBody() }, first);
  assert.equal(first.statusCode, 201);
  assert.equal(first.body.data.quote_number, "Q-0001-R1");
  assert.equal(db.quotes[0].total_amount, 100, "the original commercial record is unchanged");
  assert.equal(db.quote_lines.find((line) => line.quotation_id === "quote-1").description, "Original labour");

  const second = response();
  createQuoteRevision({ user: { id: "sales-1" }, db, store: transactionStore, params: { id: first.body.data.id }, body: revisionBody() }, second);
  assert.equal(second.statusCode, 201);
  assert.equal(second.body.data.quote_number, "Q-0001-R2");
  assert.equal(second.body.data.root_quote_id, "quote-1");
}));

test("amended PO evidence applies only to a V5 revision and is auditable", () => withV5Enabled(() => {
  const db = database();
  const transactionStore = store();
  const createRes = response();
  createQuoteRevision({ user: { id: "sales-1" }, db, store: transactionStore, params: { id: "quote-1" }, body: revisionBody() }, createRes);

  const originalRes = response();
  recordAmendedPoEvidence({ user: { id: "sales-1" }, db, store: transactionStore, params: { id: "quote-1" }, body: {} }, originalRes);
  assert.equal(originalRes.statusCode, 409);

  const evidenceRes = response();
  recordAmendedPoEvidence({
    user: { id: "sales-1" },
    db,
    store: transactionStore,
    params: { id: createRes.body.data.id },
    body: { evidence_reference: "Signed amended PO scan", evidence_channel: "amended_po", accepted_on: "2026-10-12" }
  }, evidenceRes);
  assert.equal(evidenceRes.statusCode, 200);
  assert.equal(evidenceRes.body.data.amended_po_evidence.recorded_by, "sales-1");
  assert.ok(db.audit_logs.some((item) => item.action === "V5_AMENDED_PO_EVIDENCE_RECORDED"));
}));
