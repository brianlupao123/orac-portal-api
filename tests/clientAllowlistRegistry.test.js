import assert from "node:assert/strict";
import test from "node:test";
import { roles } from "../src/permissions.js";
import {
  shapeQuoteForClient,
  shapeWorksheetForClient,
  shapeInvoiceForClient,
  shapePoForClient,
  shapeDocumentForClient
} from "../src/clientAllowlist.js";
import {
  getQuoteDocument,
  getWorksheetDocument,
  getInvoiceDocument,
  getPoDocument
} from "../src/controllers/documentController.js";

function makeMockResponse() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
  return res;
}

function makeDbFixture() {
  return {
    users: [
      { id: "u_admin", role: roles.ADMIN, is_active: true, name: "Admin User" },
      { id: "u_client", role: roles.CLIENT_VIEWER, is_active: true, client_id: "c_1", name: "Client Viewer" },
      { id: "u_tech", role: roles.TECHNICIAN, is_active: true, name: "Lead Artisan", hourly_rate: 45.00, national_id: "63-123456-X" }
    ],
    clients: [
      { id: "c_1", name: "Mimosa Mining", contact_person: "John Doe", email: "john@mimosa.com", is_active: true }
    ],
    quotes: [
      {
        id: "q_1",
        quote_number: "Q-2026-101",
        client_id: "c_1",
        status: "Sent",
        total_amount: 15000,
        scope_of_work: "Crusher motor overhaul",
        created_at: "2026-11-01T08:00:00Z",
        internal_margin: 0.35,
        secret_cost_markup: 1.2
      }
    ],
    quote_lines: [
      {
        id: "ql_1",
        quotation_id: "q_1",
        item_code: "SRV-OH",
        description: "Motor rewind and bearing fit",
        quantity: 1,
        total_price: 15000,
        internal_buy_cost: 9500
      }
    ],
    equipment_tags: [
      { id: "eq_1", tag: "CRUSH-MOT-01", description: "Primary Gyratory Motor 400kW" }
    ],
    plant_sections: [],
    plants: [],
    mine_sites: [],
    company_profile: {
      company_name: "Orac Systems",
      physical_address: "Harare Industrial Park",
      bank_account_number: "SECRET_ACCOUNT_998877"
    },
    purchase_orders: [
      {
        id: "po_1",
        quotation_id: "q_1",
        po_reference: "PO-MIMOSA-8899",
        po_amount: 15000,
        status: "verified",
        requires_amendment: false,
        verified_at: "2026-11-02T10:00:00Z"
      }
    ],
    dispatch_cards: [
      {
        id: "d_1",
        quotation_id: "q_1",
        purchase_order_id: "po_1",
        dispatch_number: "DISP-2026-101",
        equipment_tag_id: "eq_1",
        status: "active"
      }
    ],
    field_worksheets: [
      {
        id: "ws_1",
        dispatch_card_id: "d_1",
        technician_id: "u_tech",
        work_date: "2026-11-05",
        status: "Supervisor_Approved",
        hours: 12,
        work_description: "Field alignment and dynamic balancing",
        timesheet_version: 2,
        superseded_by: null,
        internal_worker_rate: 35.00,
        payroll_secret_flag: true
      }
    ],
    invoices: [
      {
        id: "inv_1",
        invoice_number: "INV-2026-101",
        quotation_id: "q_1",
        purchase_order_id: "po_1",
        dispatch_card_id: "d_1",
        status: "Approved",
        invoice_date: "2026-11-06",
        total_amount: 15000,
        internal_gl_code: "GL-4001-REV",
        gross_profit_margin: 0.38
      }
    ],
    invoice_lines: [
      {
        id: "inl_1",
        invoice_id: "inv_1",
        description: "Crusher motor overhaul complete",
        quantity: 1,
        total_price: 15000
      }
    ]
  };
}

test("Lane 7 Client Viewer Allowlist Unit: shapeQuoteForClient strictly projects allowlist and blocks internal margins", () => {
  const db = makeDbFixture();
  const rawDoc = {
    quote: db.quotes[0],
    client: db.clients[0],
    lines: db.quote_lines,
    equipment: db.equipment_tags[0],
    company_profile: db.company_profile
  };

  const shaped = shapeQuoteForClient(rawDoc);

  assert.equal(shaped.quote.quote_number, "Q-2026-101");
  assert.equal(shaped.quote.currency, "USD");
  assert.equal(shaped.quote.internal_margin, undefined, "internal_margin must be omitted");
  assert.equal(shaped.quote.secret_cost_markup, undefined, "secret_cost_markup must be omitted");
  assert.equal(shaped.lines[0].internal_buy_cost, undefined, "line internal_buy_cost must be omitted");
  assert.equal(shaped.company_profile.bank_account_number, undefined, "company bank details must be omitted");
});

test("Lane 7 Client Viewer Allowlist Unit: shapeWorksheetForClient omits technician identity, pay rates, and PII", () => {
  const db = makeDbFixture();
  const rawDoc = {
    worksheet: db.field_worksheets[0],
    client: db.clients[0],
    job: db.dispatch_cards[0],
    technician: db.users[2],
    company_profile: db.company_profile
  };

  const shaped = shapeWorksheetForClient(rawDoc);

  assert.equal(shaped.worksheet.hours, 12);
  assert.equal(shaped.worksheet.work_description, "Field alignment and dynamic balancing");
  assert.equal(shaped.worksheet.internal_worker_rate, undefined, "internal_worker_rate must be omitted");
  assert.equal(shaped.worksheet.payroll_secret_flag, undefined, "payroll_secret_flag must be omitted");
  assert.equal(shaped.technician, undefined, "technician user object must never appear in client view");
});

test("Lane 7 Client Viewer Allowlist Controller: getQuoteDocument shapes for Client Viewer and returns full for Admin", () => {
  const db = makeDbFixture();

  // 1. Client Viewer request
  const reqClient = {
    db,
    user: { id: "u_client" },
    params: { id: "q_1" }
  };
  const resClient = makeMockResponse();
  getQuoteDocument(reqClient, resClient);

  assert.equal(resClient.statusCode, 200);
  assert.equal(resClient.body.success, true);
  const clientData = resClient.body.data;
  assert.equal(clientData.quote.internal_margin, undefined);
  assert.equal(clientData.company_profile.bank_account_number, undefined);

  // 2. Admin request
  const reqAdmin = {
    db,
    user: { id: "u_admin" },
    params: { id: "q_1" }
  };
  const resAdmin = makeMockResponse();
  getQuoteDocument(reqAdmin, resAdmin);

  assert.equal(resAdmin.statusCode, 200);
  assert.equal(resAdmin.body.success, true);
  const adminData = resAdmin.body.data;
  assert.equal(adminData.quote.internal_margin, 0.35, "Admin receives raw database record");
});

test("Lane 7 Client Viewer Allowlist Controller: getWorksheetDocument shapes for Client Viewer and hides technician", () => {
  const db = makeDbFixture();

  // 1. Client Viewer request
  const reqClient = {
    db,
    user: { id: "u_client" },
    params: { id: "ws_1" }
  };
  const resClient = makeMockResponse();
  getWorksheetDocument(reqClient, resClient);

  assert.equal(resClient.statusCode, 200);
  assert.equal(resClient.body.success, true);
  const clientData = resClient.body.data;
  assert.equal(clientData.technician, undefined, "technician must be omitted for Client Viewer");
  assert.equal(clientData.worksheet.internal_worker_rate, undefined);

  // 2. Admin request
  const reqAdmin = {
    db,
    user: { id: "u_admin" },
    params: { id: "ws_1" }
  };
  const resAdmin = makeMockResponse();
  getWorksheetDocument(reqAdmin, resAdmin);

  assert.equal(resAdmin.statusCode, 200);
  assert.equal(resAdmin.body.success, true);
  const adminData = resAdmin.body.data;
  assert.ok(adminData.technician, "Admin sees technician user");
  assert.equal(adminData.technician.name, "Lead Artisan");
});

test("Lane 7 Client Viewer Allowlist Controller: getInvoiceDocument shapes for Client Viewer and hides internal margins and GL codes", () => {
  const db = makeDbFixture();

  // 1. Client Viewer request
  const reqClient = {
    db,
    user: { id: "u_client" },
    params: { id: "inv_1" }
  };
  const resClient = makeMockResponse();
  getInvoiceDocument(reqClient, resClient);

  assert.equal(resClient.statusCode, 200);
  assert.equal(resClient.body.success, true);
  const clientData = resClient.body.data;
  assert.equal(clientData.invoice.gross_profit_margin, undefined, "margin omitted for client");
  assert.equal(clientData.invoice.internal_gl_code, undefined, "GL code omitted for client");
  assert.equal(clientData.invoice.currency, "USD");

  // 2. Admin request
  const reqAdmin = {
    db,
    user: { id: "u_admin" },
    params: { id: "inv_1" }
  };
  const resAdmin = makeMockResponse();
  getInvoiceDocument(reqAdmin, resAdmin);

  assert.equal(resAdmin.statusCode, 200);
  assert.equal(resAdmin.body.success, true);
  const adminData = resAdmin.body.data;
  assert.equal(adminData.invoice.gross_profit_margin, 0.38, "Admin sees raw invoice data");
});

test("Lane 7 Client Viewer Allowlist Controller: getPoDocument shapes for Client Viewer and retains customer reference", () => {
  const db = makeDbFixture();

  // 1. Client Viewer request
  const reqClient = {
    db,
    user: { id: "u_client" },
    params: { id: "po_1" }
  };
  const resClient = makeMockResponse();
  getPoDocument(reqClient, resClient);

  assert.equal(resClient.statusCode, 200);
  assert.equal(resClient.body.success, true);
  const clientData = resClient.body.data;
  assert.equal(clientData.po.po_reference, "PO-MIMOSA-8899");

  // 2. Admin request
  const reqAdmin = {
    db,
    user: { id: "u_admin" },
    params: { id: "po_1" }
  };
  const resAdmin = makeMockResponse();
  getPoDocument(reqAdmin, resAdmin);

  assert.equal(resAdmin.statusCode, 200);
  assert.equal(resAdmin.body.success, true);
  const adminData = resAdmin.body.data;
  assert.equal(adminData.po.po_reference, "PO-MIMOSA-8899");
});
