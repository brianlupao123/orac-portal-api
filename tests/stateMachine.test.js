import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../src/store.js";
import { transitionQuote } from "../src/stateMachine.js";

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

test("rejects illegal Draft to Invoiced transition", () => {
  const { db, store, actor } = makeDb();
  assert.throws(
    () => transitionQuote(db, store, "q1", "Invoiced", {}, actor),
    /Illegal transition/
  );
});

test("blocks invoice when urgent dispatch started before PO", () => {
  const { db, store, actor } = makeDb();
  transitionQuote(db, store, "q1", "Sent", {}, actor);
  transitionQuote(db, store, "q1", "Approved_Pending_PO", {}, actor);
  transitionQuote(db, store, "q1", "Field_Dispatch", { started_before_po: true, urgent_reason: "Plant stoppage" }, actor);

  assert.throws(
    () => transitionQuote(db, store, "q1", "Invoiced", {}, actor),
    /verified PO reference is required/
  );
});

test("allows full path when PO is verified and no amendment is required", () => {
  const { db, store, actor } = makeDb();
  transitionQuote(db, store, "q1", "Sent", {}, actor);
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
  const result = transitionQuote(db, store, "q1", "Invoiced", {}, actor);

  assert.equal(result.quote.status, "Invoiced");
  assert.equal(db.invoices.length, 1);
});

test("blocks invoice when PO amendment is required", () => {
  const { db, store, actor } = makeDb();
  transitionQuote(db, store, "q1", "Sent", {}, actor);
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
    () => transitionQuote(db, store, "q1", "Invoiced", {}, actor),
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

  transitionQuote(db, store, "q1", "Sent", {}, admin);
  transitionQuote(db, store, "q1", "Approved_Pending_PO", {}, admin);
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
    () => transitionQuote(db, store, "q1", "Invoiced", {}, sales),
    /cannot perform invoice/
  );
});

test("blocks invoice without supervisor-approved worksheet", () => {
  const { db, store, actor } = makeDb();
  transitionQuote(db, store, "q1", "Sent", {}, actor);
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

  assert.throws(
    () => transitionQuote(db, store, "q1", "Invoiced", {}, actor),
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

  assert.equal(result.quote.status, "Approved_Pending_PO");
});

test("does not block Admin or Operations from approving a quote they sent", () => {
  const { db, store } = makeDb();
  const admin = db.users.find((user) => user.role === "Admin");

  transitionQuote(db, store, "q1", "Sent", {}, admin);
  const result = transitionQuote(db, store, "q1", "Approved_Pending_PO", {}, admin);

  assert.equal(result.quote.status, "Approved_Pending_PO");
});

test("ignores a forged sent_by in the transition payload; sent_by always comes from the real actor", () => {
  const { db, store } = makeDb();
  const sales = db.users.find((user) => user.role === "Sales");
  const otherSales = { id: "u_sales2", role: "Sales", is_active: true };
  db.users.push(otherSales);

  // sales sends the quote, but forges the payload to try to attribute the
  // send to otherSales, hoping to approve it themself afterwards.
  transitionQuote(db, store, "q1", "Sent", { sent_by: otherSales.id }, sales);
  assert.equal(db.quotes.find((q) => q.id === "q1").sent_by, sales.id, "sent_by must come from the authenticated actor, never the payload");

  assert.throws(
    () => transitionQuote(db, store, "q1", "Approved_Pending_PO", { sent_by: otherSales.id }, sales),
    /Sales cannot approve a quote they personally sent/,
    "a forged sent_by in the approval payload must not defeat the self-approval block"
  );
});

test("allows Operations to approve a quote Sales sent, independent of the self-approval rule", () => {
  const { db, store } = makeDb();
  db.users.push({ id: "u_ops", role: "Operations", is_active: true });
  const sales = db.users.find((user) => user.role === "Sales");
  const ops = db.users.find((user) => user.id === "u_ops");

  transitionQuote(db, store, "q1", "Sent", {}, sales);
  const result = transitionQuote(db, store, "q1", "Approved_Pending_PO", {}, ops);

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
