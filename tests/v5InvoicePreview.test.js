import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildV5InvoicePreview } from "../src/v5InvoicePreview.js";
import { getV5InvoicePreview } from "../src/controllers/v5InvoicePreviewController.js";
import { createV5ClientSupervisorContact, recordV5PaperSignature, confirmV5Timesheet } from "../src/controllers/v5SignatureController.js";
import { database, call, contactBody, paperBody, withV5 } from "./helpers/v5SignatureFixture.js";
import { v5SignatureState } from "../src/v5SignatureEvidence.js";
import apiRouter from "../src/router.js";
import { createStore } from "../src/store.js";
import { persistenceMiddleware } from "../src/persistenceMiddleware.js";
import { generateToken } from "../src/middleware/auth.js";

function verifiedDb() {
  const db = database();
  Object.assign(db.quotes[0], {
    quote_number: "Q-V5-1", currency: "USD", tax_status: "unconfigured",
    commercial_acceptance_po_id: "po-1", commercial_acceptance_reference: "PO-V5-1"
  });
  Object.assign(db.quote_lines[0], { quantity: 16, unit_price_cents: 2500, currency: "USD", tax_status: "unconfigured" });
  db.purchase_orders = [{ id: "po-1", quotation_id: "quote-1", po_reference: "PO-V5-1", po_amount: 1000, status: "verified" }];
  db.dispatch_cards[0].purchase_order_id = "po-1";
  const contact = call(createV5ClientSupervisorContact, db, "sales-1", { params: { id: "job-1" }, body: contactBody() }).body.data;
  assert.equal(call(recordV5PaperSignature, db, "sales-1", { params: { id: "ws-1" }, body: paperBody(contact.id) }).statusCode, 201);
  const state = v5SignatureState(db, db.field_worksheets[0]);
  assert.equal(call(confirmV5Timesheet, db, "sup-1", { params: { id: "ws-1" }, body: { evidence_id: state.evidence.id, hours_hash: state.current_hash, attest: true } }).statusCode, 201);
  return db;
}

test("V5 invoice preview is dark by default and does not mutate records", () => {
  const db = withV5(() => verifiedDb());
  const before = JSON.stringify(db);
  const res = call(getV5InvoicePreview, db, "sales-1", { params: { id: "job-1" } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "FEATURE_DISABLED");
  assert.equal(JSON.stringify(db), before);
});

test("V5 invoice preview calculates only the accepted USD hourly snapshot from verified evidence", () => withV5(() => {
  const db = verifiedDb();
  const before = JSON.stringify(db);
  const result = buildV5InvoicePreview(db, "job-1");
  assert.equal(result.data.ready_to_create_in_future, true);
  assert.equal(result.data.pre_tax_total_cents, 22500);
  assert.equal(result.data.tax_total_cents, 0);
  assert.deepEqual(result.data.lines[0], {
    quote_line_id: "line-1", description: "Labour", pricing_basis: "hourly", quoted_quantity: 16,
    quantity_to_bill: 9, unit_price_cents: 2500, pre_tax_total_cents: 22500,
    currency: "USD", source_evidence_ids: ["ws-1"]
  });
  assert.equal(JSON.stringify(db), before, "preview has no invoice, audit, or evidence side effect");
}));

test("V5 preview makes uncovered quantities and unallocated material explicit blockers", () => withV5(() => {
  const db = verifiedDb();
  db.quote_lines[0].quantity = 8;
  db.quote_lines.push({ id: "line-material", quotation_id: "quote-1", description: "Tile", pricing_basis: "material", quantity: 2, unit_price_cents: 1000, currency: "USD", tax_status: "unconfigured" });
  db.material_usage = [{ id: "usage-1", dispatch_card_id: "job-1", catalog_item_id: "tile", quantity_used: 3 }];
  const result = buildV5InvoicePreview(db, "job-1").data;
  assert.equal(result.ready_to_create_in_future, false);
  assert.ok(result.blockers.some((item) => item.code === "V5_LINE_AMENDMENT_OR_COMPLETION_REQUIRED"));
  assert.ok(result.blockers.some((item) => item.code === "UNALLOCATED_MATERIAL_USAGE"));
  assert.equal(JSON.stringify(result).includes("unit_cost"), false);
}));

test("V5 preview treats fixed lines as blocked until the required completion rule exists", () => withV5(() => {
  const db = verifiedDb();
  Object.assign(db.quote_lines[0], { pricing_basis: "fixed", quantity: 1 });
  const result = buildV5InvoicePreview(db, "job-1").data;
  assert.equal(result.ready_to_create_in_future, false);
  assert.match(result.blockers.map((item) => item.message).join(" "), /completion rule/);
}));

test("a fixed line bills its accepted snapshot only after the explicitly recorded Supervisor-confirmed rule is met", () => withV5(() => {
  const db = verifiedDb();
  Object.assign(db.quote_lines[0], { pricing_basis: "fixed", quantity: 2, completion_rule: "supervisor_confirmed_timesheet" });
  const result = buildV5InvoicePreview(db, "job-1").data;
  assert.equal(result.ready_to_create_in_future, true);
  assert.equal(result.lines[0].quantity_to_bill, 2);
  assert.equal(result.lines[0].pre_tax_total_cents, 5000);
  assert.deepEqual(result.lines[0].source_evidence_ids, ["ws-1"]);
}));

test("the V5 preview shows a linked approved amendment but fails closed until its evidence coverage exists", () => withV5(() => {
  const db = verifiedDb();
  db.quotes.push({ id: "quote-amend", quote_number: "Q-V5-1-R2", v5_commercial_workflow: true, commercial_acceptance_status: "po_verified", v5_amendment_approval: { approved_by: "admin-1" } });
  db.purchase_orders.push({ id: "po-amend", quotation_id: "quote-amend", po_reference: "PO-AMEND", po_amount: 50, status: "verified" });
  db.v5_amendment_dispatch_links = [{ id: "link-amend", dispatch_card_id: "job-1", amendment_quote_id: "quote-amend", amendment_purchase_order_id: "po-amend", amendment_approval_at: "2026-10-20T12:00:00.000Z", linked_at: "2026-10-20T12:01:00.000Z" }];
  const result = buildV5InvoicePreview(db, "job-1").data;
  assert.equal(result.ready_to_create_in_future, false);
  assert.deepEqual(result.linked_approved_amendments.map((item) => item.amendment_quote_id), ["quote-amend"]);
  assert.ok(result.blockers.some((item) => item.code === "V5_AMENDMENT_COVERAGE_NOT_IMPLEMENTED"));
}));

test("real router authenticates the read-only V5 invoice preview and never writes an invoice", async () => {
  const previous = process.env.ORAC_V5_COMMERCIAL_WORKFLOW;
  process.env.ORAC_V5_COMMERCIAL_WORKFLOW = "enabled";
  const dir = mkdtempSync(join(tmpdir(), "orac-v5-preview-http-"));
  const store = createStore(join(dir, "db.json"));
  const sales = { id: "sales-http", email: "sales@fixture.invalid", role: "Sales", is_active: true };
  const technician = { id: "tech-http", email: "tech@fixture.invalid", role: "Technician", is_active: true };
  try {
    const { db, release } = await store.read();
    db.users = [sales, technician];
    db.quotes = [{ id: "q-http", v5_commercial_workflow: true, commercial_acceptance_status: "po_verified", commercial_acceptance_po_id: "po-http", currency: "USD", tax_status: "unconfigured" }];
    db.quote_lines = [{ id: "ql-http", quotation_id: "q-http", description: "Labour", pricing_basis: "hourly", quantity: 8, unit_price_cents: 1000, currency: "USD" }];
    db.purchase_orders = [{ id: "po-http", quotation_id: "q-http", po_reference: "PO-HTTP", po_amount: 100, status: "verified" }];
    db.dispatch_cards = [{ id: "d-http", quotation_id: "q-http", purchase_order_id: "po-http" }];
    db.field_worksheets = []; db.material_usage = []; db.invoices = []; db.audit_logs = [];
    store.write(db, release);
    const app = express(); app.use(express.json()); app.use("/api", persistenceMiddleware(store)); app.use("/api", apiRouter);
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
    const server = await new Promise((resolve) => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
    try {
      const url = `http://127.0.0.1:${server.address().port}/api/dispatch_cards/d-http/v5-invoice-preview`;
      const ok = await fetch(url, { headers: { Authorization: `Bearer ${generateToken(sales)}` } });
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).data.preview_only, true);
      const denied = await fetch(url, { headers: { Authorization: `Bearer ${generateToken(technician)}` } });
      assert.equal(denied.status, 403);
      const after = await store.read();
      assert.equal(after.db.invoices.length, 0); after.release();
    } finally { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
  } finally {
    if (previous === undefined) delete process.env.ORAC_V5_COMMERCIAL_WORKFLOW; else process.env.ORAC_V5_COMMERCIAL_WORKFLOW = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
