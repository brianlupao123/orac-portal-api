import assert from "node:assert/strict";
import test from "node:test";
import * as docs from "../src/controllers/documentController.js";

// A Supervisor may open job-card and Timesheet (field worksheet) documents only for work
// they are assigned to. Ownership that cannot be established must fail closed, matching
// dispatchController.isAssignedToDispatch and coreController.scopeOperationalData.

function res() {
  return {
    statusCode: 200, sent: 0, body: undefined,
    open() { if (this.sent > 0) throw new Error("second response attempted"); },
    status(code) { this.statusCode = code; return this; },
    type() { this.open(); return this; },
    json(body) { this.open(); this.sent += 1; this.body = body; return this; },
    send(body) { this.open(); this.sent += 1; this.body = body; return this; }
  };
}

function fixture() {
  return {
    users: [
      { id: "admin", role: "Admin", is_active: true },
      { id: "operations", role: "Operations", is_active: true },
      { id: "supervisor", role: "Supervisor", is_active: true },
      { id: "supervisor2", role: "Supervisor", is_active: true },
      { id: "technician", role: "Technician", is_active: true }
    ],
    clients: [{ id: "c1", name: "Client One" }],
    mine_sites: [{ id: "ms1", name: "Site" }],
    plants: [{ id: "pl1", mine_site_id: "ms1", name: "Plant" }],
    plant_sections: [{ id: "ps1", plant_id: "pl1", name: "Section" }],
    equipment_tags: [{ id: "eq1", plant_section_id: "ps1", tag_code: "EQ-1" }],
    quotes: [{ id: "q1", client_id: "c1", equipment_tag_id: "eq1", quote_number: "Q-1", status: "Sent", total_amount: 10 }],
    quote_lines: [{ id: "l1", quotation_id: "q1", description: "Line", quantity: 1, unit_price: 10 }],
    purchase_orders: [{ id: "po1", quotation_id: "q1", po_reference: "PO-1", status: "verified", requires_amendment: false, po_amount: 10 }],
    dispatch_cards: [
      { id: "d_assigned", quotation_id: "q1", equipment_tag_id: "eq1", dispatch_reference: "DC-1", status: "Open", assigned_supervisor_id: "supervisor" },
      { id: "d_unassigned", quotation_id: "q1", equipment_tag_id: "eq1", dispatch_reference: "DC-2", status: "Open" },
      { id: "d_via_worksheet", quotation_id: "q1", equipment_tag_id: "eq1", dispatch_reference: "DC-3", status: "Open" }
    ],
    field_worksheets: [
      { id: "w_assigned", dispatch_card_id: "d_assigned", technician_id: "technician", status: "Supervisor_Approved", activity: "A", hours: 1, work_date: "2026-09-20" },
      { id: "w_unassigned", dispatch_card_id: "d_unassigned", technician_id: "technician", status: "Supervisor_Approved", activity: "B", hours: 1, work_date: "2026-09-20" },
      { id: "w_via", dispatch_card_id: "d_via_worksheet", technician_id: "technician", supervisor_id: "supervisor", status: "Supervisor_Approved", activity: "C", hours: 1, work_date: "2026-09-20" },
      { id: "w_orphan", dispatch_card_id: "gone", technician_id: "technician", status: "Supervisor_Approved", activity: "D", hours: 1 }
    ],
    invoices: [], invoice_lines: [], company_profile: {}
  };
}

const run = (handler, userId, id) => { const r = res(); docs[handler]({ db: fixture(), user: { id: userId }, params: { id } }, r); return r; };
const DISPATCH = ["getDispatchDocument", "getJobCardPdf"];
const WORKSHEET = ["getWorksheetDocument", "getWorksheetPdf"];

test("Supervisor is denied job-card documents for a dispatch with no Supervisor assigned", () => {
  for (const handler of DISPATCH) {
    const r = run(handler, "supervisor", "d_unassigned");
    assert.equal(r.statusCode, 403, handler);
    assert.equal(r.sent, 1);
  }
});

test("Supervisor is denied Timesheet documents for unassigned and orphaned worksheets", () => {
  for (const handler of WORKSHEET) {
    assert.equal(run(handler, "supervisor", "w_unassigned").statusCode, 403, `${handler} unassigned`);
    assert.equal(run(handler, "supervisor", "w_orphan").statusCode, 403, `${handler} orphan`);
  }
});

test("another Supervisor is still denied an assigned dispatch's documents", () => {
  for (const handler of DISPATCH) assert.equal(run(handler, "supervisor2", "d_assigned").statusCode, 403, handler);
  for (const handler of WORKSHEET) assert.equal(run(handler, "supervisor2", "w_assigned").statusCode, 403, handler);
});

test("the assigned Supervisor keeps access, including assignment expressed only on a linked worksheet", () => {
  for (const handler of DISPATCH) {
    assert.equal(run(handler, "supervisor", "d_assigned").statusCode, 200, `${handler} assigned`);
    assert.equal(run(handler, "supervisor", "d_via_worksheet").statusCode, 200, `${handler} via worksheet`);
  }
  for (const handler of WORKSHEET) {
    assert.equal(run(handler, "supervisor", "w_assigned").statusCode, 200, `${handler} assigned`);
    assert.equal(run(handler, "supervisor", "w_via").statusCode, 200, `${handler} via worksheet`);
  }
});

test("Admin and Operations are not narrowed by the Supervisor scope", () => {
  for (const userId of ["admin", "operations"]) {
    for (const handler of DISPATCH) assert.equal(run(handler, userId, "d_unassigned").statusCode, 200, `${userId} ${handler}`);
    for (const handler of WORKSHEET) assert.equal(run(handler, userId, "w_unassigned").statusCode, 200, `${userId} ${handler}`);
  }
});
