import { randomUUID } from "node:crypto";

const apiBase = process.env.ORAC_PHASE5_UAT_API_URL || "http://127.0.0.1:5050/api";
const parsed = new URL(apiBase);
if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
  throw new Error("Phase 5 browser UAT setup only permits a loopback API URL.");
}

const password = "OracUAT2026!";
const preparerEmail = "phase5-uat-finance@fixture.invalid";
const reviewerEmail = "phase5-uat-finance-reviewer@fixture.invalid";

async function login(email) {
  const response = await fetch(`${apiBase}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Login failed for ${email}: ${payload.message || response.status}`);
  return payload.data.token;
}

async function request(path, token, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status} ${payload.message || "Unknown error"}`);
  return payload.data;
}

const preparerToken = await login(preparerEmail);
const reviewerToken = await login(reviewerEmail);

const draft = await request("/dispatch_cards/phase5-uat-dispatch/legacy-invoice-drafts", preparerToken, {
  method: "POST",
  body: { idempotency_key: randomUUID() }
});
const invoice = await request(`/legacy-invoice-drafts/${draft.id}/issue`, reviewerToken, {
  method: "POST",
  body: { idempotency_key: randomUUID() }
});
const receipt = await request(`/invoices/${invoice.id}/payments`, preparerToken, {
  method: "POST",
  headers: { "Idempotency-Key": randomUUID() },
  body: {
    amount: 800,
    payment_method: "bank_transfer",
    reference: "UAT-PHASE5-RECEIPT-001",
    received_on: "2026-10-26",
    notes: "Fictional browser-UAT receipt"
  }
});
await request(`/invoices/${invoice.id}/payments/${receipt.id}/void`, reviewerToken, {
  method: "POST",
  body: { reason: "Fictional UAT reversal before credit-note test" }
});

console.log(JSON.stringify({
  fictional: true,
  invoice_id: invoice.id,
  invoice_number: invoice.invoice_number,
  total_usd: invoice.total_amount,
  reversed_receipt: "UAT-PHASE5-RECEIPT-001",
  outstanding_usd: 800
}, null, 2));
