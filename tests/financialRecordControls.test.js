import test from "node:test";
import assert from "node:assert/strict";

import { deactivateEntity, reactivateEntity, voidInvoice } from "../src/controllers/coreController.js";

function createResponse() {
  return {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function createRequest(actor, { invoiceStatus = "sent", reason = "Duplicate invoice" } = {}) {
  const auditEntries = [];
  const db = {
    users: [actor],
    clients: [{ id: "client-1", is_active: true }],
    invoices: [{ id: "invoice-1", status: invoiceStatus, total_amount: 100 }],
    purchase_orders: [{ id: "po-1", status: "verified" }],
    audit_logs: auditEntries
  };
  return {
    user: { id: actor.id },
    params: { id: invoiceStatus === "purchase-order" ? "po-1" : invoiceStatus === "client" ? "client-1" : "invoice-1" },
    body: { reason },
    db,
    store: {
      audit(_db, auditActor, entityType, entityId, action, before, after) {
        auditEntries.push({ auditActor, entityType, entityId, action, before, after });
      }
    }
  };
}

test("generic archive rejects transactional and financial records", () => {
  const admin = { id: "admin-1", role: "Admin", is_active: true };
  const req = createRequest(admin);
  const res = createResponse();

  deactivateEntity("invoices")(req, res);

  assert.equal(res.statusCode, 405);
  assert.equal(req.db.invoices[0].status, "sent");
  assert.equal(req.db.invoices[0].is_active, undefined);
});

test("generic archive and reactivate remain available for permitted master data", () => {
  const management = { id: "management-1", role: "Management", is_active: true };
  const req = createRequest(management, { invoiceStatus: "client" });
  const archiveResponse = createResponse();

  deactivateEntity("clients")(req, archiveResponse);
  assert.equal(archiveResponse.statusCode, 200);
  assert.equal(req.db.clients[0].is_active, false);

  const reactivateResponse = createResponse();
  reactivateEntity("clients")(req, reactivateResponse);
  assert.equal(reactivateResponse.statusCode, 200);
  assert.equal(req.db.clients[0].is_active, true);
});

test("Finance can void an eligible invoice with a required reason and audit record", () => {
  const finance = { id: "finance-1", role: "Finance", is_active: true };
  const req = createRequest(finance, { reason: "Duplicate invoice reference" });
  const res = createResponse();

  voidInvoice(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(req.db.invoices[0].status, "voided");
  assert.equal(req.db.invoices[0].void_reason, "Duplicate invoice reference");
  assert.equal(req.db.audit_logs[0].action, "INVOICE_VOIDED");
});

test("invoice void rejects missing reason, paid invoices, and unauthorized roles", () => {
  const finance = { id: "finance-1", role: "Finance", is_active: true };
  const missingReason = createRequest(finance, { reason: "" });
  const missingReasonResponse = createResponse();
  voidInvoice(missingReason, missingReasonResponse);
  assert.equal(missingReasonResponse.statusCode, 400);

  const paidInvoice = createRequest(finance, { invoiceStatus: "Paid" });
  const paidResponse = createResponse();
  voidInvoice(paidInvoice, paidResponse);
  assert.equal(paidResponse.statusCode, 409);

  const sales = { id: "sales-1", role: "Sales", is_active: true };
  const unauthorized = createRequest(sales);
  const unauthorizedResponse = createResponse();
  voidInvoice(unauthorized, unauthorizedResponse);
  assert.equal(unauthorizedResponse.statusCode, 403);
});
