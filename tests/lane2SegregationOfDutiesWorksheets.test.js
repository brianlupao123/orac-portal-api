// Lane 2, FB6 (test-only): segregation of duties for hours evidence.
//   entry (submit)  ->  independent approval  ->  no self-review.
// Exercises the real submitWorksheet and reviewWorksheet controllers with a fake store.
// No production file, flag, permission or data is changed. Timesheet env flags are
// cleared for this file and restored afterwards.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { submitWorksheet, reviewWorksheet } from "../src/controllers/dispatchController.js";

let savedEnv;
before(() => {
  savedEnv = {};
  for (const key of Object.keys(process.env)) if (key.startsWith("TIMESHEET_")) { savedEnv[key] = process.env[key]; delete process.env[key]; }
});
after(() => { for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v; });

function response() { return { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
// requirePermission throws { status: 403 }; normalise both styles into one result.
function call(fn, req) {
  const res = response();
  try { fn(req, res); } catch (error) { res.statusCode = error.status || 500; res.body = { success: false, message: error.message }; res.threw = true; }
  return res;
}

const USERS = [
  { id: "u_admin", role: "Admin", name: "Admin", is_active: true },
  { id: "u_ops", role: "Operations", name: "Ops", is_active: true },
  { id: "u_sup1", role: "Supervisor", name: "Sup One", is_active: true },
  { id: "u_sup2", role: "Supervisor", name: "Sup Two", is_active: true },
  { id: "u_t1", role: "Technician", name: "Tech One", is_active: true },
  { id: "u_fin", role: "Finance", name: "Fin", is_active: true },
  { id: "u_mgmt", role: "Management", name: "Mgmt", is_active: true },
  { id: "u_sales", role: "Sales", name: "Sales", is_active: true },
  { id: "u_client", role: "Client Viewer", name: "Client", is_active: true }
];

function world(worksheetOver = {}, poOver = {}) {
  const calls = [];
  const db = {
    users: USERS.map((u) => ({ ...u })),
    clients: [{ id: "c1", name: "Client" }],
    quotes: [{ id: "q1", client_id: "c1" }],
    purchase_orders: [{ id: "po1", quotation_id: "q1", verified_by: "u_fin", ...poOver }],
    dispatch_cards: [{ id: "d1", quotation_id: "q1", purchase_order_id: "po1", status: "In_Progress", assigned_supervisor_id: "u_sup1", assigned_technician_ids: ["u_t1"] }],
    field_worksheets: [{ id: "ws1", dispatch_card_id: "d1", technician_id: "u_t1", status: "Client_Acknowledged", hours: 4, ...worksheetOver }],
    timesheets: [], audit_logs: []
  };
  const store = { id: (p) => `${p}_${calls.length + 1}`, audit: (...args) => { calls.push(args); }, recalculateVariance() {} };
  return { db, store, calls };
}
const req = (w, userId, id = "ws1", body = {}) => ({ user: { id: userId }, db: w.db, store: w.store, params: { id }, query: {}, body });
const review = (w, userId, body, id) => call(reviewWorksheet, req(w, userId, id, body));
const submit = (w, userId, id) => call(submitWorksheet, req(w, userId, id));
const snap = (value) => JSON.stringify(value);
const actions = (w) => w.calls.map((a) => a[4]);

// ---- entry: who submitted is recorded --------------------------------------------------
test("submitting a worksheet stamps submitted_by with the submitter and writes a WORKSHEET_SUBMITTED audit entry", () => {
  const w = world({ status: "Draft" });
  const res = submit(w, "u_sup1");
  assert.equal(res.statusCode, 200);
  assert.equal(w.db.field_worksheets[0].status, "Submitted");
  assert.equal(w.db.field_worksheets[0].submitted_by, "u_sup1");
  assert.deepEqual(actions(w), ["WORKSHEET_SUBMITTED"]);
});

// ---- no self-review --------------------------------------------------------------------
test("the user who submitted a worksheet cannot approve it; nothing changes and nothing is audited", () => {
  const w = world({ submitted_by: "u_sup1" });
  const before = snap(w.db);
  const res = review(w, "u_sup1", { decision: "approve" });
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /cannot approve it/);
  assert.equal(snap(w.db), before);
  assert.deepEqual(actions(w), []);
});

test("an independent reviewer can approve; approved_by is the reviewer and one WORKSHEET_APPROVED audit entry is written", () => {
  const w = world({ submitted_by: "u_sup1" });
  const res = review(w, "u_ops", { decision: "approve" });
  assert.equal(res.statusCode, 200);
  const ws = w.db.field_worksheets[0];
  assert.equal(ws.status, "Supervisor_Approved");
  assert.equal(ws.approved_by, "u_ops");
  assert.notEqual(ws.approved_by, ws.submitted_by);
  assert.deepEqual(actions(w), ["WORKSHEET_APPROVED"]);
});

test("entry then approval end to end: the submitter is refused, a different reviewer succeeds", () => {
  const w = world({ status: "Draft" });
  assert.equal(submit(w, "u_sup1").statusCode, 200);
  w.db.field_worksheets[0].status = "Client_Acknowledged";            // simulates the client acknowledgement step
  assert.equal(review(w, "u_sup1", { decision: "approve" }).statusCode, 403);
  assert.equal(w.db.field_worksheets[0].status, "Client_Acknowledged");
  assert.equal(review(w, "u_admin", { decision: "approve" }).statusCode, 200);
  assert.equal(w.db.field_worksheets[0].approved_by, "u_admin");
});

test("approval is blocked when submission ownership cannot be verified (no submitted_by and no audit entry)", () => {
  const w = world();
  const before = snap(w.db);
  const res = review(w, "u_ops", { decision: "approve" });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /submission ownership cannot be verified/);
  assert.equal(snap(w.db), before);
});

test("when submitted_by is absent, ownership comes from the most recent WORKSHEET_SUBMITTED audit entry", () => {
  const w = world();
  w.db.audit_logs.push(
    { entity_type: "field_worksheet", entity_id: "ws1", action: "WORKSHEET_SUBMITTED", actor_id: "u_ops", created_at: "2026-10-01T08:00:00Z" },
    { entity_type: "field_worksheet", entity_id: "ws1", action: "WORKSHEET_SUBMITTED", actor_id: "u_sup1", created_at: "2026-10-02T08:00:00Z" }
  );
  assert.equal(review(w, "u_sup1", { decision: "approve" }).statusCode, 403);     // latest submitter is u_sup1
  assert.equal(review(w, "u_ops", { decision: "approve" }).statusCode, 200);      // an earlier submission by u_ops does not block
});

test("the user who verified the purchase order cannot approve the worksheet", () => {
  const w = world({ submitted_by: "u_sup1" }, { verified_by: "u_ops" });
  const before = snap(w.db);
  const res = review(w, "u_ops", { decision: "approve" });
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /verified this purchase order/);
  assert.equal(snap(w.db), before);
  assert.equal(review(w, "u_admin", { decision: "approve" }).statusCode, 200);
});

test("CHARACTERIZATION: independence is enforced on approve only; a submitter may return their own worksheet (with a comment)", () => {
  const w = world({ submitted_by: "u_sup1" });
  assert.equal(review(w, "u_sup1", { decision: "return" }).statusCode, 400);      // comment required
  const res = review(w, "u_sup1", { decision: "return", comment: "Wrong date" });
  assert.equal(res.statusCode, 200);
  assert.equal(w.db.field_worksheets[0].status, "Returned_For_Correction");
  assert.equal(w.db.field_worksheets[0].approved_by, null);
});

// ---- who may review at all -------------------------------------------------------------
test("roles without reviewWorksheet are refused and change nothing: Technician, Finance, Management, Sales, Client Viewer", () => {
  for (const userId of ["u_t1", "u_fin", "u_mgmt", "u_sales", "u_client"]) {
    const w = world({ submitted_by: "u_sup1" });
    const before = snap(w.db);
    const res = review(w, userId, { decision: "approve" });
    assert.equal(res.statusCode, 403, userId);
    assert.equal(snap(w.db), before, userId);
    assert.deepEqual(actions(w), [], userId);
  }
});

test("a Supervisor who is not assigned to the dispatch cannot review it", () => {
  const w = world({ submitted_by: "u_ops" });
  const before = snap(w.db);
  const res = review(w, "u_sup2", { decision: "approve" });
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /assigned dispatch/);
  assert.equal(snap(w.db), before);
});

test("review is only possible from Client_Acknowledged", () => {
  for (const status of ["Draft", "Submitted", "Returned_For_Correction", "Supervisor_Approved"]) {
    const w = world({ status, submitted_by: "u_sup1" });
    const res = review(w, "u_ops", { decision: "approve" });
    assert.equal(res.statusCode, 400, status);
    assert.equal(w.db.field_worksheets[0].status, status, status);
  }
});
