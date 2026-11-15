// Lane 2, FB6 (test-only): kiosk entry attribution and the role-level split between
// who records kiosk hours and who reviews them. Reads permissions only; no production
// file, flag or data is changed. Timesheet env flags are cleared and restored.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { submitKioskTimesheets } from "../src/controllers/kioskController.js";
import { hasPermission } from "../src/permissions.js";

let savedEnv;
before(() => {
  savedEnv = {};
  for (const key of Object.keys(process.env)) if (key.startsWith("TIMESHEET_")) { savedEnv[key] = process.env[key]; delete process.env[key]; }
});
after(() => { for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v; });

const ROLES = ["Admin", "Management", "Sales", "Operations", "Technician", "Supervisor", "Finance", "Client Viewer"];
const can = (role, permission) => hasPermission({ id: `u_${role}`, role, is_active: true }, permission);

function response() { return { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
function world() {
  let n = 0;
  const audits = [];
  const db = {
    users: [
      { id: "u_ops", role: "Operations", name: "Ops", is_active: true },
      { id: "u_t1", role: "Technician", name: "Tech One", is_active: true }
    ],
    clients: [{ id: "c1", name: "Client" }], quotes: [{ id: "q1", client_id: "c1" }],
    dispatch_cards: [{ id: "d1", quotation_id: "q1", dispatch_number: "D-1", status: "In_Progress", assigned_technician_ids: ["u_t1"] }],
    field_worksheets: [], timesheets: [], audit_logs: []
  };
  return { db, audits, store: { id: (p) => `${p}_${++n}`, audit: (...a) => audits.push(a), recalculateVariance() {} } };
}

test("a kiosk entry records who typed it (recorded_by_user_id), whose hours it is (technician_id), pending status and a submission time, and no reviewer", () => {
  const w = world();
  const res = response();
  submitKioskTimesheets({ user: { id: "u_ops" }, db: w.db, store: w.store, params: { id: "d1" }, query: {}, body: { work_date: "2026-10-05", entries: [{ technician_id: "u_t1", hours_logged: 8, hourly_rate: 10 }] } }, res);
  assert.equal(res.statusCode, 200);
  const row = w.db.timesheets[0];
  assert.equal(row.recorded_by_user_id, "u_ops");
  assert.equal(row.technician_id, "u_t1");
  assert.notEqual(row.recorded_by_user_id, row.technician_id);
  assert.equal(row.review_status, "pending_review");
  assert.ok(row.submitted_at, "submitted_at is stamped");
  assert.equal(row.reviewed_by, null);
  assert.equal(row.reviewed_at, null);
  assert.ok(w.audits.some((a) => a[4] === "KIOSK_TIMESHEET_ADDED"));
});

test("the roles that may record kiosk hours are different from the roles that may review them, so nobody can both record and review kiosk hours", () => {
  const recorders = ROLES.filter((r) => can(r, "submitKioskTimesheets"));
  const reviewers = ROLES.filter((r) => can(r, "reviewKioskTimesheet"));
  assert.deepEqual(recorders.sort(), ["Admin", "Operations"]);
  assert.deepEqual(reviewers, ["Supervisor"]);
  assert.deepEqual(recorders.filter((r) => reviewers.includes(r)), []);
});

test("CHARACTERIZATION: Admin, Operations and Supervisor each hold both submitWorksheet and reviewWorksheet, so worksheet independence depends on the per-record submitter check, not on a role split", () => {
  const both = ROLES.filter((r) => can(r, "submitWorksheet") && can(r, "reviewWorksheet"));
  assert.deepEqual(both.sort(), ["Admin", "Operations", "Supervisor"]);
});

test("Technician, Finance, Management, Sales and Client Viewer hold neither reviewWorksheet nor reviewKioskTimesheet", () => {
  for (const role of ["Technician", "Finance", "Management", "Sales", "Client Viewer"]) {
    assert.equal(can(role, "reviewWorksheet"), false, role);
    assert.equal(can(role, "reviewKioskTimesheet"), false, role);
  }
});
