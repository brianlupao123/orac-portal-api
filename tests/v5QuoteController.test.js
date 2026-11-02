import assert from "node:assert/strict";
import test from "node:test";
import { approveV5Amendment, capturePo, createQuoteRevision, recordAmendedPoEvidence, updateQuote } from "../src/controllers/quoteController.js";
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
    purchase_orders: [],
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
  assert.equal(first.body.data.currency, "USD");
  assert.equal(first.body.data.tax_status, "unconfigured");
  assert.equal(first.body.data.pre_tax_total_cents, 10000);
  assert.equal(first.body.data.tax_total_cents, 0);
  assert.equal(first.body.data.grand_total_cents, 10000);
  assert.equal(first.body.data.commercial_acceptance_status, "pending");
  assert.equal(db.quotes[0].total_amount, 100, "the original commercial record is unchanged");
  assert.equal(db.quote_lines.find((line) => line.quotation_id === "quote-1").description, "Original labour");

  const second = response();
  createQuoteRevision({ user: { id: "sales-1" }, db, store: transactionStore, params: { id: first.body.data.id }, body: revisionBody() }, second);
  assert.equal(second.statusCode, 201);
  assert.equal(second.body.data.quote_number, "Q-0001-R2");
  assert.equal(second.body.data.root_quote_id, "quote-1");
}));

test("V5 quote revisions refuse tax calculations until tax policy is configured", () => withV5Enabled(() => {
  const db = database();
  const res = response();
  createQuoteRevision({
    user: { id: "sales-1" }, db, store: store(), params: { id: "quote-1" },
    body: { ...revisionBody(), tax_rate: 15 }
  }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "V5_TAX_UNCONFIGURED");
  assert.equal(db.quotes.length, 1);
}));

test("a V5 revision is immutable and gains commercial acceptance only from a verified PO", () => withV5Enabled(() => {
  const db = database();
  const transactionStore = store();
  const revisionRes = response();
  createQuoteRevision({ user: { id: "sales-1" }, db, store: transactionStore, params: { id: "quote-1" }, body: revisionBody() }, revisionRes);
  const revision = revisionRes.body.data;

  const editRes = response();
  updateQuote({
    user: { id: "sales-1" }, db, store: transactionStore, params: { id: revision.id },
    body: { description: "Changed outside a revision", lines: [{ description: "Changed", quantity: 1, unit_price: 1 }] }
  }, editRes);
  assert.equal(editRes.statusCode, 409);
  assert.equal(editRes.body.code, "V5_QUOTE_REVISION_IMMUTABLE");
  assert.equal(db.quote_lines.find((line) => line.quotation_id === revision.id).description, "Revised labour");

  const poRes = response();
  capturePo({
    user: { id: "admin-1" }, db, store: transactionStore, params: { id: revision.id },
    body: { po_reference: "PO-V5-ACCEPTED", po_amount: 100, date_received: "2026-10-20" }
  }, poRes);
  assert.equal(poRes.statusCode, 200);
  assert.equal(revision.commercial_acceptance_status, "po_verified");
  assert.equal(revision.commercial_acceptance_po_id, poRes.body.data.id);
  assert.equal(revision.commercial_acceptance_reference, "PO-V5-ACCEPTED");
  assert.ok(revision.commercial_accepted_at);
  assert.ok(db.audit_logs.some((entry) => entry.action === "V5_QUOTE_PO_VERIFIED"));
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

test("a V5 amendment needs immutable client evidence, a verified PO, and an independent Admin or Finance approver", () => withV5Enabled(() => {
  const db = database();
  db.users.push({ id: "fin-1", role: "Finance", is_active: true });
  const transactionStore = store();
  const created = response();
  createQuoteRevision({ user: { id: "sales-1" }, db, store: transactionStore, params: { id: "quote-1" }, body: revisionBody() }, created);
  const revision = created.body.data;

  const missingEvidence = response();
  approveV5Amendment({ user: { id: "admin-1" }, db, store: transactionStore, params: { id: revision.id }, body: {} }, missingEvidence);
  assert.equal(missingEvidence.statusCode, 409);
  assert.equal(missingEvidence.body.code, "V5_AMENDED_PO_EVIDENCE_REQUIRED");

  const evidence = response();
  recordAmendedPoEvidence({
    user: { id: "sales-1" }, db, store: transactionStore, params: { id: revision.id },
    body: { evidence_reference: "AMENDED-PO-100", evidence_channel: "amended_po", accepted_on: "2026-10-20" }
  }, evidence);
  assert.equal(evidence.statusCode, 200);
  const duplicate = response();
  recordAmendedPoEvidence({ user: { id: "sales-1" }, db, store: transactionStore, params: { id: revision.id }, body: evidence.body.data.amended_po_evidence }, duplicate);
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.body.code, "V5_AMENDMENT_EVIDENCE_IMMUTABLE");

  const missingPo = response();
  approveV5Amendment({ user: { id: "admin-1" }, db, store: transactionStore, params: { id: revision.id }, body: {} }, missingPo);
  assert.equal(missingPo.statusCode, 409);
  assert.equal(missingPo.body.code, "V5_AMENDED_PO_VERIFICATION_REQUIRED");

  const po = response();
  capturePo({
    user: { id: "fin-1" }, db, store: transactionStore, params: { id: revision.id },
    body: { po_reference: "AMENDED-PO-100", po_amount: 100, date_received: "2026-10-20" }
  }, po);
  assert.equal(po.statusCode, 200);

  assert.throws(
    () => approveV5Amendment({ user: { id: "sales-1" }, db, store: transactionStore, params: { id: revision.id }, body: {} }, response()),
    /cannot perform approveV5Amendment/
  );

  const approved = response();
  approveV5Amendment({ user: { id: "admin-1" }, db, store: transactionStore, params: { id: revision.id }, body: { approval_note: "Reviewed at monthly reconciliation." } }, approved);
  assert.equal(approved.statusCode, 200);
  assert.equal(revision.v5_amendment_approval.approved_by, "admin-1");
  assert.equal(revision.v5_amendment_approval.approved_po_id, po.body.data.id);
  assert.ok(db.audit_logs.some((item) => item.action === "V5_AMENDMENT_APPROVED"));

  const repeat = response();
  approveV5Amendment({ user: { id: "fin-1" }, db, store: transactionStore, params: { id: revision.id }, body: {} }, repeat);
  assert.equal(repeat.statusCode, 409);
  assert.equal(repeat.body.code, "V5_AMENDMENT_ALREADY_APPROVED");
}));

test("the V5 amendment approver cannot be the revision preparer, evidence recorder, or PO verifier", () => withV5Enabled(() => {
  const db = database();
  db.users.push({ id: "fin-1", role: "Finance", is_active: true });
  const transactionStore = store();
  const created = response();
  createQuoteRevision({ user: { id: "sales-1" }, db, store: transactionStore, params: { id: "quote-1" }, body: revisionBody() }, created);
  const revision = created.body.data;
  recordAmendedPoEvidence({ user: { id: "sales-1" }, db, store: transactionStore, params: { id: revision.id }, body: { evidence_reference: "AMENDED-PO-101", evidence_channel: "amended_po", accepted_on: "2026-10-20" } }, response());
  capturePo({ user: { id: "fin-1" }, db, store: transactionStore, params: { id: revision.id }, body: { po_reference: "AMENDED-PO-101", po_amount: 100, date_received: "2026-10-20" } }, response());
  const refused = response();
  approveV5Amendment({ user: { id: "fin-1" }, db, store: transactionStore, params: { id: revision.id }, body: {} }, refused);
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.body.code, "V5_AMENDMENT_SEPARATION_OF_DUTIES");
}));
