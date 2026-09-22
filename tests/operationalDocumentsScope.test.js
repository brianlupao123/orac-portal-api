import assert from "node:assert/strict";
import test from "node:test";
import { getDailyTaskReport, getClientCompletionRecord, getInvoiceReadySummary } from "../src/controllers/operationalDocumentsController.js";

function res() {
  return {
    statusCode: 200, sent: 0, body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { if (this.sent > 0) throw new Error("second response attempted"); this.sent += 1; this.body = body; return this; }
  };
}

const ROLES = ["Admin", "Management", "Sales", "Finance", "Operations", "Supervisor", "Technician", "Client Viewer"];
const actorFor = { Admin: "admin", Management: "management", Sales: "sales", Finance: "finance", Operations: "operations", Supervisor: "supervisor", Technician: "technician", "Client Viewer": "client" };

function fixture() {
  return {
    users: [
      { id: "admin", role: "Admin", is_active: true }, { id: "management", role: "Management", is_active: true },
      { id: "sales", role: "Sales", is_active: true }, { id: "finance", role: "Finance", is_active: true },
      { id: "operations", role: "Operations", is_active: true }, { id: "supervisor", role: "Supervisor", is_active: true },
      { id: "supervisor2", role: "Supervisor", is_active: true }, { id: "technician", role: "Technician", is_active: true },
      { id: "technician2", role: "Technician", is_active: true }, { id: "client", role: "Client Viewer", is_active: true, client_id: "c1" },
      { id: "client2", role: "Client Viewer", is_active: true, client_id: "c2" }, { id: "client_noid", role: "Client Viewer", is_active: true }
    ],
    clients: [{ id: "c1", name: "Client One" }, { id: "c2", name: "Client Two" }],
    quotes: [{ id: "q1", client_id: "c1" }],
    dispatch_cards: [{ id: "d1", quotation_id: "q1", assigned_technician_id: "technician", assigned_supervisor_id: "supervisor" }, { id: "d2", quotation_id: "q1", assigned_technician_id: "technician2" }],
    field_worksheets: [
      { id: "w1", dispatch_card_id: "d1", technician_id: "technician", supervisor_id: "supervisor", status: "Supervisor_Approved" },
      { id: "w2", dispatch_card_id: "d1", technician_id: "technician", status: "Submitted" },
      { id: "w3", dispatch_card_id: "d2", technician_id: "technician2", status: "Supervisor_Approved" },
      { id: "orphan", dispatch_card_id: "gone", technician_id: "technician", status: "Supervisor_Approved" }
    ],
    invoices: [], purchase_orders: []
  };
}
const call = (handler, db, userId, id) => { const r = res(); handler({ db, user: userId ? { id: userId } : undefined, params: { id } }, r); return r; };

test("daily task report: role matrix and assignment scope", () => {
  const allow = ["Admin", "Management", "Operations", "Supervisor", "Technician"];
  for (const role of ROLES) {
    const r = call(getDailyTaskReport, fixture(), actorFor[role]);
    assert.equal(r.statusCode, allow.includes(role) ? 200 : 403, role);
    assert.equal(r.sent, 1);
  }
  const tech = call(getDailyTaskReport, fixture(), "technician").body.data;
  assert.deepEqual(tech.dispatches.map((d) => d.id), ["d1"]);
  assert.deepEqual(tech.worksheets.map((w) => w.id).sort(), ["orphan", "w1", "w2"]);
  const sup = call(getDailyTaskReport, fixture(), "supervisor").body.data;
  assert.deepEqual(sup.dispatches.map((d) => d.id), ["d1"]);
  assert.equal(sup.worksheets.some((w) => w.id === "w3"), false);
  assert.equal(call(getDailyTaskReport, fixture(), "admin").body.data.dispatches.length, 2);
});

test("invoice-ready summary: only Admin, Management and Finance", () => {
  for (const role of ROLES) {
    const r = call(getInvoiceReadySummary, fixture(), actorFor[role]);
    if (["Admin", "Management", "Finance"].includes(role)) assert.notEqual(r.statusCode, 403, role);
    else assert.equal(r.statusCode, 403, role);
  }
});

test("completion record: eight-role matrix on an approved, in-scope worksheet", () => {
  const allow = ["Admin", "Management", "Operations", "Supervisor", "Technician", "Client Viewer"];
  for (const role of ROLES) {
    const r = call(getClientCompletionRecord, fixture(), actorFor[role], "w1");
    assert.equal(r.statusCode, allow.includes(role) ? 200 : 403, role);
    assert.equal(r.sent, 1);
  }
});

test("completion record: disallowed roles get 403 (not 404) for a missing ID", () => {
  for (const role of ["Sales", "Finance"]) assert.equal(call(getClientCompletionRecord, fixture(), actorFor[role], "nope").statusCode, 403, role);
  const r = call(getClientCompletionRecord, fixture(), "admin", "nope");
  assert.equal(r.statusCode, 404);
  assert.deepEqual(Object.keys(r.body).sort(), ["message", "success"]);
});

test("completion record: client isolation fails closed", () => {
  for (const other of ["client2", "client_noid"]) {
    const r = call(getClientCompletionRecord, fixture(), other, "w1");
    assert.equal(r.statusCode, 403, other);
    assert.equal(JSON.stringify(r.body).includes("Client One"), false);
  }
  // regression: Client Viewer with no client_id must not match a worksheet whose client cannot be resolved
  assert.equal(call(getClientCompletionRecord, fixture(), "client_noid", "orphan").statusCode, 403);
});

test("completion record: requires supervisor approval and assignment scope", () => {
  const unapproved = call(getClientCompletionRecord, fixture(), "admin", "w2");
  assert.equal(unapproved.statusCode, 409); assert.equal(unapproved.body.success, false);
  assert.equal(call(getClientCompletionRecord, fixture(), "technician2", "w1").statusCode, 403);
  assert.equal(call(getClientCompletionRecord, fixture(), "supervisor2", "w1").statusCode, 403);
});

test("operational document handlers fail closed when req.user is missing (no users[0] fallback)", () => {
  for (const handler of [getDailyTaskReport, getInvoiceReadySummary]) assert.equal(call(handler, fixture(), null).statusCode, 403);
  assert.equal(call(getClientCompletionRecord, fixture(), null, "w1").statusCode, 403);
});
