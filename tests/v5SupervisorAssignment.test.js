import assert from "node:assert/strict";
import test from "node:test";
import { assignDispatchSupervisor } from "../src/controllers/dispatchController.js";
import { database, call, withV5 } from "./helpers/v5SignatureFixture.js";

// Operations assigns a Supervisor to a dispatch. In V5 mode the Sales owner of the
// dispatch's quotation can never be that Supervisor; with V5 off nothing changes.
function assign(db, supervisorId) {
  return call(assignDispatchSupervisor, db, "ops-1", { params: { id: "job-1" }, body: { supervisor_id: supervisorId } });
}
function withSalesOwnerAsSupervisor() {
  const db = database();
  db.dispatch_cards[0].assigned_supervisor_id = undefined;
  db.users.find((user) => user.id === "sales-1").role = "Supervisor"; // data drift: owner now holds the Supervisor role
  return db;
}

test("V5 refuses to assign the quotation's Sales owner as its Supervisor", () => withV5(() => {
  const db = withSalesOwnerAsSupervisor();
  const res = assign(db, "sales-1");
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "V5_SUPERVISOR_SEPARATION");
  assert.equal(db.dispatch_cards[0].assigned_supervisor_id, undefined);
  assert.equal(db.audit_logs.length, 0);
}));

test("V5 still assigns an independent Supervisor and audits it", () => withV5(() => {
  const db = withSalesOwnerAsSupervisor();
  const res = assign(db, "sup-2");
  assert.equal(res.statusCode, 200);
  assert.equal(db.dispatch_cards[0].assigned_supervisor_id, "sup-2");
  assert.equal(db.audit_logs[0].action, "DISPATCH_SUPERVISOR_ASSIGNED");
}));

test("with V5 off the existing assignment behaviour is unchanged", () => withV5(() => {
  const db = withSalesOwnerAsSupervisor();
  const res = assign(db, "sales-1");
  assert.equal(res.statusCode, 200);
  assert.equal(db.dispatch_cards[0].assigned_supervisor_id, "sales-1");
}, false));

test("a non-V5 quotation is not affected even when V5 is on", () => withV5(() => {
  const db = withSalesOwnerAsSupervisor();
  db.quotes[0].v5_commercial_workflow = false;
  assert.equal(assign(db, "sales-1").statusCode, 200);
}));
