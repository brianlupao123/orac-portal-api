import assert from "node:assert/strict";
import test from "node:test";
import {
  getQuoteDocument,
  getDispatchDocument,
  getWorksheetDocument,
  getInvoiceDocument
} from "../src/controllers/documentController.js";

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    contentType: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    type(value) {
      this.contentType = value;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    }
  };
  return res;
}

function makeDb() {
  return {
    users: [
      { id: "u_admin", role: "Admin", name: "Admin", is_active: true },
      { id: "u_sales", role: "Sales", name: "Sales", is_active: true },
      { id: "u_finance", role: "Finance", name: "Finance", is_active: true },
      { id: "u_ops", role: "Operations", name: "Ops", is_active: true },
      { id: "u_supervisor", role: "Supervisor", name: "Supervisor", is_active: true },
      { id: "u_tech", role: "Technician", name: "Technician", is_active: true },
      { id: "u_client", role: "Client Viewer", name: "Client", is_active: true, client_id: "c1" },
      { id: "u_unscoped_client", role: "Client Viewer", name: "Unscoped Client", is_active: true }
    ],
    clients: [
      { id: "c1", name: "Zimplats" },
      { id: "c2", name: "Mimosa Mining Company" }
    ],
    mine_sites: [{ id: "ms1", client_id: "c1", name: "Ngezi" }],
    plants: [{ id: "pl1", mine_site_id: "ms1", name: "SMC Concentrator" }],
    plant_sections: [{ id: "ps1", plant_id: "pl1", name: "Cyclone Cluster" }],
    equipment_tags: [{ id: "eq1", plant_section_id: "ps1", tag_code: "EQ-SMC-001", equipment_name: "Cyclone", criticality: "critical" }],
    quotes: [
      { id: "q1", quote_number: "Q-0001", client_id: "c1", equipment_tag_id: "eq1", status: "Invoiced", total_amount: 100 },
      { id: "q2", quote_number: "Q-0002", client_id: "c2", equipment_tag_id: null, status: "Draft", total_amount: 200 }
    ],
    quote_lines: [{ id: "ql1", quotation_id: "q1", description: "Field service labour", quantity: 1, unit_price: 100, line_total: 100 }],
    purchase_orders: [{ id: "po1", quotation_id: "q1", po_reference: "PO-ZIM-001", po_amount: 100, status: "verified", requires_amendment: false }],
    dispatch_cards: [{ id: "job1", quotation_id: "q1", purchase_order_id: "po1", equipment_tag_id: "eq1", dispatch_number: "JOB-0001", assigned_supervisor_id: "u_supervisor", status: "active" }],
    field_worksheets: [{ id: "ws1", dispatch_card_id: "job1", technician_id: "u_tech", work_date: "2026-09-09", activity: "Lining inspection", hours: 2, status: "Supervisor_Approved", approved_by: "u_supervisor" }],
    invoices: [{ id: "inv1", invoice_number: "INV-0001", purchase_order_id: "po1", dispatch_card_id: "job1", total_amount: 100, status: "sent", generated_by: "u_finance", generated_at: "2026-09-09T10:00:00.000Z" }],
    invoice_lines: [{ id: "il1", invoice_id: "inv1", description: "Field service labour", quantity: 1, unit_price: 100, line_total: 100, cost_center: "FIELD", gl_account_code: "SALES-SERVICE" }],
    company_profile: { company_name: "Orac Systems", legal_name: "Handon Enterprises (Pvt) Ltd" }
  };
}

function req(db, userId, id) {
  return { db, user: { id: userId }, params: { id } };
}

test("authorized sales user can load quote document data", () => {
  const db = makeDb();
  const res = makeRes();
  getQuoteDocument(req(db, "u_sales", "q1"), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.hierarchy.plant.name, "SMC Concentrator");
});

test("technician cannot load generic quote document data", () => {
  const db = makeDb();
  const res = makeRes();
  getQuoteDocument(req(db, "u_tech", "q1"), res);
  assert.equal(res.statusCode, 403);
});

test("client viewer cannot load another client's document", () => {
  const db = makeDb();
  const res = makeRes();
  getQuoteDocument(req(db, "u_client", "q2"), res);
  assert.equal(res.statusCode, 403);
});

test("client viewer without client_id is denied document access", () => {
  const db = makeDb();
  const res = makeRes();
  getQuoteDocument(req(db, "u_unscoped_client", "q1"), res);
  assert.equal(res.statusCode, 403);
});

test("technician can load assigned worksheet document", () => {
  const db = makeDb();
  const res = makeRes();
  getWorksheetDocument(req(db, "u_tech", "ws1"), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.technician.name, "Technician");
});

test("technician can load assigned job card through linked worksheet", () => {
  const db = makeDb();
  const res = makeRes();
  getDispatchDocument(req(db, "u_tech", "job1"), res);
  assert.equal(res.statusCode, 200);
});

test("invoice document refuses to render when PO becomes amendment-blocked", () => {
  const db = makeDb();
  db.purchase_orders[0].requires_amendment = true;
  const res = makeRes();
  getInvoiceDocument(req(db, "u_finance", "inv1"), res);
  assert.equal(res.statusCode, 409);
});
