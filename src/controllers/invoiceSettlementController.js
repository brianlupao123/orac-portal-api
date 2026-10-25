import { roles } from "../permissions.js";
import { activeInvoicePayments, invoiceTotalCents, paymentRequestHash, refreshSettlementStatus, settlementSummary } from "../invoiceSettlement.js";

function getActor(req) {
  return req.db.users.find((user) => user.id === req.user.id);
}

function canSettle(actor) {
  return actor && [roles.ADMIN, roles.FINANCE].includes(actor.role);
}

function canViewSettlement(actor) {
  return actor && [roles.ADMIN, roles.FINANCE, roles.MANAGEMENT].includes(actor.role);
}

function cents(value) {
  return Math.round(Number(value) * 100);
}

function rejectUnauthorized(res) {
  return res.status(403).json({ success: false, message: "Only Admin or Finance can record or reverse invoice payments." });
}

function findInvoice(req, res) {
  const invoice = req.db.invoices.find((item) => item.id === req.params.id);
  if (!invoice) {
    res.status(404).json({ success: false, message: "Invoice not found." });
    return null;
  }
  return invoice;
}

export const getInvoiceSettlement = (req, res) => {
  const actor = getActor(req);
  if (!canViewSettlement(actor)) {
    return res.status(403).json({ success: false, message: "Only Admin, Finance, or Management can view invoice settlement evidence." });
  }
  const invoice = findInvoice(req, res);
  if (!invoice) return;
  const payments = (req.db.invoice_payments || [])
    .filter((payment) => payment.invoice_id === invoice.id)
    .map(({ id, amount, currency, payment_method, reference, received_on, notes, recorded_by, recorded_at, voided_by, voided_at, void_reason }) => ({
      id, amount, currency, payment_method, reference, received_on, notes,
      recorded_by, recorded_at, voided_by, voided_at, void_reason
    }));
  return res.json({
    success: true,
    data: {
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number,
      status: invoice.status,
      settlement: settlementSummary(req.db, invoice),
      payments
    }
  });
};

export const recordInvoicePayment = (req, res) => {
  const actor = getActor(req);
  if (!canSettle(actor)) return rejectUnauthorized(res);
  const invoice = findInvoice(req, res);
  if (!invoice) return;
  if (String(invoice.status || "").toLowerCase() === "voided") {
    return res.status(409).json({ success: false, message: "A payment cannot be recorded against a voided invoice." });
  }
  if (!req.idempotencyKey) {
    return res.status(400).json({ success: false, code: "IDEMPOTENCY_KEY_REQUIRED", message: "Send an Idempotency-Key header when recording a payment." });
  }

  if (!Array.isArray(req.db.invoice_payments)) req.db.invoice_payments = [];
  const requestHash = paymentRequestHash(invoice.id, actor.id, req.body);
  const existingKey = req.db.invoice_payments.find((payment) =>
    payment.idempotency_key === req.idempotencyKey && payment.recorded_by === actor.id
  );
  if (existingKey) {
    if (existingKey.request_hash !== requestHash) {
      return res.status(409).json({ success: false, code: "IDEMPOTENCY_KEY_REUSED", message: "This Idempotency-Key was already used for a different payment request." });
    }
    return res.set("Idempotency-Replayed", "true").json({
      success: true,
      data: existingKey,
      settlement: settlementSummary(req.db, invoice),
      idempotent_replay: true
    });
  }

  const totalCents = invoiceTotalCents(invoice);
  if (totalCents === null) {
    return res.status(409).json({ success: false, code: "INVOICE_TOTAL_INVALID", message: "Invoice payment is blocked because the invoice total is invalid." });
  }
  const summary = settlementSummary(req.db, invoice);
  const amountCents = cents(req.body.amount);
  if (amountCents > cents(summary.outstanding_amount)) {
    return res.status(409).json({ success: false, code: "PAYMENT_EXCEEDS_OUTSTANDING", message: "Payment exceeds the invoice outstanding balance." });
  }
  const duplicateReference = req.db.invoice_payments.find((payment) =>
    !payment.voided_at && payment.reference.toLowerCase() === req.body.reference.trim().toLowerCase()
  );
  if (duplicateReference) {
    return res.status(409).json({ success: false, code: "PAYMENT_REFERENCE_EXISTS", message: "An active payment already uses this receipt reference." });
  }

  const before = { ...invoice };
  const payment = {
    id: req.store.id("pay"),
    invoice_id: invoice.id,
    amount: amountCents / 100,
    currency: "USD",
    payment_method: req.body.payment_method,
    reference: req.body.reference.trim(),
    received_on: req.body.received_on,
    notes: req.body.notes?.trim() || null,
    recorded_by: actor.id,
    recorded_at: new Date().toISOString(),
    idempotency_key: req.idempotencyKey,
    request_hash: requestHash
  };
  req.db.invoice_payments.push(payment);
  const settlement = refreshSettlementStatus(req.db, invoice);
  req.store.audit(req.db, actor, "invoice_payment", payment.id, "INVOICE_PAYMENT_RECORDED", null, payment);
  req.store.audit(req.db, actor, "invoice", invoice.id, "INVOICE_SETTLEMENT_UPDATED", before, invoice);
  return res.status(201).json({ success: true, data: payment, settlement });
};

export const voidInvoicePayment = (req, res) => {
  const actor = getActor(req);
  if (!canSettle(actor)) return rejectUnauthorized(res);
  const invoice = findInvoice(req, res);
  if (!invoice) return;
  const payment = (req.db.invoice_payments || []).find((item) => item.id === req.params.paymentId && item.invoice_id === invoice.id);
  if (!payment) return res.status(404).json({ success: false, message: "Invoice payment not found." });
  if (payment.voided_at) return res.status(409).json({ success: false, message: "Invoice payment is already reversed." });

  const beforePayment = { ...payment };
  const beforeInvoice = { ...invoice };
  payment.voided_at = new Date().toISOString();
  payment.voided_by = actor.id;
  payment.void_reason = req.body.reason.trim();
  const settlement = refreshSettlementStatus(req.db, invoice);
  req.store.audit(req.db, actor, "invoice_payment", payment.id, "INVOICE_PAYMENT_REVERSED", beforePayment, payment);
  req.store.audit(req.db, actor, "invoice", invoice.id, "INVOICE_SETTLEMENT_UPDATED", beforeInvoice, invoice);
  return res.json({ success: true, data: payment, settlement });
};
