import { createHash } from "node:crypto";

const cents = (value) => Math.round(Number(value) * 100);

export function invoiceTotalCents(invoice) {
  const total = Number(invoice?.total_amount);
  return Number.isFinite(total) && total > 0 ? cents(total) : null;
}

export function activeInvoicePayments(db, invoiceId) {
  return (db.invoice_payments || []).filter((payment) =>
    payment.invoice_id === invoiceId && !payment.voided_at
  );
}

export function issuedInvoiceCreditNotes(db, invoiceId) {
  return (db.invoice_credit_notes || []).filter((note) =>
    note.invoice_id === invoiceId && note.status === "issued"
  );
}

export function settlementSummary(db, invoice) {
  const totalCents = invoiceTotalCents(invoice);
  if (totalCents === null) return null;
  const paidCents = activeInvoicePayments(db, invoice.id)
    .reduce((sum, payment) => sum + cents(payment.amount), 0);
  const creditedCents = issuedInvoiceCreditNotes(db, invoice.id)
    .reduce((sum, note) => sum + cents(note.amount), 0);
  const effectiveTotalCents = Math.max(0, totalCents - creditedCents);
  return {
    currency: "USD",
    total_amount: totalCents / 100,
    paid_amount: paidCents / 100,
    credited_amount: creditedCents / 100,
    effective_total_amount: effectiveTotalCents / 100,
    outstanding_amount: Math.max(0, effectiveTotalCents - paidCents) / 100,
    payment_count: activeInvoicePayments(db, invoice.id).length,
    credit_note_count: issuedInvoiceCreditNotes(db, invoice.id).length
  };
}

export function refreshSettlementStatus(db, invoice) {
  const summary = settlementSummary(db, invoice);
  if (!summary) return null;
  if (summary.paid_amount === 0) invoice.status = "sent";
  else if (summary.outstanding_amount === 0) invoice.status = "paid";
  else invoice.status = "partially_paid";
  return summary;
}

export function paymentRequestHash(invoiceId, actorId, body) {
  return createHash("sha256").update(JSON.stringify([
    "invoice.payment.v1",
    invoiceId,
    actorId,
    Number(body.amount),
    body.payment_method,
    body.reference.trim(),
    body.received_on,
    body.notes?.trim() || ""
  ])).digest("hex");
}

export function creditNoteRequestHash(invoiceId, actorId, body) {
  return createHash("sha256").update(JSON.stringify([
    "invoice.credit-note.v1",
    invoiceId,
    actorId,
    Number(body.amount),
    body.reason.trim()
  ])).digest("hex");
}
