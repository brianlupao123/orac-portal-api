import assert from "node:assert/strict";
import test from "node:test";
import { getV5BillingReadiness } from "../src/controllers/timesheetWorkflowController.js";
import { createV5ClientSupervisorContact, recordV5PaperSignature, confirmV5Timesheet } from "../src/controllers/v5SignatureController.js";
import { v5SignatureState } from "../src/v5SignatureEvidence.js";
import { database, sheet, call, contactBody, paperBody, withV5 } from "./helpers/v5SignatureFixture.js";

// A Timesheet becomes V5-verified only through paper evidence AND the assigned ORAC Supervisor's confirmation.
function verify(db, id) {
  const contact = db.v5_client_supervisor_contacts[0] || call(createV5ClientSupervisorContact, db, "sales-1", { params: { id: "job-1" }, body: contactBody() }).body.data;
  assert.equal(call(recordV5PaperSignature, db, "sales-1", { params: { id }, body: paperBody(contact.id) }).statusCode, 201);
  const state = v5SignatureState(db, db.field_worksheets.find((item) => item.id === id));
  assert.equal(call(confirmV5Timesheet, db, "sup-1", { params: { id }, body: { evidence_id: state.evidence.id, hours_hash: state.current_hash, attest: true } }).statusCode, 201);
}

function readiness(db) { return call(getV5BillingReadiness, db, "sales-1", { params: { id: "job-1" } }); }

test("V5 billing readiness is dark by default", () => {
  const res = readiness(database());
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "FEATURE_DISABLED");
});

test("billing readiness is rate-free and ignores Timesheets that are not V5-verified", () => withV5(() => {
  const db = database();
  db.field_worksheets[0].status = "Supervisor_Approved";
  db.field_worksheets.push(sheet({ id: "ws-2", technician_id: "tech-2", worker_name: "Second Worker", hours_breakdown: { normal: 2, ot_15: 0, ot_20: 0 }, hours: 2 }));
  verify(db, "ws-1");
  const res = readiness(db);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.ready_for_pricing_review, true);
  assert.equal(res.body.data.lines[0].canonical_hours, 9);
  assert.equal(res.body.data.verification.unverified_hours, 2);
  assert.deepEqual(res.body.data.verification.unverified_timesheets.map((item) => item.id), ["ws-2"]);
  assert.equal(JSON.stringify(res.body.data).includes("unit_price"), false);
  assert.equal(JSON.stringify(res.body.data).includes("hourly_rate"), false);
}));

test("billing readiness becomes review-ready with every verified Timesheet counted", () => withV5(() => {
  const db = database();
  db.field_worksheets.push(sheet({ id: "ws-2", technician_id: "tech-2", worker_name: "Second Worker", hours_breakdown: { normal: 2, ot_15: 0, ot_20: 0 }, hours: 2 }));
  verify(db, "ws-1"); verify(db, "ws-2");
  const res = readiness(db);
  assert.equal(res.body.data.ready_for_pricing_review, true);
  assert.equal(res.body.data.lines[0].canonical_hours, 11);
  assert.deepEqual(res.body.data.verification.unverified_timesheets, []);
}));

test("billing readiness is blocked when nothing is V5-verified", () => withV5(() => {
  const res = readiness(database());
  assert.equal(res.body.data.ready_for_pricing_review, false);
  assert.deepEqual(res.body.data.blockers, ["No V5-verified canonical Timesheet hours are available."]);
}));
