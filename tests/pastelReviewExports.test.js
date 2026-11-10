import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { exportInvoicesCsv } from "../src/exporter.js";
import { formatBusinessDate, getBusinessTimezone, hashCsv } from "../src/businessTimezone.js";
import { exportPastel } from "../src/controllers/coreController.js";
import { getPastelReviewQuotes, getPastelReviewInvoiceReady } from "../src/controllers/operationalDataController.js";
import { exportTechnicianPayrollPastel } from "../src/controllers/reportsController.js";
import { computeTechnicianPayroll, buildPastelPayrollCsv } from "../src/payroll.js";

function mockRes() {
  const headers = {};
  return {
    statusCode: 200,
    headers,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    header(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    send(body) { this.body = body; return this; }
  };
}

function makeTestDb() {
  return {
    users: [
      { id: "u_admin", role: "Admin", is_active: true },
      { id: "u_fin", role: "Finance", is_active: true },
      { id: "u_ops", role: "Operations", is_active: true },
      { id: "t1", full_name: "Tendai Moyo", employee_code: "E001", national_id: "63-123456", is_active: true },
      { id: "t2", full_name: "Blessing Phiri", employee_code: null, national_id: "08-765432", is_active: true }
    ],
    clients: [{ id: "c1", name: "Apex Minerals Fictional" }],
    quotes: [
      { id: "q1", quote_number: "Q-101", client_id: "c1", status: "Approved", total_amount: 500 }
    ],
    purchase_orders: [
      { id: "po1", quotation_id: "q1", po_reference: "PO-APEX-2026", po_amount: 500 }
    ],
    dispatch_cards: [
      { id: "d1", quotation_id: "q1", equipment_tag_id: "eq1" }
    ],
    equipment_tags: [
      { id: "eq1", tag_code: "PUMP-01" }
    ],
    timesheets: [
      { id: "ts1", dispatch_card_id: "d1", user_id: "t1", hours_logged: 8, source_worksheet_id: "w1" }
    ],
    material_usage: [
      { id: "mu1", dispatch_card_id: "d1", total_cost: 100 }
    ],
    invoices: [
      {
        id: "inv1",
        invoice_number: "INV-2026-001",
        purchase_order_id: "po1",
        dispatch_card_id: "d1",
        status: "issued",
        total_amount: 500,
        generated_at: "2026-10-15T08:00:00.000Z"
      },
      {
        id: "inv_void",
        invoice_number: "INV-2026-VOID",
        purchase_order_id: "po1",
        dispatch_card_id: "d1",
        status: "voided",
        total_amount: 250,
        generated_at: "2026-10-10T08:00:00.000Z"
      }
    ],
    invoice_lines: [
      {
        id: "il1",
        invoice_id: "inv1",
        description: "Field service labour",
        quantity: 8,
        unit_price: 50,
        line_total: 400,
        gl_account_code: "SALES-SERVICE",
        cost_center: "FIELD"
      },
      {
        id: "il2",
        invoice_id: "inv1",
        description: "Materials used",
        quantity: 1,
        unit_price: 100,
        line_total: 100,
        gl_account_code: "SALES-MATERIALS",
        cost_center: "FIELD"
      },
      {
        id: "il_v1",
        invoice_id: "inv_void",
        description: "Voided line",
        quantity: 5,
        unit_price: 50,
        line_total: 250,
        gl_account_code: "SALES-SERVICE",
        cost_center: "FIELD"
      }
    ],
    invoice_credit_notes: [
      {
        id: "cn1",
        invoice_id: "inv1",
        amount: 50,
        reason: "Rate adjustment",
        status: "issued",
        issued_at: "2026-10-20T10:00:00.000Z"
      }
    ],
    worksheet_registers: [
      {
        id: "wr1",
        reference: "WS-REG-OCT",
        status: "Approved",
        period: { start: "2026-10-01", end: "2026-10-31" },
        roster: [{ key: "t_t1", technician_id: "t1", display_name: "Tendai Moyo" }],
        lines: [
          { roster_key: "t_t1", date: "2026-10-05", normal: 8, ot_15: 0, ot_20: 0, sign_off_employee: "Tendai", sign_off_supervisor: "Sup" }
        ]
      }
    ],
    audit_logs: []
  };
}

// 1. Two-line invoice & void status & credit note tests
test("exportInvoicesCsv: handles two invoice lines without double-counting and excludes voided invoices", () => {
  const db = makeTestDb();
  const csv = exportInvoicesCsv(db);
  const rows = csv.split("\n").map((r) => r.split(","));
  const headers = rows[0];

  const invNumberIdx = headers.indexOf("transaction_id");
  const totalAmountIdx = headers.indexOf("total_invoiced_amount");
  const hoursIdx = headers.indexOf("labor_hours");
  const matCostIdx = headers.indexOf("material_cost");

  // Voided invoice must NOT be in the review rows
  const voidRows = rows.filter((r) => r[invNumberIdx] === "INV-2026-VOID");
  assert.equal(voidRows.length, 0, "Voided invoices must be excluded from billable review export");

  // Active invoice lines
  const invRows = rows.filter((r) => r[invNumberIdx] === "INV-2026-001");
  assert.equal(invRows.length, 2, "Two-line invoice must produce exactly two line rows");

  // Check that line amounts sum to the invoice total (400 + 100 = 500), NOT 500 + 500 = 1000
  const totalInvoiced = invRows.reduce((sum, r) => sum + Number(r[totalAmountIdx]), 0);
  assert.equal(totalInvoiced, 500, "Two-line invoice amounts must sum to 500, not doubled");

  // Check that labor hours sum to 8 (not 16)
  const totalHours = invRows.reduce((sum, r) => sum + Number(r[hoursIdx]), 0);
  assert.equal(totalHours, 8, "Labor hours must not be duplicated across lines");

  // Check that material cost sums to 100 (not 200)
  const totalMat = invRows.reduce((sum, r) => sum + Number(r[matCostIdx]), 0);
  assert.equal(totalMat, 100, "Material cost must not be duplicated across lines");

  // Credit note row
  const cnRows = rows.filter((r) => r[0] === "credit_note");
  assert.equal(cnRows.length, 1);
  assert.equal(cnRows[0][invNumberIdx], "cn1");
  assert.equal(Number(cnRows[0][totalAmountIdx]), -50);
});

// 2. Business timezone tests
test("businessTimezone: UTC midnight boundary formats into next day in CAT (Africa/Harare)", () => {
  const lateUtc = "2026-12-31T22:30:00.000Z";
  // 22:30 UTC on Dec 31 is 00:30 CAT on Jan 1
  const harareDate = formatBusinessDate(lateUtc, "Africa/Harare");
  assert.equal(harareDate, "2027-01-01", "Year boundary at 22:30 UTC must be 2027-01-01 in Harare");

  // Calendar dates without time component remain unchanged
  assert.equal(formatBusinessDate("2026-10-05"), "2026-10-05");

  // Invalid timezone falls back safely without crash
  assert.equal(getBusinessTimezone({ ORAC_BUSINESS_TIMEZONE: "Invalid/Zone_Name" }), "Africa/Harare");
});

// 3. Four review export routes: byte digest hashing, audit metadata, permissions
test("exportPastel (invoices review): audits exact SHA-256 byte digest and accounting_posted:false", () => {
  const db = makeTestDb();
  const audits = [];
  const store = { audit: (...args) => audits.push(args) };
  const res = mockRes();

  exportPastel({ db, store, user: { id: "u_fin" } }, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-disposition"], /orac-review-invoices-\d{4}-\d{2}-\d{2}\.csv/);

  const downloadedBytes = res.body;
  const expectedHash = crypto.createHash("sha256").update(downloadedBytes).digest("hex");

  assert.equal(audits.length, 1);
  const auditEntry = audits[0];
  assert.equal(auditEntry[4], "PASTEL_EXPORT_GENERATED");
  assert.equal(auditEntry[6].accounting_posted, false);
  assert.equal(auditEntry[6].designation, "REVIEW_NON_POSTING");
  assert.equal(auditEntry[6].sha256, expectedHash);
  assert.equal(auditEntry[6].row_count, 3); // 2 invoice lines + 1 credit note
});

test("getPastelReviewQuotes: audits exact SHA-256 byte digest and accounting_posted:false", () => {
  const db = makeTestDb();
  const audits = [];
  const store = { audit: (...args) => audits.push(args) };
  const res = mockRes();

  getPastelReviewQuotes({ db, store, user: { id: "u_fin" } }, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-disposition"], /orac-review-quotes-\d{4}-\d{2}-\d{2}\.csv/);

  const downloadedBytes = res.body;
  const expectedHash = crypto.createHash("sha256").update(downloadedBytes).digest("hex");

  assert.equal(audits.length, 1);
  const auditEntry = audits[0];
  assert.equal(auditEntry[4], "PASTEL_REVIEW_EXPORT_GENERATED");
  assert.equal(auditEntry[6].accounting_posted, false);
  assert.equal(auditEntry[6].designation, "REVIEW_NON_POSTING");
  assert.equal(auditEntry[6].sha256, expectedHash);
  assert.equal(auditEntry[6].row_count, 1);
});

test("getPastelReviewInvoiceReady: audits exact SHA-256 byte digest and accounting_posted:false", () => {
  const db = makeTestDb();
  const audits = [];
  const store = { audit: (...args) => audits.push(args) };
  const res = mockRes();

  getPastelReviewInvoiceReady({ db, store, user: { id: "u_fin" } }, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-disposition"], /orac-review-invoice-ready-\d{4}-\d{2}-\d{2}\.csv/);

  const downloadedBytes = res.body;
  const expectedHash = crypto.createHash("sha256").update(downloadedBytes).digest("hex");

  assert.equal(audits.length, 1);
  const auditEntry = audits[0];
  assert.equal(auditEntry[4], "PASTEL_REVIEW_EXPORT_GENERATED");
  assert.equal(auditEntry[6].accounting_posted, false);
  assert.equal(auditEntry[6].designation, "REVIEW_NON_POSTING");
  assert.equal(auditEntry[6].sha256, expectedHash);
});

test("exportTechnicianPayrollPastel: blocks missing employee code with 422 and audits exact SHA-256 byte digest", () => {
  const db = makeTestDb();
  // Add a line for t2 who has national ID but NO employee_code
  db.worksheet_registers[0].roster.push({ key: "t_t2", technician_id: "t2", display_name: "Blessing Phiri" });
  db.worksheet_registers[0].lines.push({
    roster_key: "t_t2", date: "2026-10-06", normal: 8, ot_15: 0, ot_20: 0, sign_off_employee: "Blessing", sign_off_supervisor: "Sup"
  });

  const audits = [];
  const store = { audit: (...args) => audits.push(args) };
  const resBlocked = mockRes();

  // Must be blocked with 422 because t2 lacks employee_code
  exportTechnicianPayrollPastel({ db, store, user: { id: "u_fin" }, query: { month: "2026-10" } }, resBlocked);
  assert.equal(resBlocked.statusCode, 422);
  assert.match(resBlocked.body.message, /Some employees cannot be exported/);
  assert.ok(resBlocked.body.blocked.some((b) => b.full_name === "Blessing Phiri"));

  // Now assign employee_code to t2 and verify successful export & byte hash audit
  db.users.find((u) => u.id === "t2").employee_code = "E002";
  const resSuccess = mockRes();
  exportTechnicianPayrollPastel({ db, store, user: { id: "u_fin" }, query: { month: "2026-10" } }, resSuccess);
  assert.equal(resSuccess.statusCode, 200);
  assert.match(resSuccess.headers["content-disposition"], /orac-review-payroll-2026-10\.csv/);

  const downloadedBytes = resSuccess.body;
  const expectedHash = crypto.createHash("sha256").update(downloadedBytes).digest("hex");

  // Verify national ID does NOT appear anywhere in the CSV
  assert.ok(!downloadedBytes.includes("63-123456"), "National ID of t1 must not appear in CSV");
  assert.ok(!downloadedBytes.includes("08-765432"), "National ID of t2 must not appear in CSV");

  const lastAudit = audits.at(-1);
  assert.equal(lastAudit[4], "PASTEL_PAYROLL_EXPORT_GENERATED");
  assert.equal(lastAudit[6].accounting_posted, false);
  assert.equal(lastAudit[6].designation, "REVIEW_NON_POSTING");
  assert.equal(lastAudit[6].sha256, expectedHash);
});

test("export permissions: Operations is forbidden from exporting; Admin and Finance are authorized", () => {
  const db = makeTestDb();
  const store = { audit: () => {} };

  // Operations gets 403 on all export routes
  for (const handler of [exportPastel, getPastelReviewQuotes, getPastelReviewInvoiceReady]) {
    assert.throws(
      () => handler({ db, store, user: { id: "u_ops" } }, mockRes()),
      (err) => err.status === 403
    );
  }
  assert.throws(
    () => exportTechnicianPayrollPastel({ db, store, user: { id: "u_ops" }, query: { month: "2026-10" } }, mockRes()),
    (err) => err.status === 403
  );

  // Admin is authorized
  const resAdmin = mockRes();
  exportPastel({ db, store, user: { id: "u_admin" } }, resAdmin);
  assert.equal(resAdmin.statusCode, 200);
});
