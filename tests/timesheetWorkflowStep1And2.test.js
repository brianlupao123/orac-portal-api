// Contract steps 1 and 2: client return-with-reason and the shared eligibility predicate.
// Dependency-free (no express/zod/bcrypt): fake store, plain request doubles.
import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateEligibility, isEligibleForDb, awaitsSupervisorReview, INELIGIBLE,
  FLAG_ELIGIBILITY_CUTOVER, FLAG_CLIENT_RETURN
} from "../src/timesheetEligibility.js";
import { computeWorksheetReport, computeInvoiceReadyReport, computeDispatchReport } from "../src/reports.js";
import { returnWorksheetByClient, acknowledgeWorksheet } from "../src/controllers/timesheetAcknowledgementController.js";
import { submitWorksheet } from "../src/controllers/dispatchController.js";
import { makeRes, makeReq } from "./_http.js";

const withFlags = (flags, fn) => async () => {
  const saved = {};
  for (const k of [FLAG_ELIGIBILITY_CUTOVER, FLAG_CLIENT_RETURN]) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, flags);
  try { await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

const signed = { employee: { name: "A Worker", date: "2026-03-02", method: "paper_scan" } };
const v2 = (over = {}) => ({
  id: "ws1", dispatch_card_id: "d1", technician_id: "t1", work_date: "2026-03-02", hours: 8,
  timesheet_version: 2, hours_breakdown: { normal: 8, ot_15: 0, ot_20: 0 }, signatures: signed, signed_copy_image: "img", ...over
});
const ack = (at, active = true) => ({ acknowledged_at: at, authority_snapshot: { active } });

function makeDb(worksheets, client = {}) {
  return {
    users: [{ id: "cu", role: "Client Viewer", is_active: true, client_id: "c1", name: "Client Person" }, { id: "t1", role: "Technician", is_active: true }],
    clients: [{ id: "c1", name: "C1", ...client }, { id: "c2", name: "C2" }],
    quotes: [{ id: "q1", client_id: "c1" }], dispatch_cards: [{ id: "d1", quotation_id: "q1" }, { id: "d2", quotation_id: "qx" }],
    purchase_orders: [{ quotation_id: "q1", status: "verified" }], invoices: [], field_worksheets: worksheets,
    mine_sites: [], plants: [], plant_sections: [], equipment_tags: [], audit_logs: []
  };
}
const store = () => { let n = 0; const audits = []; return { audits, id: (p) => `${p}_${++n}`, audit: (db, actor, type, id, action, before, after) => audits.push({ action, id, actor: actor.id, after }) }; };

test("flag off: predicate is exactly today's rule (only Supervisor_Approved)", withFlags({}, () => {
  for (const status of ["Draft", "Submitted", "Client_Acknowledged", "Returned_For_Correction", "Captured_From_Signed_Paper"]) {
    assert.equal(evaluateEligibility({ status }).eligible, false, status);
  }
  assert.equal(evaluateEligibility({ status: "Supervisor_Approved" }).eligible, true);
  assert.equal(awaitsSupervisorReview(makeDb([]), { status: "Client_Acknowledged" }), true);
}));

test("flag on: eligibility needs an on/after-cutover confirmation with active authority", withFlags({ [FLAG_ELIGIBILITY_CUTOVER]: "enabled" }, () => {
  const client = { timesheet_cutover_date: "2026-03-01" };
  const ok = v2({ status: "Client_Acknowledged", client_acknowledgement: ack("2026-03-03T08:00:00Z") });
  assert.equal(evaluateEligibility(ok, { client }).eligible, true);
  assert.equal(evaluateEligibility(ok, { client: {} }).reason, INELIGIBLE.NO_CLIENT_CUTOVER);
  const pre = v2({ status: "Client_Acknowledged", client_acknowledgement: ack("2026-02-20T08:00:00Z") });
  assert.equal(evaluateEligibility(pre, { client }).reason, INELIGIBLE.PRE_CUTOVER_ACKNOWLEDGEMENT);
  const noAuth = v2({ status: "Client_Acknowledged", client_acknowledgement: ack("2026-03-03T08:00:00Z", false) });
  assert.equal(evaluateEligibility(noAuth, { client }).reason, INELIGIBLE.NO_AUTHORITY_SNAPSHOT);
  assert.equal(evaluateEligibility({ ...ok, superseded_by: "ws2" }, { client }).reason, INELIGIBLE.SUPERSEDED);
  assert.equal(evaluateEligibility({ ...ok, duplicate_conflict: { resolved_at: null } }, { client }).reason, INELIGIBLE.DUPLICATE_CONFLICT);
  assert.equal(evaluateEligibility({ ...ok, signatures: {}, signed_copy_image: null }, { client }).reason, INELIGIBLE.NO_DECLARATION);
  assert.equal(evaluateEligibility(ok, { client, workDateValid: false }).reason, INELIGIBLE.OUT_OF_VALIDITY);
  for (const status of ["Draft", "Submitted", "Returned_For_Correction"]) assert.equal(evaluateEligibility(v2({ status }), { client }).eligible, false, status);
}));

test("flag on: paper capture is eligible only with complete evidence; historical approvals stay eligible", withFlags({ [FLAG_ELIGIBILITY_CUTOVER]: "enabled" }, () => {
  assert.equal(evaluateEligibility(v2({ status: "Captured_From_Signed_Paper", paper_evidence: { complete: true } })).eligible, true);
  assert.equal(evaluateEligibility(v2({ status: "Captured_From_Signed_Paper" })).reason, INELIGIBLE.PAPER_EVIDENCE_INCOMPLETE);
  assert.equal(evaluateEligibility({ id: "old", status: "Supervisor_Approved", hours: 8 }).eligible, true); // pre-v2 history untouched
}));

test("flag on: a pre-cutover acknowledgement still drains via Supervisor; a post-cutover one does not", withFlags({ [FLAG_ELIGIBILITY_CUTOVER]: "enabled" }, () => {
  const db = makeDb([], { timesheet_cutover_date: "2026-03-01" });
  assert.equal(awaitsSupervisorReview(db, v2({ status: "Client_Acknowledged", client_acknowledgement: ack("2026-02-20T00:00:00Z") })), true);
  assert.equal(awaitsSupervisorReview(db, v2({ status: "Client_Acknowledged", client_acknowledgement: ack("2026-03-05T00:00:00Z") })), false);
}));

test("consumers: flag off gives identical report output; flag on counts a confirmed record once", async () => {
  const sheets = [v2({ id: "a", status: "Supervisor_Approved" }), v2({ id: "b", status: "Client_Acknowledged", client_acknowledgement: ack("2026-03-03T00:00:00Z") })];
  await withFlags({}, () => {
    const db = makeDb(sheets, { timesheet_cutover_date: "2026-03-01" });
    assert.equal(computeWorksheetReport(db).approved_count, 1);
    assert.equal(computeWorksheetReport(db).pending_supervisor_review.length, 1);
    assert.equal(computeDispatchReport(db)[0].approved_worksheet_count, 1);
  })();
  await withFlags({ [FLAG_ELIGIBILITY_CUTOVER]: "enabled" }, () => {
    const db = makeDb(sheets, { timesheet_cutover_date: "2026-03-01" });
    assert.equal(computeWorksheetReport(db).approved_count, 2);
    assert.equal(computeWorksheetReport(db).pending_supervisor_review.length, 0);
    assert.equal(computeInvoiceReadyReport(db).length, 1);
    assert.equal(isEligibleForDb(db, sheets[1]), true);
  })();
});

const clientReq = (db, st, id, body, user = "cu") => makeReq({ db, store: st, user: { id: user }, params: { id }, body });

test("client return: disabled by default (409), no state change", withFlags({}, () => {
  const db = makeDb([v2({ status: "Submitted" })]); const res = makeRes();
  returnWorksheetByClient(clientReq(db, store(), "ws1", { reason: "Hours wrong" }), res);
  assert.equal(res.statusCode, 409); assert.equal(res.body.code, "FEATURE_DISABLED");
  assert.equal(db.field_worksheets[0].status, "Submitted");
}));

test("client return: reason kept, audited, resubmission stamped, history preserved", withFlags({ [FLAG_CLIENT_RETURN]: "enabled" }, () => {
  const db = makeDb([v2({ status: "Submitted", submitted_by: "t1" })]); const st = store(); const res = makeRes();
  returnWorksheetByClient(clientReq(db, st, "ws1", { reason: "Wrong date" }), res);
  assert.equal(res.statusCode, 200);
  const ws = db.field_worksheets[0];
  assert.equal(ws.status, "Returned_For_Correction");
  assert.equal(ws.client_return.reason, "Wrong date");
  assert.equal(st.audits.at(-1).action, "WORKSHEET_RETURNED");
  // preparer resubmits via the existing path
  db.dispatch_cards[0].assigned_technician_id = "t1";
  const res2 = makeRes();
  submitWorksheet(makeReq({ db, store: st, user: { id: "t1" }, params: { id: "ws1" } }), res2);
  assert.equal(res2.statusCode, 200);
  assert.equal(ws.status, "Submitted");
  assert.equal(ws.return_history.length, 1);
  assert.equal(ws.return_history[0].reason, "Wrong date");
  assert.ok(ws.return_history[0].resubmitted_at); assert.equal(ws.return_history[0].resubmitted_by, "t1");
  // second return appends, never overwrites
  returnWorksheetByClient(clientReq(db, st, "ws1", { reason: "Still wrong" }), makeRes());
  assert.deepEqual(ws.return_history.map((h) => h.reason), ["Wrong date", "Still wrong"]);
}));

test("client return: other client, non-Submitted and non-client actors are refused", withFlags({ [FLAG_CLIENT_RETURN]: "enabled" }, () => {
  const db = makeDb([v2({ status: "Submitted" }), v2({ id: "ws2", dispatch_card_id: "d2", status: "Submitted" }), v2({ id: "ws3", status: "Client_Acknowledged" })]);
  let res = makeRes(); returnWorksheetByClient(clientReq(db, store(), "ws2", { reason: "x y z" }), res); assert.equal(res.statusCode, 403);
  res = makeRes(); returnWorksheetByClient(clientReq(db, store(), "ws3", { reason: "x y z" }), res); assert.equal(res.statusCode, 400);
  assert.throws(() => returnWorksheetByClient(clientReq(db, store(), "ws1", { reason: "x y z" }, "t1"), makeRes()), /cannot perform/);
  assert.equal(db.field_worksheets[0].status, "Submitted");
}));

test("existing acknowledgement path is unchanged by this packet", withFlags({}, () => {
  const db = makeDb([v2({ status: "Submitted" })]); const res = makeRes();
  acknowledgeWorksheet(clientReq(db, store(), "ws1", { signer_name: "S", signer_role: "R" }), res);
  assert.equal(res.statusCode, 200); assert.equal(db.field_worksheets[0].status, "Client_Acknowledged");
}));
