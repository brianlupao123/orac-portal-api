import assert from "node:assert/strict";
import test from "node:test";
import { invoiceReadinessBlock, invoiceReadinessSummary } from "../src/invoiceReadiness.js";
import { computeInvoiceReadyReport } from "../src/reports.js";
import { getPastelReviewInvoiceReady } from "../src/controllers/operationalDataController.js";

function makeBaseDb() {
  return {
    users: [
      { id: "u_admin", role: "Admin", is_active: true },
      { id: "u_finance", role: "Finance", is_active: true }
    ],
    clients: [
      { id: "c_1", name: "Zimplats Mining", is_active: true }
    ],
    quotes: [
      {
        id: "q_1",
        quote_number: "Q-2026-001",
        client_id: "c_1",
        status: "Field_Dispatch",
        total_amount: 5000,
        is_active: true
      }
    ],
    purchase_orders: [
      {
        id: "po_1",
        quotation_id: "q_1",
        po_reference: "PO-ZIM-9911",
        po_amount: 5000,
        status: "verified",
        requires_amendment: false
      }
    ],
    dispatch_cards: [
      {
        id: "d_1",
        quotation_id: "q_1",
        purchase_order_id: "po_1",
        dispatch_number: "DISP-2026-001",
        status: "active"
      }
    ],
    field_worksheets: [
      {
        id: "ws_1",
        dispatch_card_id: "d_1",
        technician_id: "u_tech_1",
        status: "Supervisor_Approved",
        hours: 10,
        hours_breakdown: { normal: 10, ot_15: 0, ot_20: 0 },
        superseded_by: null
      }
    ],
    daily_timesheets: [
      {
        id: "ts_1",
        dispatch_card_id: "d_1",
        user_id: "u_tech_1",
        source_worksheet_id: "ws_1",
        hours_logged: 10,
        hourly_rate: 50,
        supervisor_approved: true
      }
    ],
    material_usage: [],
    invoices: [],
    audit_logs: []
  };
}

function mockRes() {
  return {
    headers: {},
    sentData: null,
    statusCode: 200,
    header(name, val) { this.headers[name] = val; return this; },
    status(c) { this.statusCode = c; return this; },
    send(d) { this.sentData = d; return this; }
  };
}

test("Three-surface parity: ready dispatch is included across summary, report, and review export", () => {
  const db = makeBaseDb();
  const job = db.dispatch_cards[0];

  // 1. Surface 1: Gate & Summary
  const gate = invoiceReadinessBlock(db, job);
  assert.equal(gate, null, "Gate must allow ready dispatch");
  const summary = invoiceReadinessSummary(db, job);
  assert.equal(summary.readiness.ready_for_invoice_review, true);
  assert.equal(summary.readiness.blocker, null);

  // 2. Surface 2: Invoice Ready Report
  const report = computeInvoiceReadyReport(db);
  const reportItem = report.find((r) => r.id === job.id);
  assert.ok(reportItem, "Report must include ready dispatch");
  assert.equal(reportItem.dispatch_number, job.dispatch_number);

  // 3. Surface 3: Review Export
  const req = { db, user: { id: "u_finance" }, store: { audit() {} } };
  const res = mockRes();
  getPastelReviewInvoiceReady(req, res);
  assert.ok(res.sentData.includes("DISP-2026-001"), "Export must include ready dispatch number");
  assert.ok(res.sentData.includes("q_1"), "Export must include quotation id");
  assert.match(res.headers["Content-Disposition"], /attachment; filename=orac-review-invoice-ready-/);
});

test("Three-surface parity: dispatch blocked by missing verified PO is consistently excluded across all three surfaces", () => {
  const db = makeBaseDb();
  const job = db.dispatch_cards[0];
  // Break PO verification
  db.purchase_orders[0].status = "pending";

  // 1. Surface 1: Summary shows blocked with VERIFIED_PO_REQUIRED
  const gate = invoiceReadinessBlock(db, job);
  assert.ok(gate, "Gate must block unverified PO");
  assert.equal(gate.code, "VERIFIED_PO_REQUIRED");
  const summary = invoiceReadinessSummary(db, job);
  assert.equal(summary.readiness.ready_for_invoice_review, false);
  assert.equal(summary.readiness.blocker.code, "VERIFIED_PO_REQUIRED");

  // 2. Surface 2: Report excludes the dispatch
  const report = computeInvoiceReadyReport(db);
  assert.equal(report.some((r) => r.id === job.id), false, "Report must exclude dispatch when PO unverified");

  // 3. Surface 3: Review Export excludes the dispatch
  const req = { db, user: { id: "u_finance" }, store: { audit() {} } };
  const res = mockRes();
  getPastelReviewInvoiceReady(req, res);
  assert.equal(res.sentData.includes("DISP-2026-001"), false, "Export must not contain blocked dispatch");
});

test("Three-surface parity: dispatch with existing invoice history is excluded from report and flagged in summary", () => {
  const db = makeBaseDb();
  // Ensure PO headroom is ample so PO overrun is not the blocker
  db.purchase_orders[0].po_amount = 20000;
  const job = db.dispatch_cards[0];
  // Add invoice history for this dispatch
  db.invoices.push({
    id: "inv_01",
    dispatch_card_id: job.id,
    purchase_order_id: "po_1",
    total_amount: 500,
    status: "issued"
  });

  // 1. Surface 1: Summary identifies invoice history present
  const summary = invoiceReadinessSummary(db, job);
  assert.equal(summary.readiness.ready_for_invoice_review, false);
  assert.equal(summary.readiness.blocker.code, "DISPATCH_INVOICE_HISTORY_PRESENT");

  // 2. Surface 2: Report excludes dispatch
  const report = computeInvoiceReadyReport(db);
  assert.equal(report.some((r) => r.id === job.id), false, "Report must exclude already invoiced dispatch");

  // 3. Surface 3: Review Export excludes dispatch
  const req = { db, user: { id: "u_finance" }, store: { audit() {} } };
  const res = mockRes();
  getPastelReviewInvoiceReady(req, res);
  assert.equal(res.sentData.includes("DISP-2026-001"), false, "Export must not contain already invoiced dispatch");
});

test("Three-surface parity: export filename and headers carry review designation without corrupting CSV structure", () => {
  const db = makeBaseDb();
  let audited = null;
  const req = {
    db,
    user: { id: "u_finance" },
    store: {
      audit(db0, actor, entityType, entityId, action, before, after) {
        audited = { entityType, action, after };
      }
    }
  };
  const res = mockRes();
  getPastelReviewInvoiceReady(req, res);

  // Filename carries review designation
  assert.match(res.headers["Content-Disposition"], /^attachment; filename=orac-review-invoice-ready-\d{4}-\d{2}-\d{2}\.csv$/);

  // Audit carries non-posting designation
  assert.ok(audited);
  assert.equal(audited.after.designation, "REVIEW_NON_POSTING");
  assert.equal(audited.after.accounting_posted, false);

  // CSV content is clean standard 2-column CSV with zero corrupted header tokens
  const lines = res.sentData.trim().split("\n");
  assert.equal(lines[0], "dispatch_number,quotation_id");
  assert.equal(lines[1], "DISP-2026-001,q_1");
  assert.equal(lines.length, 2);
});
