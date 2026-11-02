import test from "node:test";
import assert from "node:assert/strict";
import { getDispatchInvoiceReadiness, getDispatchJobCard } from "../src/controllers/dispatchController.js";

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function db() {
  return {
    users: [
      { id: "admin", role: "Admin", is_active: true, name: "Admin" },
      { id: "management", role: "Management", is_active: true, name: "Manager" },
      { id: "ops", role: "Operations", is_active: true, name: "Operations" },
      { id: "supervisor", role: "Supervisor", is_active: true, name: "Supervisor" },
      { id: "technician", role: "Technician", is_active: true, name: "Technician", trade: "Fitter" },
      { id: "outsider", role: "Technician", is_active: true, name: "Outsider" }
    ],
    clients: [{ id: "client-1", name: "Evidence Client" }],
    quotes: [{ id: "quote-1", quote_number: "Q-100", client_id: "client-1", status: "Field_Dispatch", total_amount: 100 }],
    purchase_orders: [{ id: "po-1", quotation_id: "quote-1", po_reference: "PO-100", status: "verified", po_amount: 500 }],
    dispatch_cards: [{ id: "dispatch-1", dispatch_number: "JOB-100", quotation_id: "quote-1", purchase_order_id: "po-1", status: "Active", scheduled_start: "2026-10-21", assigned_supervisor_id: "supervisor", assigned_technician_ids: ["technician"] }],
    field_worksheets: [
      { id: "ws-approved", dispatch_card_id: "dispatch-1", status: "Supervisor_Approved", hours: 8, evidence_files: ["photo"] },
      { id: "ws-submitted", dispatch_card_id: "dispatch-1", status: "Submitted", hours: 4, evidence_files: [] },
      { id: "ws-returned", dispatch_card_id: "dispatch-1", status: "Returned_For_Correction", hours: 2, evidence_files: [] }
    ],
    material_usage: [{ id: "mu-1", dispatch_card_id: "dispatch-1", catalog_item_id: "catalog-1" }],
    stock_items: [{ id: "stock-1", catalog_item_id: "catalog-1", quantity_on_hand: 2, reorder_level: 3 }],
    timesheets: [],
    invoices: [],
    audit_logs: [{ entity_type: "dispatch_card", entity_id: "dispatch-1" }]
  };
}

function request(data, userId) {
  return { user: { id: userId }, params: { id: "dispatch-1" }, db: data };
}

test("Job Card gives an authorized field user only safe evidence and assignment context", () => {
  const data = db();
  const res = response();
  getDispatchJobCard(request(data, "technician"), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.identity.dispatch_number, "JOB-100");
  assert.equal(res.body.data.evidence_summary.timesheets.total, 3);
  assert.equal(res.body.data.evidence_summary.timesheets.awaiting_client, 1);
  assert.equal(res.body.data.evidence_summary.timesheets.returned, 1);
  assert.equal(res.body.data.evidence_summary.material_usage.low_stock_count, 1);
  assert.deepEqual(res.body.data.assignment.roster, []);
  assert.equal(res.body.data.evidence_summary.audit.available, false);
  assert.equal(res.body.data.workflow.purchase_order.po_amount, undefined);
  assert.equal(res.body.data.capabilities.can_create_timesheet, true);
});

test("Job Card permits Management to read all dispatch evidence without exposing financial totals", () => {
  const data = db();
  const res = response();
  getDispatchJobCard(request(data, "management"), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.assignment.roster[0].name, "Technician");
  assert.equal(res.body.data.evidence_summary.audit.available, true);
  assert.equal(res.body.data.evidence_summary.audit.event_count, 1);
  assert.equal(res.body.data.workflow.quotation.total_amount, undefined);
});

test("Job Card refuses a Technician who is not assigned to the dispatch", () => {
  const res = response();
  getDispatchJobCard(request(db(), "outsider"), res);
  assert.equal(res.statusCode, 403);
});

test("Job Card reports an explicit V5 invoice blocker instead of claiming the dispatch is invoiceable", () => {
  const data = db();
  data.quotes[0].v5_commercial_workflow = true;
  const res = response();
  getDispatchJobCard(request(data, "admin"), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.exceptions.invoice_readiness.code, "V5_INVOICE_CALCULATION_UNAVAILABLE");
});

test("Invoice readiness gives a Finance reviewer the server gate and evidence totals without writing an invoice", () => {
  const data = db();
  data.users.push({ id: "finance", role: "Finance", is_active: true, name: "Finance" });
  data.timesheets = [{ id: "time-1", dispatch_card_id: "dispatch-1", hours_logged: 8, hourly_rate: 20 }];
  data.material_usage[0].total_cost = 30;
  const res = response();
  getDispatchInvoiceReadiness(request(data, "finance"), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.commercial.currency, "USD");
  assert.equal(res.body.data.evidence.worksheets.approved, 1);
  assert.equal(res.body.data.evidence.billable_time.entry_count, 1);
  assert.equal(res.body.data.commercial.calculated_invoice.total_amount, 190);
  assert.equal(res.body.data.readiness.ready_for_invoice_review, true);
  assert.equal(data.invoices.length, 0);
});

test("Invoice readiness keeps V5 calculation unavailable and refuses field roles", () => {
  const data = db();
  data.quotes[0].v5_commercial_workflow = true;
  const finance = { id: "finance", role: "Finance", is_active: true, name: "Finance" };
  data.users.push(finance);
  const allowed = response();
  getDispatchInvoiceReadiness(request(data, "finance"), allowed);
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.body.data.commercial.calculation_available, false);
  assert.equal(allowed.body.data.commercial.calculated_invoice, null);
  assert.equal(allowed.body.data.readiness.blocker.code, "V5_INVOICE_CALCULATION_UNAVAILABLE");

  const denied = response();
  assert.throws(() => getDispatchInvoiceReadiness(request(data, "technician"), denied), { status: 403 });
});
