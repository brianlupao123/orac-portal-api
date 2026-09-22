import test from "node:test";
import assert from "node:assert/strict";
import { getKioskRoster, submitKioskTimesheets } from "../src/controllers/kioskController.js";

function response() { return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }

function request(role = "Operations", body = { work_date: "2026-09-21", entries: [{ technician_id: "tech-1", hours_logged: 8, hourly_rate: 45, notes: "Inspection" }] }) {
  const actor = { id: "ops-1", role, is_active: true };
  return {
    user: { id: actor.id }, params: { id: "dispatch-1" }, body,
    db: {
      users: [actor, { id: "tech-1", role: "Technician", name: "Technician One", email: "tech@example.test", trade: "Fitter", is_active: true }, { id: "tech-2", role: "Technician", is_active: true }],
      dispatch_cards: [{ id: "dispatch-1", dispatch_number: "DC-1", status: "In_Progress", assigned_technician_id: "tech-1", purchase_order_id: "po-1" }],
      field_worksheets: [], timesheets: [], audit_logs: []
    },
    store: { id: (() => { let index = 0; return () => `ts-${++index}`; })(), audit() {}, recalculateVariance() {} }
  };
}

test("kiosk roster exposes only technicians assigned to the selected dispatch", () => {
  const req = request(); const res = response(); getKioskRoster(req, res);
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body.data.technicians.map((user) => user.id), ["tech-1"]);
  assert.equal(res.body.data.technicians[0].trade, "Fitter");
});

test("Operations kiosk batch attributes each entry to the technician and recorder", () => {
  const req = request(); const res = response(); submitKioskTimesheets(req, res);
  assert.equal(res.statusCode, 200); assert.equal(req.db.timesheets.length, 1);
  assert.equal(req.db.timesheets[0].technician_id, "tech-1"); assert.equal(req.db.timesheets[0].recorded_by_user_id, "ops-1");
  assert.equal(req.db.timesheets[0].technician_trade, "Fitter");
});

test("kiosk rejects unassigned and duplicate technician entries", () => {
  const unassigned = request("Operations", { work_date: "2026-09-21", entries: [{ technician_id: "tech-2", hours_logged: 8, hourly_rate: 45 }] });
  const unassignedRes = response(); submitKioskTimesheets(unassigned, unassignedRes); assert.equal(unassignedRes.statusCode, 403);
  const duplicate = request("Operations", { work_date: "2026-09-21", entries: [{ technician_id: "tech-1", hours_logged: 8, hourly_rate: 45 }, { technician_id: "tech-1", hours_logged: 1, hourly_rate: 45 }] });
  const duplicateRes = response(); submitKioskTimesheets(duplicate, duplicateRes); assert.equal(duplicateRes.statusCode, 400);
});

test("Supervisor cannot use the kiosk batch endpoint", () => {
  assert.throws(() => submitKioskTimesheets(request("Supervisor"), response()), { status: 403 });
});
