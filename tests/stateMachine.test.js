import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../src/store.js";
import { issueLegacyInvoice, transitionQuote } from "../src/stateMachine.js";

function makeDb() {
  const store = createStore(":memory:");
  const db = {
    users: [
      { id: "u_admin", role: "Admin", is_active: true },
      { id: "u_finance", role: "Finance", is_active: true },
      { id: "u_sales", role: "Sales", is_active: true },
      { id: "u_client", role: "Client Viewer", is_active: true }
    ],
    clients: [{ id: "c1", name: "Zimplats" }],
    quote_lines: [{ id: "l1", quotation_id: "q1", description: "Labour", quantity: 1, unit_price: 100, line_total: 100 }],
    quotes: [{ id: "q1", quote_number: "Q-0001", client_id: "c1", equipment_tag_id: "eq1", status: "Draft", total_amount: 100 }],
    purchase_orders: [],
    dispatch_cards: [],
    field_worksheets: [],
    timesheets: [],
    material_usage: [],
    invoices: [],
    invoice_lines: [],
    audit_logs: []
  };
  return { db, store, actor: db.users[0] };
}

test("refuses direct Draft to Invoiced transition", () => {
  const { db, store, actor } = makeDb();
  assert.throws(
    () => transitionQuote(db, store, "q1", "Invoiced", {}, actor),
    /controlled invoice draft/
  );
});

test("blocks dispatch without a verified PO, including urgent pre-PO requests", () => {
  const { db, store, actor } = makeDb();
  transitionQuote(db, store, "q1", "Sent", {}, db.users.find((u) => u.role === "Sales"));
  transitionQuote(db, store, "q1", "Approved_Pending_PO", {}, actor);
  assert.throws(() => transitionQuote(db, store, "q1", "Field_Dispatch", {}, actor), /Illegal transition: Approved_Pending_PO -> Field_Dispatch/);
  assert.throws(() => transitionQuote(db, store, "q1", "PO_Verified", {}, actor), /A verified PO with reference and amount is required/);
  db.purchase_orders.push({ id: "po1", quotation_id: "q1", po_reference: "PO-ZIM-001", po_amount: 200, status: "verified" });
  transitionQuote(db, store, "q1", "PO_Verified", {}, actor);
  assert.throws(() => transitionQuote(db, store, "q1", "Field_Dispatch", { started_before_po: true, urgent_reason: "Plant stoppage" }, actor), /Urgent pre-PO dispatch is not permitted/);
  assert.equal(db.dispatch_cards.length, 0);
});

test("does not dispatch against a pending client-submitted PO", () => {
  const { db, store, actor } = makeDb();
  transitionQuote(db, store, "q1", "Sent", {}, db.users.find((u) => u.role === "Sales"));
  transitionQuote(db, store, "q1", "Approved_Pending_PO", {}, actor);
  db.purchase_orders.push({ id: "po1", quotation_id: "q1", po_reference: "PO-ZIM-001", po_amount: 200, status: "pending" });
  assert.throws(() => transitionQuote(db, store, "q1", "Field_Dispatch", {}, actor), /Illegal transition: Approved_Pending_PO -> Field_Dispatch/);
  assert.throws(() => transitionQuote(db, store, "q1", "PO_Verified", {}, actor), /A verified PO with reference and amount is required/);
  assert.equal(db.dispatch_cards.length, 0);
});

test("allows full path when PO is verified and no amendment is required", () => {
  const { db, store, actor } = makeDb();
  transitionQuote(db, store, "q1", "Sent", {}, db.users.find((u) => u.role === "Sales"));
  transitionQuote(db, store, "q1", "Approved_Pending_PO", {}, actor);
  db.purchase_orders.push({
    id: "po1",
    quotation_id: "q1",
    po_reference: "PO-ZIM-001",
    po_amount: 200,
    status: "verified",
    requires_amendment: false
  });
  transitionQuote(db, store, "q1", "PO_Verified", {}, actor);
  transitionQuote(db, store, "q1", "Field_Dispatch", {}, actor);
  db.field_worksheets.push({
    id: "ws1",
    dispatch_card_id: db.dispatch_cards[0].id,
    status: "Supervisor_Approved",
    activity: "Work inspected",
    hours: 1
  });
  const result = issueLegacyInvoice(db, store, "q1", actor);

  assert.equal(db.quotes[0].status, "Invoiced");
  assert.equal(db.invoices.length, 1);
});

test("blocks an invoice above the verified PO amount even if the amendment flag is stale", () => {
  const { db, store, actor } = makeDb();
  transitionQuote(db, store, "q1", "Sent", {}, db.users.find((u) => u.role === "Sales"));
  transitionQuote(db, store, "q1", "Approved_Pending_PO", {}, actor);
  db.purchase_orders.push({ id: "po1", quotation_id: "q1", po_reference: "PO-ZIM-001", po_amount: 100, status: "verified", requires_amendment: false });
  transitionQuote(db, store, "q1", "PO_Verified", {}, actor);
  transitionQuote(db, store, "q1", "Field_Dispatch", {}, actor);
  const job = db.dispatch_cards[0];
  db.field_worksheets.push({ id: "ws1", dispatch_card_id: job.id, status: "Supervisor_Approved", hours: 2 });
  db.timesheets.push({ id: "ts1", dispatch_card_id: job.id, hours_logged: 2, hourly_rate: 60 });
  const before = structuredClone(db);

  assert.throws(
    () => issueLegacyInvoice(db, store, "q1", actor),
    (error) => error.code === "INVOICE_EXCEEDS_PO_REMAINING" && error.status === 409
  );
  assert.deepEqual(db, before, "a refused invoice leaves the quote and financial records unchanged");
});

test("blocks V5 invoice generation before legacy rate rows can be billed", () => {
  const { db, store, actor } = makeDb();
  db.quotes[0].v5_commercial_workflow = true;
  transitionQuote(db, store, "q1", "Sent", {}, db.users.find((u) => u.role === "Sales"));
  transitionQuote(db, store, "q1", "Approved_Pending_PO", {}, actor);
  db.purchase_orders.push({ id: "po1", quotation_id: "q1", po_reference: "PO-ZIM-001", po_amount: 200, status: "verified", requires_amendment: false });
  transitionQuote(db, store, "q1", "PO_Verified", {}, actor);
  transitionQuote(db, store, "q1", "Field_Dispatch", {}, actor);
  db.field_worksheets.push({ id: "ws1", dispatch_card_id: db.dispatch_cards[0].id, status: "Supervisor_Approved", hours: 8 });
  db.timesheets.push({ id: "legacy-rate-row", dispatch_card_id: db.dispatch_cards[0].id, hours_logged: 8, hourly_rate: 999 });
  const before = structuredClone(db);

  assert.throws(
    () => issueLegacyInvoice(db, store, "q1", actor),
    (error) => error.code === "V5_INVOICE_CALCULATION_UNAVAILABLE" && /pricing review only/.test(error.message)
  );
  assert.deepEqual(db, before, "a refused V5 invoice leaves the quote, Timesheets, locks, invoices and audit trail unchanged");
});

test("blocks invoice when PO amendment is required", () => {
  const { db, store, actor } = makeDb();
  transitionQuote(db, store, "q1", "Sent", {}, db.users.find((u) => u.role === "Sales"));
  transitionQuote(db, store, "q1", "Approved_Pending_PO", {}, actor);
  db.purchase_orders.push({
    id: "po1",
    quotation_id: "q1",
    po_reference: "PO-ZIM-001",
    po_amount: 50,
    status: "verified",
    requires_amendment: true
  });
  transitionQuote(db, store, "q1", "PO_Verified", {}, actor);
  transitionQuote(db, store, "q1", "Field_Dispatch", {}, actor);
  db.field_worksheets.push({
    id: "ws1",
    dispatch_card_id: db.dispatch_cards[0].id,
    status: "Supervisor_Approved",
    activity: "Work inspected",
    hours: 1
  });

  assert.throws(
    () => issueLegacyInvoice(db, store, "q1", actor),
    /requires an approved PO amendment/
  );
});

test("rejects client viewer from sending quotes", () => {
  const { db, store } = makeDb();
  const clientViewer = db.users.find((user) => user.role === "Client Viewer");

  assert.throws(
    () => transitionQuote(db, store, "q1", "Sent", {}, clientViewer),
    /cannot perform sendQuote/
  );
});

test("rejects sales user from invoicing", () => {
  const { db, store } = makeDb();
  const admin = db.users.find((user) => user.role === "Admin");
  const sales = db.users.find((user) => user.role === "Sales");

  transitionQuote(db, store, "q1", "Sent", {}, sales);
  transitionQuote(db, store, "q1", "Approved_Pending_PO", { approval_exception_reason: "Sales approver unavailable during client operational deadline." }, admin);
  db.purchase_orders.push({
    id: "po1",
    quotation_id: "q1",
    po_reference: "PO-ZIM-001",
    po_amount: 200,
    status: "verified",
    requires_amendment: false
  });
  transitionQuote(db, store, "q1", "PO_Verified", {}, admin);
  transitionQuote(db, store, "q1", "Field_Dispatch", {}, admin);
  db.field_worksheets.push({
    id: "ws1",
    dispatch_card_id: db.dispatch_cards[0].id,
    status: "Supervisor_Approved",
    activity: "Work inspected",
    hours: 1
  });

  assert.throws(
    () => issueLegacyInvoice(db, store, "q1", sales),
    /cannot perform invoice/
  );
});

test("blocks invoice without supervisor-approved worksheet", () => {
  const { db, store, actor } = makeDb();
  transitionQuote(db, store, "q1", "Sent", {}, db.users.find((u) => u.role === "Sales"));
  transitionQuote(db, store, "q1", "Approved_Pending_PO", { approval_exception_reason: "Sales approver unavailable during client operational deadline." }, actor);
  db.purchase_orders.push({
    id: "po1",
    quotation_id: "q1",
    po_reference: "PO-ZIM-001",
    po_amount: 200,
    status: "verified",
    requires_amendment: false
  });
  transitionQuote(db, store, "q1", "PO_Verified", {}, actor);
  transitionQuote(db, store, "q1", "Field_Dispatch", {}, actor);

  assert.throws(
    () => issueLegacyInvoice(db, store, "q1", actor),
    /supervisor-approved worksheet is required/
  );
});

test("blocks a Sales user from approving the quote they personally sent", () => {
  const { db, store } = makeDb();
  const sales = db.users.find((user) => user.role === "Sales");

  transitionQuote(db, store, "q1", "Sent", {}, sales);
  assert.equal(db.quotes.find((q) => q.id === "q1").sent_by, sales.id);

  assert.throws(
    () => transitionQuote(db, store, "q1", "Approved_Pending_PO", {}, sales),
    /Sales cannot approve a quote they personally sent/
  );
});

test("allows a different Sales colleague to approve a quote they did not send", () => {
  const { db, store } = makeDb();
  const sales = db.users.find((user) => user.role === "Sales");
  const otherSales = { id: "u_sales2", role: "Sales", is_active: true };
  db.users.push(otherSales);

  transitionQuote(db, store, "q1", "Sent", {}, sales);
  const result = transitionQuote(db, store, "q1", "Approved_Pending_PO", {}, otherSales);
});

test("Admin fallback approval requires a recorded reason when approving a quote they sent", () => {
  const { db, store } = makeDb();
  const admin = db.users.find((user) => user.role === "Admin");

  transitionQuote(db, store, "q1", "Sent", {}, admin);
  assert.throws(
    () => transitionQuote(db, store, "q1", "Approved_Pending_PO", {}, admin),
    /Admin fallback approval requires a recorded reason/
  );

  const result = transitionQuote(db, store, "q1", "Approved_Pending_PO", {
    approval_exception_reason: "Sales approver unavailable during client operational deadline."
  }, admin);

  assert.equal(result.quote.status, "Approved_Pending_PO");
});

test("legacy quote with no recorded sent_by can still be approved by the Sales user who sent it under the old flow", () => {
  const { db, store } = makeDb();
  const sales = db.users.find((user) => user.role === "Sales");
  // Simulate a quote that reached Sent before this patch existed: no sent_by field at all.
  const quote = db.quotes.find((q) => q.id === "q1");
  quote.status = "Sent";

  const result = transitionQuote(db, store, "q1", "Approved_Pending_PO", {}, sales);
  assert.equal(result.quote.status, "Approved_Pending_PO");
});
