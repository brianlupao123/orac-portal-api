import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../src/store.js";
import { transitionQuote } from "../src/stateMachine.js";
import { exportInvoicesCsv } from "../src/exporter.js";
import { getInvoicePdf } from "../src/controllers/documentController.js";
import { capturePo } from "../src/controllers/quoteController.js";

function makeCtx(clientName = "Zimplats") {
  const store = createStore(":memory:");
  const db = {
    users: [
      { id: "u_admin", role: "Admin", is_active: true },
      { id: "u_fin", role: "Finance", is_active: true }
    ],
    clients: [{ id: "c1", name: clientName }],
    quote_lines: [{ id: "l1", quotation_id: "q1", description: "Service", quantity: 1, unit_price: 1000, line_total: 1000 }],
    quotes: [{ id: "q1", quote_number: "Q-0001", client_id: "c1", equipment_tag_id: "eq1", status: "Draft", total_amount: 1000 }],
    purchase_orders: [], dispatch_cards: [], field_worksheets: [], timesheets: [], material_usage: [],
    invoices: [], invoice_lines: [], audit_logs: [], po_amendments: [],
    equipment_tags: [{ id: "eq1", tag_code: "CV-01" }],
    plant_sections: [], plants: [], mine_sites: [], company_profile: {}
  };
  return { db, store, admin: db.users[0] };
}

function invoiceJob(ctx, { poAmount = 5000, materials = 0, hours = 0, rate = 0, zeroHourTimesheet = false } = {}) {
  const { db, store, admin } = ctx;
  transitionQuote(db, store, "q1", "Sent", {}, admin);
  transitionQuote(db, store, "q1", "Approved_Pending_PO", {}, admin);
  db.purchase_orders.push({ id: "po1", quotation_id: "q1", po_reference: "PO-77", po_amount: poAmount, status: "verified", requires_amendment: false });
  transitionQuote(db, store, "q1", "Field_Dispatch", {}, admin);
  const job = db.dispatch_cards[0];
  job.purchase_order_id = "po1";
  if (materials) db.material_usage.push({ id: "m1", dispatch_card_id: job.id, total_cost: materials });
  if (hours) db.timesheets.push({ id: "t1", dispatch_card_id: job.id, hours_logged: hours, hourly_rate: rate });
  if (zeroHourTimesheet) db.timesheets.push({ id: "t0", dispatch_card_id: job.id, hours_logged: 0, hourly_rate: 50 });
  db.field_worksheets.push({ id: "w1", dispatch_card_id: job.id, status: "Supervisor_Approved" });
  store.recalculateVariance(db, "po1");
  return transitionQuote(db, store, "q1", "Invoiced", {}, admin).created;
}

const sumLines = (db, invoice) => db.invoice_lines.filter((l) => l.invoice_id === invoice.id).reduce((s, l) => s + l.line_total, 0);

test("invoice lines sum to the invoice total: materials only", () => {
  const ctx = makeCtx();
  const inv = invoiceJob(ctx, { materials: 500 });
  assert.equal(inv.total_amount, 500);
  assert.equal(sumLines(ctx.db, inv), 500);
});

test("invoice lines sum to the invoice total: labour plus materials", () => {
  const ctx = makeCtx();
  const inv = invoiceJob(ctx, { materials: 500, hours: 10, rate: 50 });
  assert.equal(inv.total_amount, 1000);
  assert.equal(sumLines(ctx.db, inv), 1000);
});

test("invoice lines are finite when the only timesheet has zero hours", () => {
  const ctx = makeCtx();
  const inv = invoiceJob(ctx, { zeroHourTimesheet: true });
  for (const line of ctx.db.invoice_lines.filter((l) => l.invoice_id === inv.id)) {
    assert.ok(Number.isFinite(line.unit_price) && Number.isFinite(line.line_total));
  }
});

test("Pastel export neutralises formula-leading text but leaves numbers alone", () => {
  const ctx = makeCtx('=HYPERLINK("http://example.invalid","x")');
  const inv = invoiceJob(ctx, { hours: 10, rate: 50 });
  ctx.db.purchase_orders[0].po_reference = "+SUM(1+1)";
  ctx.db.invoice_lines[0].description = "@cmd";
  const row = exportInvoicesCsv(ctx.db).split("\n")[1];
  assert.match(row, /"'=HYPERLINK/);
  assert.ok(row.includes(",'+SUM(1+1),"));
  assert.ok(row.includes(",'@cmd,"));
  assert.ok(row.endsWith(",10,0,500"), row);
  assert.equal(inv.total_amount, 500);
});

test("Pastel export falls back to created_at for invoices without generated_at", () => {
  const ctx = makeCtx();
  const inv = invoiceJob(ctx, { hours: 10, rate: 50 });
  inv.created_at = "2026-08-01T00:00:00.000Z";
  delete inv.generated_at;
  assert.equal(exportInvoicesCsv(ctx.db).split("\n")[1].split(",")[1], "2026-08-01");
});

test("invoice PDF shows invoice date and job reference for workflow-created invoices", () => {
  const ctx = makeCtx();
  const inv = invoiceJob(ctx, { hours: 10, rate: 50 });
  let buf;
  const res = { status() { return this; }, json(b) { this.body = b; return this; }, type() { return this; }, send(b) { buf = b; } };
  getInvoicePdf({ user: { id: "u_fin" }, params: { id: inv.id }, db: ctx.db }, res);
  assert.ok(buf, JSON.stringify(res.body));
  const text = buf.toString("binary");
  // The controlled PDF uses labelled table cells, so labels and values are
  // separate PDF text blocks. Assert the required evidence, not old layout.
  assert.match(text, /Invoice Date/);
  assert.match(text, /\d{4}-\d{2}-\d{2}, \d{2}:\d{2} UTC/);
  assert.match(text, /Job Reference/);
  assert.match(text, /JOB-0001/);
});

test("re-verifying a PO for less than logged work keeps the amendment block", () => {
  const { db, store, admin } = makeCtx();
  transitionQuote(db, store, "q1", "Sent", {}, admin);
  transitionQuote(db, store, "q1", "Approved_Pending_PO", {}, admin);
  transitionQuote(db, store, "q1", "Field_Dispatch", { started_before_po: true, urgent_reason: "breakdown" }, admin);
  const job = db.dispatch_cards[0];
  db.timesheets.push({ id: "t1", dispatch_card_id: job.id, hours_logged: 100, hourly_rate: 50 });
  db.field_worksheets.push({ id: "w1", dispatch_card_id: job.id, status: "Supervisor_Approved" });
  store.recalculateVariance(db, job.purchase_order_id);
  const res = { status() { return this; }, json(b) { this.body = b; return this; } };
  capturePo({ user: { id: "u_fin" }, params: { id: "q1" }, body: { po_reference: "PO-LOW", po_amount: 1000 }, db, store }, res);
  const po = db.purchase_orders[0];
  assert.equal(po.requires_amendment, true);
  assert.throws(() => transitionQuote(db, store, "q1", "Invoiced", {}, admin), /requires an approved PO amendment/);
});

test("re-verifying a PO for at least the logged work clears the amendment flag", () => {
  const { db, store, admin } = makeCtx();
  transitionQuote(db, store, "q1", "Sent", {}, admin);
  transitionQuote(db, store, "q1", "Approved_Pending_PO", {}, admin);
  transitionQuote(db, store, "q1", "Field_Dispatch", { started_before_po: true, urgent_reason: "breakdown" }, admin);
  const job = db.dispatch_cards[0];
  db.timesheets.push({ id: "t1", dispatch_card_id: job.id, hours_logged: 100, hourly_rate: 50 });
  store.recalculateVariance(db, job.purchase_order_id);
  const res = { status() { return this; }, json(b) { this.body = b; return this; } };
  capturePo({ user: { id: "u_fin" }, params: { id: "q1" }, body: { po_reference: "PO-OK", po_amount: 6000 }, db, store }, res);
  assert.equal(db.purchase_orders[0].requires_amendment, false);
});
