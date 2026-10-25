import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { getInvoiceSettlement, recordInvoicePayment, voidInvoicePayment } from "../src/controllers/invoiceSettlementController.js";
import { RecordInvoicePaymentSchema, VoidInvoicePaymentSchema } from "../src/schemas.js";

const finance = { id: "finance-1", role: "Finance", is_active: true };

function response() {
  return {
    statusCode: 200,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(body) { this.body = body; return this; }
  };
}

function request({ actor = finance, body = {}, idempotencyKey = "11111111-1111-4111-8111-111111111111", paymentId } = {}) {
  const audit = [];
  const db = {
    users: [actor],
    invoices: [{ id: "inv-1", status: "sent", total_amount: 100 }],
    invoice_payments: [],
    audit_logs: audit
  };
  return {
    user: { id: actor.id }, params: { id: "inv-1", paymentId }, idempotencyKey,
    body: { amount: 40, payment_method: "bank_transfer", reference: "BANK-REF-001", received_on: "2026-10-20", ...body },
    db,
    store: {
      id(prefix) { return `${prefix}-${db.invoice_payments.length + 1}`; },
      audit(_db, auditActor, entityType, entityId, action, before, after) { audit.push({ auditActor, entityType, entityId, action, before, after }); }
    }
  };
}

test("Finance records a partial USD receipt and a later receipt settles the invoice", () => {
  const req = request();
  const first = response();
  recordInvoicePayment(req, first);
  assert.equal(first.statusCode, 201);
  assert.equal(req.db.invoices[0].status, "partially_paid");
  assert.deepEqual(first.body.settlement, { currency: "USD", total_amount: 100, paid_amount: 40, outstanding_amount: 60, payment_count: 1 });

  req.body = { amount: 60, payment_method: "bank_transfer", reference: "BANK-REF-002", received_on: "2026-10-21" };
  req.idempotencyKey = "22222222-2222-4222-8222-222222222222";
  const second = response();
  recordInvoicePayment(req, second);
  assert.equal(second.statusCode, 201);
  assert.equal(req.db.invoices[0].status, "paid");
  assert.equal(second.body.settlement.outstanding_amount, 0);
  assert.deepEqual(req.db.audit_logs.map((entry) => entry.action), ["INVOICE_PAYMENT_RECORDED", "INVOICE_SETTLEMENT_UPDATED", "INVOICE_PAYMENT_RECORDED", "INVOICE_SETTLEMENT_UPDATED"]);
});

test("payment retries replay, while changed payloads and overpayments are refused", () => {
  const req = request();
  recordInvoicePayment(req, response());
  const replay = response();
  recordInvoicePayment(req, replay);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.headers["Idempotency-Replayed"], "true");
  assert.equal(req.db.invoice_payments.length, 1);

  req.body = { ...req.body, amount: 50 };
  const conflict = response();
  recordInvoicePayment(req, conflict);
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.code, "IDEMPOTENCY_KEY_REUSED");

  req.idempotencyKey = "22222222-2222-4222-8222-222222222222";
  req.body = { ...req.body, amount: 61, reference: "BANK-REF-002" };
  const overpayment = response();
  recordInvoicePayment(req, overpayment);
  assert.equal(overpayment.statusCode, 409);
  assert.equal(overpayment.body.code, "PAYMENT_EXCEEDS_OUTSTANDING");
});

test("only Finance/Admin can settle, and a reasoned reversal restores the outstanding balance", () => {
  const req = request();
  recordInvoicePayment(req, response());

  const unauthorized = request({ actor: { id: "sales-1", role: "Sales", is_active: true } });
  const unauthorizedResponse = response();
  recordInvoicePayment(unauthorized, unauthorizedResponse);
  assert.equal(unauthorizedResponse.statusCode, 403);

  req.params.paymentId = "pay-1";
  req.body = { reason: "Bank receipt was entered against the wrong invoice" };
  const reversal = response();
  voidInvoicePayment(req, reversal);
  assert.equal(reversal.statusCode, 200);
  assert.equal(req.db.invoices[0].status, "sent");
  assert.equal(reversal.body.settlement.outstanding_amount, 100);
  assert.equal(req.db.invoice_payments[0].void_reason, "Bank receipt was entered against the wrong invoice");
});

test("a payment needs a retry key and cannot be recorded for a voided invoice", () => {
  const missingKey = request({ idempotencyKey: null });
  const missingKeyResponse = response();
  recordInvoicePayment(missingKey, missingKeyResponse);
  assert.equal(missingKeyResponse.statusCode, 400);
  assert.equal(missingKeyResponse.body.code, "IDEMPOTENCY_KEY_REQUIRED");

  const voided = request();
  voided.db.invoices[0].status = "voided";
  const voidedResponse = response();
  recordInvoicePayment(voided, voidedResponse);
  assert.equal(voidedResponse.statusCode, 409);
});

test("settlement routes are authenticated, validated, idempotent on record, and not generic collection endpoints", async () => {
  const validPayment = RecordInvoicePaymentSchema.safeParse({
    amount: 12.5,
    payment_method: "bank_transfer",
    reference: "BANK-REF-123",
    received_on: "2026-10-20"
  });
  assert.equal(validPayment.success, true);
  assert.equal(RecordInvoicePaymentSchema.safeParse({ ...validPayment.data, amount: 0 }).success, false);
  assert.equal(VoidInvoicePaymentSchema.safeParse({ reason: "Wrong statement line" }).success, true);
  assert.equal(VoidInvoicePaymentSchema.safeParse({ reason: "" }).success, false);

  const router = await readFile(new URL("../src/router.js", import.meta.url), "utf8");
  assert.match(router, /router\.post\("\/invoices\/:id\/payments", idempotencyKeyMiddleware, validate\(RecordInvoicePaymentSchema\), recordInvoicePayment\)/);
  assert.match(router, /router\.post\("\/invoices\/:id\/payments\/:paymentId\/void", validate\(VoidInvoicePaymentSchema\), voidInvoicePayment\)/);
  assert.match(router, /router\.get\("\/invoices\/:id\/settlement", getInvoiceSettlement\)/);
  assert.doesNotMatch(router, /"invoice_payments"/);
});

test("settlement evidence is visible to Finance, Admin, and Management only", () => {
  const req = request();
  recordInvoicePayment(req, response());

  const financeView = response();
  getInvoiceSettlement(req, financeView);
  assert.equal(financeView.statusCode, 200);
  assert.equal(financeView.body.data.settlement.outstanding_amount, 60);
  assert.equal(financeView.body.data.payments[0].request_hash, undefined);
  assert.equal(financeView.body.data.payments[0].idempotency_key, undefined);

  req.user = { id: "management-1" };
  req.db.users.push({ id: "management-1", role: "Management", is_active: true });
  const managementView = response();
  getInvoiceSettlement(req, managementView);
  assert.equal(managementView.statusCode, 200);

  req.user = { id: "sales-1" };
  req.db.users.push({ id: "sales-1", role: "Sales", is_active: true });
  const salesView = response();
  getInvoiceSettlement(req, salesView);
  assert.equal(salesView.statusCode, 403);
});
