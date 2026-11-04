// Phase 3 roll-up: 10 approved daily Timesheets with varying hours must aggregate to exact totals.
// Every expected figure is worked out BY HAND below (never by calling the code under test).
// Fictional data only. Dependency-free: controller handlers are called directly.
import test from "node:test";
import assert from "node:assert/strict";
import { previewWorksheetRegister, createWorksheetRegister } from "../src/controllers/worksheetRegisterController.js";
import { PreviewWorksheetRegisterSchema, CreateWorksheetRegisterSchema } from "../src/worksheetRegisterSchemas.js";
import { validate } from "../src/middleware/validate.js";
import { makeDb, makeRes, req, addTimesheet, baseBody } from "./helpers/worksheetRegisterFixture.js";

const call = (fn, db, user, body = {}) => { const res = makeRes(); fn(req(db, user, body), res); return res; };
const bucket = (t) => [t.normal, t.ot_15, t.ot_20, t.total_hours];

//  id    worker  date        Normal  1.5   2.0
//  m1    tech1   2026-10-01   8      2     0
//  m2    tech1   2026-10-02   8      1     0
//  m3    tech1   2026-10-03   7.5    0     0
//  m4    tech1   2026-10-04   6      0     4     (Sunday)
//  m5    tech2   2026-10-01   9      0     0
//  m6    tech2   2026-10-02   8      3     0
//  m7    tech2   2026-10-05   8.5    1.5   0
//  m8    tech2   2026-10-11   0      0     8     (Sunday)
//  m9    tech2   2026-10-12   4      0     0
//  m10   tech1   2026-10-12   8      0.5   0
// tech1: Normal 8+8+7.5+6+8 = 37.5 | 1.5: 2+1+0+0+0.5 = 3.5 | 2.0: 4 | total 45
// tech2: Normal 9+8+8.5+0+4 = 29.5 | 1.5: 0+3+1.5+0+0 = 4.5 | 2.0: 8 | total 42
// grand: Normal 67 | 1.5: 8 | 2.0: 12 | total 87
function tenSheets(db) {
  const t = (id, tech, date, normal, ot_15, ot_20) => addTimesheet(db, { id, technician_id: tech, date, breakdown: { normal, ot_15, ot_20 } });
  t("m1", "u_tech1", "2026-10-01", 8, 2, 0); t("m2", "u_tech1", "2026-10-02", 8, 1, 0);
  t("m3", "u_tech1", "2026-10-03", 7.5, 0, 0); t("m4", "u_tech1", "2026-10-04", 6, 0, 4);
  t("m5", "u_tech2", "2026-10-01", 9, 0, 0); t("m6", "u_tech2", "2026-10-02", 8, 3, 0);
  t("m7", "u_tech2", "2026-10-05", 8.5, 1.5, 0); t("m8", "u_tech2", "2026-10-11", 0, 0, 8);
  t("m9", "u_tech2", "2026-10-12", 4, 0, 0); t("m10", "u_tech1", "2026-10-12", 8, 0.5, 0);
}
const body = (over = {}) => baseBody({ title: "Fictional Shutdown - October 2026", period_start: "2026-10-01", period_end: "2026-10-31", ...over });

test("10 approved daily sheets roll up to the exact per-worker and grand totals", () => {
  const db = makeDb(); tenSheets(db);
  const res = call(previewWorksheetRegister, db, "u_ops", body());
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const p = res.body.data;
  const byName = Object.fromEntries(p.grid.rows.map((r) => [r.display_name, bucket(r.totals)]));
  assert.deepEqual(byName, { "Test Worker One": [37.5, 3.5, 4, 45], "Test Worker Two": [29.5, 4.5, 8, 42] });
  assert.deepEqual(bucket(p.totals), [67, 8, 12, 87]);
  assert.equal(p.summary.source_records, 10);
  assert.equal(p.summary.worker_days, 10);
  assert.equal(p.persisted, false);
});

test("Consolidate saves exactly the previewed figures; preview itself writes nothing", () => {
  const db = makeDb(); tenSheets(db);
  const pv = call(previewWorksheetRegister, db, "u_ops", body()).body.data;
  assert.equal(db.worksheet_registers.length, 0);
  assert.equal(db.audit_logs.length, 0);
  const saved = call(createWorksheetRegister, db, "u_ops", { ...body(), preview_hash: pv.preview_hash });
  assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
  assert.deepEqual(bucket(saved.body.data.totals), [67, 8, 12, 87]);
  assert.equal(db.worksheet_registers.length, 1);
  assert.equal(db.audit_logs.filter((a) => a.action === "REGISTER_CREATED").length, 1);
});

test("only approved, in-scope, in-period sheets count: a draft, another client and a far date change no hours", () => {
  const db = makeDb(); tenSheets(db);
  addTimesheet(db, { id: "x_draft", technician_id: "u_tech1", date: "2026-10-20", status: "Submitted", approved: false, breakdown: { normal: 11, ot_15: 0, ot_20: 0 } });
  addTimesheet(db, { id: "x_other", technician_id: "u_tech2", dispatch: "d_other", date: "2026-10-21", breakdown: { normal: 12, ot_15: 0, ot_20: 0 } });
  addTimesheet(db, { id: "x_far", technician_id: "u_tech1", date: "2027-02-01", breakdown: { normal: 7, ot_15: 0, ot_20: 0 } });
  const p = call(previewWorksheetRegister, db, "u_ops", body()).body.data;
  assert.deepEqual(bucket(p.totals), [67, 8, 12, 87]);
  assert.equal(p.summary.worker_days, 10);
});

test("a sheet approved after the preview makes Consolidate refuse (STALE_PREVIEW) and save nothing", () => {
  const db = makeDb(); tenSheets(db);
  const late = addTimesheet(db, { id: "m_late", technician_id: "u_tech1", date: "2026-10-20", status: "Submitted", approved: false, breakdown: { normal: 10, ot_15: 0, ot_20: 0 } });
  const first = call(previewWorksheetRegister, db, "u_ops", body()).body.data;
  late.status = "Supervisor_Approved"; late.approved_by = "u_sup"; late.approved_at = "2026-10-30T00:00:00.000Z";
  const refused = call(createWorksheetRegister, db, "u_ops", { ...body(), preview_hash: first.preview_hash });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.body.code, "STALE_PREVIEW");
  assert.equal(db.worksheet_registers.length, 0);
  assert.equal(db.audit_logs.length, 0);
  const second = call(previewWorksheetRegister, db, "u_ops", body()).body.data;
  assert.deepEqual(bucket(second.totals), [77, 8, 12, 97]); // 67 + the 10 Normal hours now approved
});

test("a second Consolidate for the same client, project and period is refused", () => {
  const db = makeDb(); tenSheets(db);
  assert.equal(call(createWorksheetRegister, db, "u_ops", body()).statusCode, 200);
  assert.equal(call(createWorksheetRegister, db, "u_ops", body()).statusCode, 409);
  const again = call(previewWorksheetRegister, db, "u_ops", body()).body.data;
  assert.equal(again.can_consolidate, false);
  assert.ok(again.existing_register.reference);
});

test("schemas stay strict: hours, rates and unknown keys are rejected; preview_hash is create-only SHA-256", () => {
  const run = (schema, b) => { const r = makeRes(); let ok = false; validate(schema)({ body: b }, r, () => { ok = true; }); return ok; };
  assert.equal(run(PreviewWorksheetRegisterSchema, body()), true);
  for (const extra of [{ hourly_rate: 45 }, { normal_hours: 8 }, { totals: {} }, { preview_hash: "a".repeat(64) }]) assert.equal(run(PreviewWorksheetRegisterSchema, { ...body(), ...extra }), false, JSON.stringify(extra));
  assert.equal(run(CreateWorksheetRegisterSchema, { ...body(), preview_hash: "a".repeat(64) }), true);
  assert.equal(run(CreateWorksheetRegisterSchema, { ...body(), preview_hash: "xyz" }), false);
});

test("Sales: blocked by default, allowed (preview + consolidate + submit) with TIMESHEET_SALES_ACCESS=enabled", () => {
  const FLAG = "TIMESHEET_SALES_ACCESS"; const saved = process.env[FLAG];
  try {
    delete process.env[FLAG];
    const db = makeDb(); tenSheets(db);
    assert.throws(() => call(previewWorksheetRegister, db, "u_sales", body()), /cannot perform manageWorksheetRegister/);
    process.env[FLAG] = "enabled";
    const pv = call(previewWorksheetRegister, db, "u_sales", body());
    assert.equal(pv.statusCode, 200);
    const made = call(createWorksheetRegister, db, "u_sales", { ...body(), preview_hash: pv.body.data.preview_hash });
    assert.equal(made.statusCode, 200, JSON.stringify(made.body));
  } finally { if (saved === undefined) delete process.env[FLAG]; else process.env[FLAG] = saved; }
});
