import assert from "node:assert/strict";
import test from "node:test";
import { capturePo, submitClientPo } from "../src/controllers/quoteController.js";
import { addTimesheet, addMaterialUsage } from "../src/controllers/dispatchController.js";
import { submitKioskTimesheets } from "../src/controllers/kioskController.js";

// Chat E cross-chat governance guards (C commercial, D delivery, G stock link).

function res() {
  return { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
function ctx({ quoteStatus = "Field_Dispatch", clientActive, invoices = [], po = null } = {}) {
  const audits = [];
  const db = {
    users: [
      { id: "ops", role: "Operations", is_active: true },
      { id: "cli", role: "Client Viewer", is_active: true, client_id: "c1" },
      { id: "tech", role: "Technician", is_active: true }
    ],
    clients: [{ id: "c1", name: "C1", ...(clientActive === undefined ? {} : { is_active: clientActive }) }],
    quotes: [{ id: "q1", client_id: "c1", status: quoteStatus }],
    purchase_orders: po ? [po] : [],
    dispatch_cards: [{ id: "d1", quotation_id: "q1", purchase_order_id: po?.id || null, assigned_technician_id: "tech", dispatch_number: "JOB-1" }],
    field_worksheets: [], timesheets: [], material_usage: [], invoices, stock_items: [], stock_movements: [], audit_logs: []
  };
  const store = { id: (p) => `${p}_n`, recalculateVariance() {}, audit: (...a) => audits.push(a) };
  return { db, store, audits };
}
const verifiedPo = () => ({ id: "po1", quotation_id: "q1", po_reference: "R1", po_amount: 100, status: "verified", verified_by: "x", requires_amendment: false });
const reqFor = (user, c, params, body) => ({ user: { id: user }, params, body, db: c.db, store: c.store });

// ---- PO controls
test("verified PO amount cannot be changed via capturePo (must use amendment)", () => {
  const c = ctx({ po: verifiedPo() }); const r = res();
  capturePo(reqFor("ops", c, { id: "q1" }, { po_reference: "R1", po_amount: 500 }), r);
  assert.equal(r.statusCode, 409);
  assert.equal(c.db.purchase_orders[0].po_amount, 100);
  assert.equal(c.audits.length, 0);
});
test("re-verifying a verified PO at the same amount is still allowed", () => {
  const c = ctx({ po: verifiedPo() }); const r = res();
  capturePo(reqFor("ops", c, { id: "q1" }, { po_reference: "R1-fixed", po_amount: 100 }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(c.db.purchase_orders[0].po_reference, "R1-fixed");
});
test("PO capture refused for Invoiced and Cancelled quotes", () => {
  for (const status of ["Invoiced", "Cancelled"]) {
    const c = ctx({ quoteStatus: status, po: verifiedPo() }); const r = res();
    capturePo(reqFor("ops", c, { id: "q1" }, { po_reference: "R1", po_amount: 100 }), r);
    assert.equal(r.statusCode, 409, status);
    assert.equal(c.audits.length, 0);
  }
});
test("client PO refused for Draft, Cancelled, Invoiced quotes; allowed once issued", () => {
  for (const status of ["Draft", "Cancelled", "Invoiced"]) {
    const c = ctx({ quoteStatus: status }); const r = res();
    submitClientPo(reqFor("cli", c, { id: "q1" }, { po_reference: "P", po_amount: 10 }), r);
    assert.equal(r.statusCode, 409, status);
    assert.equal(c.db.purchase_orders.length, 0);
  }
  const ok = ctx({ quoteStatus: "Approved_Pending_PO" }); const r = res();
  submitClientPo(reqFor("cli", ok, { id: "q1" }, { po_reference: "P", po_amount: 10 }), r);
  assert.equal(r.statusCode, 200);
});
test("deactivated client cannot submit a PO; active or unflagged client can", () => {
  const off = ctx({ quoteStatus: "Approved_Pending_PO", clientActive: false }); const r = res();
  submitClientPo(reqFor("cli", off, { id: "q1" }, { po_reference: "P", po_amount: 10 }), r);
  assert.equal(r.statusCode, 403);
  assert.equal(off.db.purchase_orders.length, 0);
  for (const flag of [true, undefined]) {
    const c = ctx({ quoteStatus: "Approved_Pending_PO", clientActive: flag }); const r2 = res();
    submitClientPo(reqFor("cli", c, { id: "q1" }, { po_reference: "P", po_amount: 10 }), r2);
    assert.equal(r2.statusCode, 200);
  }
});

// ---- billable evidence freeze after invoicing
const inv = (status) => [{ id: "i1", dispatch_card_id: "d1", status }];
test("timesheet, material and kiosk entries are refused once the dispatch is invoiced", () => {
  const c = ctx({ invoices: inv("sent") });
  let r = res();
  addTimesheet(reqFor("tech", c, { id: "d1" }, { hours_logged: 2, hourly_rate: 10 }), r);
  assert.equal(r.statusCode, 409);
  r = res();
  addMaterialUsage(reqFor("tech", c, { id: "d1" }, { description: "x", quantity_used: 1, unit_cost: 5 }), r);
  assert.equal(r.statusCode, 409);
  r = res();
  submitKioskTimesheets(reqFor("ops", c, { id: "d1" }, { work_date: "2026-09-01", entries: [{ technician_id: "tech", hours_logged: 1, hourly_rate: 1 }] }), r);
  assert.equal(r.statusCode, 409);
  assert.equal(c.db.timesheets.length + c.db.material_usage.length, 0);
  assert.equal(c.audits.length, 0);
});
test("a voided invoice, or no invoice, does not freeze the dispatch", () => {
  for (const invoices of [inv("voided"), []]) {
    const c = ctx({ invoices }); const r = res();
    // A Technician entry must cite the Technician's own Supervisor-approved worksheet
    // (newer evidence-chain rule), so the fixture provides one.
    c.db.field_worksheets.push({ id: "w1", dispatch_card_id: "d1", technician_id: "tech", status: "Supervisor_Approved", hours: 2 });
    addTimesheet(reqFor("tech", c, { id: "d1" }, { hours_logged: 2, hourly_rate: 10, source_worksheet_id: "w1" }), r);
    assert.equal(r.statusCode, 200);
    assert.equal(c.db.timesheets.length, 1);
  }
});

// ---- audit trail: public lead is not attributed to a staff account
import { createLead } from "../src/controllers/coreController.js";
test("public lead submission is audited as system, not as the first user", () => {
  const audits = [];
  const db = { users: [{ id: "admin-1", role: "Admin", is_active: true }], leads: [] };
  const store = { id: (p) => `${p}_n`, audit: (_db, actor, ...rest) => audits.push({ actor, rest }) };
  const r = res();
  createLead({ body: { company_name: "A", contact_name: "B", email: "a@b.co", service_need: "x" }, db, store }, r);
  assert.equal(r.statusCode, 200);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor, null);
});
test("authenticated lead creation is still attributed to that user", () => {
  const audits = [];
  const db = { users: [{ id: "admin-1", role: "Admin", is_active: true }, { id: "sales-1", role: "Sales", is_active: true }], leads: [] };
  const store = { id: (p) => `${p}_n`, audit: (_db, actor) => audits.push(actor) };
  createLead({ user: { id: "sales-1" }, body: { company_name: "A", contact_name: "B", email: "a@b.co", service_need: "x" }, db, store }, res());
  assert.equal(audits[0].id, "sales-1");
});
