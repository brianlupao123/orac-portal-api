import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../src/store.js";
import { handleAuditForNotifications } from "../src/notifications.js";
import { resolveDestination } from "../src/notificationDestinations.js";
import { legacyTimesheetViews } from "../src/legacyAdapters.js";
import { makeDb, addDaily, addContractorLog, clRow, row, addTimesheet } from "./helpers/worksheetRegisterFixture.js";
import apiRouter from "../src/router.js";

test("legacy adapter: Daily Time Sheets, Contractor Logs and no-breakdown Timesheets appear in one read-only shape, history untouched", () => {
  const db = makeDb();
  addDaily(db, { id: "dts_1", entries: [row("2026-09-01", 9, { ot_15: 2 })] });
  addContractorLog(db, { id: "cls_1", rows: [clRow("Fictional Worker", 8)] });
  db.field_worksheets.push({ id: "ws_old", dispatch_card_id: "d_1", technician_id: "u_tech1", work_date: "2026-08-01", hours: 8, status: "Supervisor_Approved", activity: "old" });
  addTimesheet(db, { id: "ws_new", date: "2026-09-02" });
  const before = JSON.stringify(db);
  const views = legacyTimesheetViews(db);
  assert.equal(JSON.stringify(db), before, "the adapter never writes");
  assert.deepEqual(views.map((v) => v.legacy_kind).sort(), ["contractor_log", "daily_timesheet", "timesheet_without_breakdown"]);
  assert.ok(views.every((v) => v.read_only === true));
  assert.equal(views.find((v) => v.legacy_kind === "timesheet_without_breakdown").hours_breakdown, null);
  assert.ok(!views.some((v) => v.record_id === "ws_new"), "a version-2 Timesheet is not legacy");
});

test("legacy creation gate: new Daily Time Sheets and Contractor Logs are refused by default and can be reopened by the rollback switch", async () => {
  const gate = apiRouter.stack.filter((l) => l.route && ["/daily_timesheets", "/contractor_log_sheets"].includes(l.route.path) && l.route.methods.post);
  assert.equal(gate.length, 2);
  for (const layer of gate) {
    assert.equal(layer.route.stack.length >= 3, true, "gate + validation + handler");
    const gateFn = layer.route.stack[0].handle;
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    delete process.env.LEGACY_TIMESHEET_FORM_CREATION;
    let called = false; gateFn({}, res, () => { called = true; });
    assert.equal(called, false); assert.equal(res.code, 409); assert.equal(res.body.code, "LEGACY_FORM_READ_ONLY");
    process.env.LEGACY_TIMESHEET_FORM_CREATION = "enabled";
    called = false; gateFn({}, res, () => { called = true; });
    assert.equal(called, true);
    delete process.env.LEGACY_TIMESHEET_FORM_CREATION;
  }
});

test("Worksheet notifications are content-free, go to the right people, and never to the actor", async () => {
  const store = createStore(":memory:");
  const { db, release } = await store.read();
  try {
    const mk = (action, actor, nv, ov = null) => ({ id: `a_${action}`, actor_id: actor, entity_type: "worksheet_register", entity_id: "wks_1", action, old_values: ov, new_values: nv, created_at: new Date().toISOString() });
    handleAuditForNotifications(db, mk("REGISTER_SUBMITTED", "u_ops", { submitted_by: "u_ops" }));
    const sub = db.notifications.find((n) => n.audit_log_id === "a_REGISTER_SUBMITTED");
    assert.deepEqual(sub.target_roles.sort(), ["Admin", "Operations", "Supervisor"]);
    assert.deepEqual(sub.exclude_user_ids, ["u_ops"]);
    handleAuditForNotifications(db, mk("REGISTER_APPROVED", "u_supervisor", { submitted_by: "u_admin", built_by: "u_ops" }));
    const to = db.notifications.filter((n) => n.audit_log_id === "a_REGISTER_APPROVED").map((n) => n.user_id).sort();
    assert.deepEqual(to, ["u_admin", "u_ops"]);
    handleAuditForNotifications(db, mk("REGISTER_RETURNED", "u_supervisor", { built_by: "u_ops" }, { submitted_by: "u_admin" }));
    assert.equal(db.notifications.filter((n) => n.audit_log_id === "a_REGISTER_RETURNED").length, 2);
    for (const n of db.notifications.filter((x) => x.entity_type === "worksheet_register")) assert.doesNotMatch(`${n.title} ${n.message}`, /hours|\d|rate|amount|Fictional/i, "title and message name no hours, workers or amounts");
    db.worksheet_registers.push({ id: "wks_1" });
    const admin = db.users.find((u) => u.id === "u_admin"); const tech = db.users.find((u) => u.id === "u_tech");
    assert.equal(resolveDestination(db, admin, { kind: "worksheet_register", id: "wks_1" }).route, "/monthly-worksheets");
    assert.equal(resolveDestination(db, tech, { kind: "worksheet_register", id: "wks_1" }).route, "/", "a Technician is sent to the dashboard, not the register");
  } finally { store.release(release); }
});
