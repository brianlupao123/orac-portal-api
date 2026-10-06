import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  listWorksheetRegisters, getWorksheetRegister, getWorksheetRegisterDocument, createWorksheetRegister, updateWorksheetRegister,
  buildWorksheetRegister, acknowledgeRegisterExceptions, submitWorksheetRegister, reviewWorksheetRegister,
  cancelWorksheetRegister, reconcileWorksheetRegister
} from "../src/controllers/worksheetRegisterController.js";
import {
  CreateWorksheetRegisterSchema, UpdateWorksheetRegisterSchema, ReconcileWorksheetRegisterSchema, ReviewWorksheetRegisterSchema
} from "../src/worksheetRegisterSchemas.js";
import { validate } from "../src/middleware/validate.js";
import { hasPermission } from "../src/permissions.js";
import { normalizeDb } from "../src/store.js";
import { makeDb, makeRes, req, row, addDaily, addTimesheet, baseBody } from "./helpers/worksheetRegisterFixture.js";

const FORBIDDEN_KEYS = new Set(["hourly_rate", "rate", "rates", "amount", "total_amount", "cost", "total_cost", "unit_price", "price"]);
function moneyKeys(value, found = []) {
  if (Array.isArray(value)) value.forEach((v) => moneyKeys(v, found));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { if (FORBIDDEN_KEYS.has(k)) found.push(k); moneyKeys(v, found); }
  return found;
}

function call(fn, db, user, body = {}, params = {}) {
  const res = makeRes();
  fn(req(db, user, body, params), res);
  return res;
}

// A db with two approved daily sheets and a created (consolidated) Worksheet.
function seeded() {
  const db = makeDb();
  addTimesheet(db, { id: "ws_1", technician_id: "u_tech1", date: "2026-09-01", breakdown: { normal: 9, ot_15: 2, ot_20: 0 } });
  addTimesheet(db, { id: "ws_1b", technician_id: "u_tech1", date: "2026-09-02", breakdown: { normal: 9, ot_15: 0, ot_20: 0 } });
  addTimesheet(db, { id: "ws_2", technician_id: "u_tech2", date: "2026-09-01", breakdown: { normal: 9, ot_15: 0, ot_20: 0 } });
  const res = call(createWorksheetRegister, db, "u_ops", baseBody());
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return { db, id: res.body.data.id, created: res.body.data };
}
const ackAll = (db, id, user = "u_ops") => {
  const rec = db.worksheet_registers.find((m) => m.id === id);
  const keys = rec.exceptions.filter((e) => e.severity === "warning" && !e.acknowledged_at).map((e) => e.key);
  if (keys.length) assert.equal(call(acknowledgeRegisterExceptions, db, user, { keys, note: "Checked against paper" }, { id }).statusCode, 200);
};

test("permissions: only Admin/Management/Operations/Supervisor view; only Admin/Operations/Supervisor manage; only Admin/Operations reconcile", () => {
  const db = makeDb();
  const can = (role, perm) => hasPermission(db.users.find((u) => u.role === role), perm);
  for (const role of ["Technician", "Sales", "Finance", "Client Viewer"]) {
    for (const p of ["viewWorksheetRegister", "manageWorksheetRegister", "submitWorksheetRegister", "reviewWorksheetRegister", "reconcileWorksheetRegister"]) assert.equal(can(role, p), false, `${role} ${p}`);
  }
  assert.equal(can("Management", "viewWorksheetRegister"), true);
  assert.equal(can("Management", "manageWorksheetRegister"), false);
  assert.equal(can("Supervisor", "reconcileWorksheetRegister"), false);
  assert.equal(can("Operations", "reconcileWorksheetRegister"), true);
});

test("Technician, Finance and Client Viewer are refused on every read and write handler", () => {
  const { db, id } = seeded();
  for (const user of ["u_tech1", "u_fin", "u_client", "u_sales"]) {
    for (const [fn, params, body] of [
      [listWorksheetRegisters, {}, {}], [getWorksheetRegister, { id }, {}], [getWorksheetRegisterDocument, { id }, {}],
      [createWorksheetRegister, {}, baseBody()], [updateWorksheetRegister, { id }, {}], [buildWorksheetRegister, { id }, {}],
      [acknowledgeRegisterExceptions, { id }, { keys: ["x"], note: "abc" }], [submitWorksheetRegister, { id }, {}],
      [reviewWorksheetRegister, { id }, { decision: "approve" }], [cancelWorksheetRegister, { id }, { reason: "abc" }],
      [reconcileWorksheetRegister, { id }, { confirm: true }]
    ]) {
      assert.throws(() => fn(req(db, user, body, params), makeRes()), /cannot perform/, `${user} ${fn.name}`);
    }
  }
  assert.equal(call(listWorksheetRegisters, db, "u_mgmt").body.data.length, 1, "Management can read");
  assert.equal(call(listWorksheetRegisters, db, "u_sup").body.data.length, 1, "Supervisor can read");
});

test("create consolidates immediately, assigns a reference, an explicit period and scope, and writes an audit entry", () => {
  const { db, created } = seeded();
  assert.equal(created.status, "Draft");
  assert.equal(created.reference, "WKS-202608-001");
  assert.deepEqual(created.period, { start: "2026-08-31", end: "2026-09-30" });
  assert.equal(created.scope.client_id, "c_test");
  assert.equal(created.client_name, "Test Client");
  assert.equal(created.grid.dates.length, 31);
  assert.equal(created.totals.normal, 27);
  assert.equal(created.totals.ot_15, 2);
  assert.equal(created.reconciliation_state, "Clear");
  assert.ok(db.audit_logs.some((a) => a.action === "REGISTER_CREATED" && a.entity_type === "worksheet_register"));
  assert.equal(created.history[0].action, "Created and consolidated");
});

test("create validation: period, client, roster, duplicate scope", () => {
  const db = makeDb();
  assert.equal(call(createWorksheetRegister, db, "u_ops", baseBody({ period_end: "2026-08-01" })).statusCode, 400);
  assert.equal(call(createWorksheetRegister, db, "u_ops", baseBody({ scope: { client_id: "nope", project_title: "P" } })).statusCode, 400);
  assert.equal(call(createWorksheetRegister, db, "u_ops", baseBody({ scope: { client_id: "c_test", project_title: "P", quote_id: "q_other" } })).statusCode, 400);
  assert.equal(call(createWorksheetRegister, db, "u_ops", baseBody({ scope: { client_id: "c_test", project_title: "P", purchase_order_id: "po_test", quote_id: "q_test" } })).statusCode, 200);
  assert.equal(call(createWorksheetRegister, db, "u_ops", baseBody({ roster: [{ technician_id: "u_tech_off" }] })).statusCode, 400);
  assert.equal(call(createWorksheetRegister, db, "u_ops", baseBody({ roster: [{ technician_id: "u_sup" }] })).statusCode, 400, "only Technicians can be linked");
  assert.equal(call(createWorksheetRegister, db, "u_ops", baseBody({ roster: [{ technician_id: "u_tech1" }, { technician_id: "u_tech1" }] })).statusCode, 400);
  assert.equal(call(createWorksheetRegister, db, "u_ops", baseBody({ roster: [{ display_name: "A B" }, { display_name: " a  b " }] })).statusCode, 400);
  assert.equal(call(createWorksheetRegister, db, "u_ops", baseBody({ roster: [{ group: "x" }] })).statusCode, 400, "name required when not linked");
  // the first valid create above used project "P"; same client/project/period again is a duplicate
  const dup = call(createWorksheetRegister, db, "u_ops", baseBody({ scope: { client_id: "c_test", project_title: " p ", } }));
  assert.equal(dup.statusCode, 409);
  assert.match(dup.body.message, /already covers/);
});

test("submit is blocked by blocking exceptions, then by unacknowledged warnings, then succeeds", () => {
  const db = makeDb();
  addTimesheet(db, { id: "ws_1", technician_id: "u_tech1", date: "2026-09-01", status: "Submitted" });
  addTimesheet(db, { id: "ws_2", technician_id: "u_tech2", date: "2026-09-01" });
  const id = call(createWorksheetRegister, db, "u_ops", baseBody()).body.data.id;
  let r = call(submitWorksheetRegister, db, "u_ops", {}, { id });
  assert.equal(r.statusCode, 409); assert.equal(r.body.code, "BLOCKING_EXCEPTIONS");

  db.field_worksheets[0].status = "Supervisor_Approved";
  assert.equal(call(buildWorksheetRegister, db, "u_ops", {}, { id }).statusCode, 200);
  db.timesheets.push({ id: "ts_kiosk", technician_id: "u_tech1", work_date: "2026-09-01", hours_logged: 8, entry_source: "kiosk", review_status: "approved" });
  assert.equal(call(buildWorksheetRegister, db, "u_ops", {}, { id }).statusCode, 200);
  r = call(submitWorksheetRegister, db, "u_ops", {}, { id });
  assert.equal(r.statusCode, 409); assert.equal(r.body.code, "UNACKNOWLEDGED_WARNINGS");

  ackAll(db, id);
  r = call(submitWorksheetRegister, db, "u_ops", {}, { id });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.status, "Submitted");
});

test("blocking exceptions cannot be acknowledged away; information items need no acknowledgement; unknown keys 404", () => {
  const db = makeDb();
  addDaily(db, { id: "dts_1", status: "Draft", entries: [row("2026-09-01", 9)] });
  const id = call(createWorksheetRegister, db, "u_ops", baseBody({ roster: [{ technician_id: "u_tech1" }, { display_name: "Name Only Worker" }] })).body.data.id;
  const rec = db.worksheet_registers[0];
  const blocking = rec.exceptions.find((e) => e.severity === "blocking");
  const info = rec.exceptions.find((e) => e.severity === "info");
  assert.equal(call(acknowledgeRegisterExceptions, db, "u_ops", { keys: [blocking.key], note: "ok ok" }, { id }).statusCode, 409);
  assert.equal(call(acknowledgeRegisterExceptions, db, "u_ops", { keys: [info.key], note: "ok ok" }, { id }).statusCode, 409);
  assert.equal(call(acknowledgeRegisterExceptions, db, "u_ops", { keys: ["NOPE"], note: "ok ok" }, { id }).statusCode, 404);
});

test("an acknowledgement is recorded with who, when and why, and is audited", () => {
  const db = makeDb();
  addDaily(db, { id: "dts_1", entries: [row("2026-09-01", 9)] });
  const id = call(createWorksheetRegister, db, "u_ops", baseBody()).body.data.id;
  const warn = db.worksheet_registers[0].exceptions.find((e) => e.severity === "warning");
  const res = call(acknowledgeRegisterExceptions, db, "u_sup", { keys: [warn.key], note: "Worker was on leave" }, { id });
  assert.equal(res.statusCode, 200);
  const stored = db.worksheet_registers[0].exceptions.find((e) => e.key === warn.key);
  assert.equal(stored.acknowledged_by, "u_sup");
  assert.equal(stored.acknowledgement_note, "Worker was on leave");
  assert.ok(stored.acknowledged_at);
  assert.ok(db.audit_logs.some((a) => a.action === "REGISTER_EXCEPTIONS_ACKNOWLEDGED" && a.new_values.note === "Worker was on leave"));
});

test("approval separation of duties: submitter, builder and roster members cannot approve", () => {
  const { db, id } = seeded();
  ackAll(db, id);
  assert.equal(call(submitWorksheetRegister, db, "u_ops2", {}, { id }).statusCode, 200);
  // u_ops built it (created), u_ops2 submitted it.
  assert.equal(call(reviewWorksheetRegister, db, "u_ops2", { decision: "approve" }, { id }).statusCode, 403, "submitter");
  assert.equal(call(reviewWorksheetRegister, db, "u_ops", { decision: "approve" }, { id }).statusCode, 403, "builder");
  const detail = call(getWorksheetRegister, db, "u_ops", {}, { id }).body.data;
  assert.equal(detail.actions.can_review, false);
  assert.match(detail.actions.review_blocked_reason, /consolidated/);
  const ok = call(reviewWorksheetRegister, db, "u_sup", { decision: "approve", comment: "Matches paper sheets" }, { id });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.status, "Approved");
  assert.equal(ok.body.data.approved_by_name, "Supervisor One");
});

test("a roster member who is also a reviewer cannot approve their own time", () => {
  const db = makeDb();
  db.users.push({ id: "u_tech_sup", role: "Technician", name: "Dual Role", is_active: true });
  db.users.find((u) => u.id === "u_tech_sup").role = "Technician";
  addDaily(db, { id: "dts_1", entries: [row("2026-09-01", 9)] });
  const id = call(createWorksheetRegister, db, "u_ops", baseBody({ roster: [{ technician_id: "u_tech1" }, { technician_id: "u_tech2" }, { technician_id: "u_tech_sup" }] })).body.data.id;
  ackAll(db, id);
  assert.equal(call(submitWorksheetRegister, db, "u_ops2", {}, { id }).statusCode, 200);
  // Re-label the reviewer as a reviewer role while still on the roster by id.
  db.users.find((u) => u.id === "u_sup").role = "Technician";
  db.worksheet_registers[0].roster.push({ key: "t_u_sup", technician_id: "u_sup", display_name: "Supervisor One", group: "" });
  db.users.find((u) => u.id === "u_sup").role = "Supervisor";
  const res = call(reviewWorksheetRegister, db, "u_sup", { decision: "approve" }, { id });
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /own time/);
});

test("return needs a comment; a returned month is editable and re-submittable; approve/return only from Submitted", () => {
  const { db, id } = seeded();
  ackAll(db, id);
  assert.equal(call(reviewWorksheetRegister, db, "u_sup", { decision: "approve" }, { id }).statusCode, 409, "not yet submitted");
  call(submitWorksheetRegister, db, "u_ops2", {}, { id });
  assert.equal(call(reviewWorksheetRegister, db, "u_sup", { decision: "return" }, { id }).statusCode, 400);
  const ret = call(reviewWorksheetRegister, db, "u_sup", { decision: "return", comment: "Wrong site section" }, { id });
  assert.equal(ret.statusCode, 200);
  assert.equal(ret.body.data.status, "Returned_For_Correction");
  assert.equal(ret.body.data.supervisor_comment, "Wrong site section");
  assert.equal(call(updateWorksheetRegister, db, "u_ops", { title: "Corrected title" }, { id }).statusCode, 200);
  ackAll(db, id);
  assert.equal(call(submitWorksheetRegister, db, "u_ops2", {}, { id }).statusCode, 200);
  assert.deepEqual(db.worksheet_registers[0].history.map((h) => h.action).filter((a) => /Submitted|Returned/.test(a)), ["Submitted for approval", "Returned for correction", "Submitted for approval"]);
});

test("a stale consolidation cannot be submitted or approved: a source change forces a rebuild", () => {
  const { db, id } = seeded();
  ackAll(db, id);
  // A new draft appears for a rostered worker after the last build.
  addDaily(db, { id: "dts_late", status: "Draft", technician_id: "u_tech2", name: "Test Worker Two", entries: [row("2026-09-03", 9)] });
  let r = call(submitWorksheetRegister, db, "u_ops2", {}, { id });
  assert.equal(r.statusCode, 409); assert.equal(r.body.code, "STALE_BUILD");

  db.daily_timesheets.pop();
  assert.equal(call(submitWorksheetRegister, db, "u_ops2", {}, { id }).statusCode, 200);
  addDaily(db, { id: "dts_late2", status: "Returned_For_Correction", technician_id: "u_tech2", name: "Test Worker Two", entries: [row("2026-09-03", 9)] });
  r = call(reviewWorksheetRegister, db, "u_sup", { decision: "approve" }, { id });
  assert.equal(r.statusCode, 409); assert.equal(r.body.code, "STALE_BUILD");
  assert.equal(db.worksheet_registers[0].status, "Submitted");
});

test("two months cannot both claim the same Daily Time Sheet row: the second is told and cannot double-count", () => {
  const { db, id } = seeded();
  ackAll(db, id);
  call(submitWorksheetRegister, db, "u_ops2", {}, { id });
  const second = call(createWorksheetRegister, db, "u_ops", baseBody({ scope: { client_id: "c_test", project_title: "Another project" }, title: "Second" }));
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.data.totals.total_hours, 0, "rows are already counted in the first month");
  assert.ok(second.body.data.exceptions.some((e) => e.code === "ROW_CLAIMED_ELSEWHERE"));
});

test("a Draft month does not reserve rows, and cancelling a Submitted month releases them", () => {
  const { db, id } = seeded();
  const second = call(createWorksheetRegister, db, "u_ops", baseBody({ scope: { client_id: "c_test", project_title: "Another project" }, title: "Second" }));
  assert.equal(second.body.data.totals.normal, 27, "first month is only a Draft");
  ackAll(db, id);
  call(submitWorksheetRegister, db, "u_ops2", {}, { id });
  const cancel = call(cancelWorksheetRegister, db, "u_ops", { reason: "Created in error" }, { id });
  assert.equal(cancel.statusCode, 200);
  assert.equal(cancel.body.data.status, "Cancelled");
  const rebuilt = call(buildWorksheetRegister, db, "u_ops", {}, { id: second.body.data.id });
  assert.equal(rebuilt.body.data.totals.normal, 27);
});

test("an Approved month cannot be edited, rebuilt, or cancelled", () => {
  const { db, id } = seeded();
  ackAll(db, id);
  call(submitWorksheetRegister, db, "u_ops2", {}, { id });
  call(reviewWorksheetRegister, db, "u_sup", { decision: "approve" }, { id });
  assert.equal(call(updateWorksheetRegister, db, "u_ops", { title: "x" }, { id }).statusCode, 409);
  assert.equal(call(buildWorksheetRegister, db, "u_ops", {}, { id }).statusCode, 409);
  assert.equal(call(cancelWorksheetRegister, db, "u_ops", { reason: "nope" }, { id }).statusCode, 409);
  assert.equal(call(acknowledgeRegisterExceptions, db, "u_ops", { keys: ["x"], note: "abc" }, { id }).statusCode, 409);
});

test("reconciliation: refused before approval, then idempotent hours-only evidence after approval", () => {
  const { db, id } = seeded();
  ackAll(db, id);
  assert.equal(call(reconcileWorksheetRegister, db, "u_ops", { confirm: true }, { id }).statusCode, 409, "Draft");
  call(submitWorksheetRegister, db, "u_ops2", {}, { id });
  assert.equal(call(reconcileWorksheetRegister, db, "u_ops", { confirm: true }, { id }).statusCode, 409, "Submitted");
  call(reviewWorksheetRegister, db, "u_sup", { decision: "approve" }, { id });

  assert.throws(() => call(reconcileWorksheetRegister, db, "u_sup", { confirm: true }, { id }), /cannot perform/, "Supervisor cannot reconcile");
  const first = call(reconcileWorksheetRegister, db, "u_ops", { confirm: true }, { id });
  assert.equal(first.statusCode, 200, JSON.stringify(first.body));
  assert.equal(first.body.already_recorded, false);
  const ev = first.body.data.reconciliation;
  assert.equal(ev.status, "Evidence_Recorded_NonBillable");
  assert.equal(ev.billing.billable_entries_created, 0);
  assert.equal(first.body.data.reconciliation_state, "Evidence_Recorded");

  const auditCount = db.audit_logs.filter((a) => a.action === "REGISTER_RECONCILIATION_RECORDED").length;
  const second = call(reconcileWorksheetRegister, db, "u_ops2", { confirm: true }, { id });
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.already_recorded, true);
  assert.equal(second.body.data.reconciliation.id, ev.id, "same evidence, not a second record");
  assert.equal(db.audit_logs.filter((a) => a.action === "REGISTER_RECONCILIATION_RECORDED").length, auditCount, "no second audit entry");
});

test("no billing path: approval and reconciliation never create billable time, change existing billable entries, or touch invoices", () => {
  const { db, id } = seeded();
  db.timesheets.push({ id: "ts_pre", dispatch_card_id: "d1", user_id: "u_tech1", technician_id: "u_tech1", work_date: "2026-09-01", hours_logged: 8, hourly_rate: 40 });
  db.invoices.push({ id: "inv_1", status: "Issued" });
  const snapshot = JSON.stringify({ t: db.timesheets, i: db.invoices, w: db.field_worksheets });
  call(buildWorksheetRegister, db, "u_ops", {}, { id }); // pick up the new overlap, as a clerk must
  ackAll(db, id);
  call(submitWorksheetRegister, db, "u_ops2", {}, { id });
  call(reviewWorksheetRegister, db, "u_sup", { decision: "approve" }, { id });
  call(reconcileWorksheetRegister, db, "u_ops", { confirm: true }, { id });
  call(reconcileWorksheetRegister, db, "u_ops", { confirm: true }, { id });
  assert.equal(JSON.stringify({ t: db.timesheets, i: db.invoices, w: db.field_worksheets }), snapshot);
  assert.equal(db.timesheets.length, 1);
  const rec = db.worksheet_registers[0];
  assert.equal(rec.reconciliation.billing.state, "not_billed");
  assert.ok(rec.reconciliation.overlaps.billable_entries.length === 1 && rec.reconciliation.billing.overlap_hold, "existing billable entry for the same worker/date is recorded as an overlap hold");
});

test("reconciliation refuses evidence if a source Timesheet changed after approval", () => {
  const { db, id } = seeded();
  ackAll(db, id);
  call(submitWorksheetRegister, db, "u_ops2", {}, { id });
  call(reviewWorksheetRegister, db, "u_sup", { decision: "approve" }, { id });
  db.field_worksheets[0].hours_breakdown = { normal: 12, ot_15: 0, ot_20: 0 };
  const res = call(reconcileWorksheetRegister, db, "u_ops", { confirm: true }, { id });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "SOURCE_DRIFT");
  assert.equal(db.worksheet_registers[0].reconciliation, null);
});

test("rate-blind: no list, detail, document or evidence payload carries a rate, amount or cost field", () => {
  const { db, id } = seeded();
  ackAll(db, id);
  call(submitWorksheetRegister, db, "u_ops2", {}, { id });
  call(reviewWorksheetRegister, db, "u_sup", { decision: "approve" }, { id });
  call(reconcileWorksheetRegister, db, "u_ops", { confirm: true }, { id });
  for (const body of [call(listWorksheetRegisters, db, "u_ops").body, call(getWorksheetRegister, db, "u_ops", {}, { id }).body, call(getWorksheetRegisterDocument, db, "u_mgmt", {}, { id }).body]) {
    assert.deepEqual(moneyKeys(body), []);
  }
});

test("schemas are strict: a body carrying hourly_rate or any unknown key is a 400, not silently dropped", () => {
  for (const [schema, body] of [
    [CreateWorksheetRegisterSchema, { ...baseBody(), hourly_rate: 45 }],
    [CreateWorksheetRegisterSchema, baseBody({ roster: [{ technician_id: "u_tech1", hourly_rate: 45 }] })],
    [CreateWorksheetRegisterSchema, baseBody({ scope: { client_id: "c_test", project_title: "P", rate: 1 } })],
    [UpdateWorksheetRegisterSchema, { amount: 10 }],
    [ReconcileWorksheetRegisterSchema, { confirm: true, rate: 12 }],
    [ReviewWorksheetRegisterSchema, { decision: "approve", hourly_rate: 1 }]
  ]) {
    assert.equal(schema.safeParse(body).success, false, JSON.stringify(body).slice(0, 80));
    const res = makeRes(); let passed = false;
    validate(schema)({ body }, res, () => { passed = true; });
    assert.equal(passed, false); assert.equal(res.statusCode, 400);
  }
  assert.equal(CreateWorksheetRegisterSchema.safeParse(baseBody()).success, true);
  assert.equal(ReconcileWorksheetRegisterSchema.safeParse({}).success, false, "explicit confirm required");
  assert.equal(ReconcileWorksheetRegisterSchema.safeParse({ confirm: false }).success, false);
});

test("compatibility: existing Daily Time Sheets and Contractor Logs are read but never modified by any Worksheet action", () => {
  const { db, id } = seeded();
  db.contractor_log_sheets.push({ id: "clog_1", contractor_name: "Fictional Contractor", rows: [{ worker_name: "X", grade: "Artisan", normal: 9 }], status: "Supervisor_Approved" });
  const before = JSON.stringify({ d: db.daily_timesheets, c: db.contractor_log_sheets });
  ackAll(db, id);
  call(submitWorksheetRegister, db, "u_ops2", {}, { id });
  call(reviewWorksheetRegister, db, "u_sup", { decision: "approve" }, { id });
  call(reconcileWorksheetRegister, db, "u_ops", { confirm: true }, { id });
  assert.equal(JSON.stringify({ d: db.daily_timesheets, c: db.contractor_log_sheets }), before);
});

test("a data file saved before this feature gains an empty worksheet_registers collection and keeps every existing record", () => {
  const legacy = makeDb();
  addDaily(legacy, { id: "dts_keep", entries: [row("2026-09-01", 9)] });
  legacy.contractor_log_sheets.push({ id: "clog_keep", rows: [] });
  delete legacy.worksheet_registers;
  const snapshot = JSON.stringify({ d: legacy.daily_timesheets, c: legacy.contractor_log_sheets });
  const normalised = normalizeDb(legacy);
  assert.deepEqual(normalised.worksheet_registers, []);
  assert.equal(JSON.stringify({ d: normalised.daily_timesheets, c: normalised.contractor_log_sheets }), snapshot);
});

test("routes: explicit, authenticated, outside the generic collection list; Daily Time Sheet and Contractor Log routes are untouched", () => {
  const src = readFileSync(new URL("../src/router.js", import.meta.url), "utf8").replace(/\r/g, "");
  const authAt = src.indexOf("router.use(authMiddleware);");
  for (const frag of [
    'router.get("/worksheet_registers"', 'router.post("/worksheet_registers"', 'router.get("/worksheet_registers/:id"', 'router.patch("/worksheet_registers/:id"',
    'router.post("/worksheet_registers/:id/build"', 'router.post("/worksheet_registers/:id/acknowledge"', 'router.post("/worksheet_registers/:id/submit"',
    'router.post("/worksheet_registers/:id/review"', 'router.post("/worksheet_registers/:id/cancel"', 'router.post("/worksheet_registers/:id/reconcile"',
    'router.get("/document-data/worksheet_registers/:id"'
  ]) { assert.ok(src.indexOf(frag) > authAt, `${frag} must be registered after authMiddleware`); }
  const collections = /const collections = \[([\s\S]*?)\];/.exec(src)[1];
  assert.doesNotMatch(collections, /worksheet_registers/);
  for (const keep of [
    'router.post("/daily_timesheets", legacyFormCreationGate, validate(CreateDailyTimesheetSchema), createDailyTimesheet);',
    'router.patch("/daily_timesheets/:id", validate(UpdateDailyTimesheetSchema), updateDailyTimesheet);',
    'router.post("/daily_timesheets/:id/submit", submitDailyTimesheet);',
    'router.post("/daily_timesheets/:id/review", validate(ReviewDailyTimesheetSchema), reviewDailyTimesheet);',
    'router.get("/document-data/daily_timesheets/:id", getDailyTimesheetDocument);',
    'router.post("/contractor_log_sheets", legacyFormCreationGate, validate(CreateContractorLogSchema), createContractorLog);',
    'router.get("/document-data/contractor_log_sheets/:id", getContractorLogDocument);'
  ]) assert.ok(src.includes(keep), keep);
});

test("the monthly controller never writes to db.timesheets or reads a rate field", () => {
  for (const f of ["../src/controllers/worksheetRegisterController.js", "../src/worksheetRegisterLogic.js"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.doesNotMatch(src, /\.timesheets\.(push|splice|unshift)|db\.timesheets\s*=/, `${f} writes billable time`);
    assert.doesNotMatch(src, /hourly_rate|\.rate\b|unit_price/, `${f} touches a rate`);
  }
});
