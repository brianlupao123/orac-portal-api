// Contract steps 3-9, dark-by-default. Dependency-free; synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { hasPermission } from "../src/permissions.js";
import * as W from "../src/timesheetWorkflow.js";
import * as C from "../src/controllers/timesheetWorkflowController.js";
import { acknowledgeWorksheet } from "../src/controllers/timesheetAcknowledgementController.js";
import { isEligibleForDb } from "../src/timesheetEligibility.js";
import { issueLegacyInvoice, transitionQuote } from "../src/stateMachine.js";
import { makeRes, makeReq } from "./_http.js";
import { createWorksheet, updateWorksheet, submitWorksheet } from "../src/controllers/dispatchController.js";
import { CreateTimesheetSchemaV2 } from "../src/timesheetSchemasV2.js";

const ALL = ["TIMESHEET_ELIGIBILITY_CUTOVER", "TIMESHEET_CLIENT_RETURN", ...Object.values(W.FLAGS)];
const withFlags = (flags, fn) => async () => {
  const saved = {}; for (const k of ALL) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const k of flags) process.env[k] = "enabled";
  try { await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const u = (id, role, extra = {}) => ({ id, role, is_active: true, name: id, ...extra });
const signed = { employee: { name: "W", date: "2026-03-02", method: "paper_scan" } };
const ws = (o = {}) => ({ id: "ws1", dispatch_card_id: "d1", technician_id: "t1", work_date: "2026-03-02", hours: 8, timesheet_version: 2,
  hours_breakdown: { normal: 8, ot_15: 0, ot_20: 0 }, signatures: signed, signed_copy_image: "img", status: "Submitted", ...o });
function makeDb(sheets = [], extra = {}) {
  return { users: [u("admin", "Admin"), u("sales1", "Sales"), u("sales2", "Sales"), u("fin1", "Finance"), u("fin2", "Finance"), u("fin3", "Finance"), u("ops", "Operations"),
      u("t1", "Technician"), u("ca", "Client Viewer", { client_id: "c1" }), u("cb", "Client Viewer", { client_id: "c1" }), u("cx", "Client Viewer", { client_id: "c2" })],
    clients: [{ id: "c1", name: "C1", timesheet_cutover_date: "2026-03-01" }, { id: "c2", name: "C2" }],
    quotes: [{ id: "q1", client_id: "c1", total_amount: 100, status: "Field_Dispatch" }], dispatch_cards: [{ id: "d1", quotation_id: "q1", scheduled_start: "2026-03-01", scheduled_end: "2026-03-31" }],
    purchase_orders: [{ id: "po1", quotation_id: "q1", status: "verified", po_reference: "PO-1", po_amount: 1000, date_received: "2026-03-01" }], invoices: [], invoice_lines: [], material_usage: [],
    field_worksheets: sheets, timesheets: [], stock_movements: [], timesheet_authorities: [], timesheet_paper_custody: [], timesheet_variance_overrides: [], notifications: [], audit_logs: [],
    company_profile: {}, mine_sites: [], plants: [], plant_sections: [], equipment_tags: [], ...extra };
}
const store = () => { let n = 0; const audits = []; return { audits, id: (p) => `${p}_${++n}`, audit: (db, a, t, id, action, b, after) => audits.push({ action, id, after }) }; };
const stores = new WeakMap();
const call = (fn, { db, st = stores.get(db) || stores.set(db, store()).get(db), user, params = {}, body = {} }) => { const res = makeRes(); fn(makeReq({ db, store: st, user: { id: user }, params, body }), res); return res; };
const authority = (o = {}) => ({ id: "a1", kind: "authoriser", client_id: "c1", user_id: "ca", status: "active", start_date: "2026-01-01", end_date: null, evidence_reference: "letter", ...o });

test("flags off: permissions identical to base, every new handler refuses", withFlags([], () => {
  assert.equal(hasPermission(u("s", "Sales"), "viewWorksheetRegister"), true);
  assert.equal(hasPermission(u("o", "Operations"), "addTimesheet"), true);
  assert.equal(hasPermission(u("o", "Operations"), "manageWorksheetRegister"), true);
  const db = makeDb([ws()]);
  for (const [fn, user] of [[C.listTimesheetsRateFree, "sales1"], [C.capturePaperTimesheet, "sales1"], [C.batchConfirmTimesheets, "ca"], [C.runTimesheetReminders, "admin"]]) {
    assert.equal(call(fn, { db, user }).body.code, "FEATURE_DISABLED");
  }
  assert.equal(W.invoiceVarianceGate(db, "d1").allow, true);
  assert.equal(W.workDateValidity(db, ws({ work_date: "2020-01-01" })).valid, true);
  assert.equal(W.kioskBlocked(db), false);
}));

test("step 3/6/7 overlays: Sales/Finance gain rate-free + Worksheet roles; Operations loses rate rows and Worksheet rights", withFlags(["TIMESHEET_SALES_ACCESS", "TIMESHEET_RATE_ROW_RESTRICT", "TIMESHEET_OPS_RESTRICT"], () => {
  const p = (role, perm) => hasPermission(u("x", role), perm);
  assert.equal(p("Sales", "manageWorksheetRegister"), true); assert.equal(p("Sales", "reviewWorksheetRegister"), true);
  assert.equal(p("Operations", "manageWorksheetRegister"), false); assert.equal(p("Supervisor", "reviewWorksheetRegister"), false);
  assert.equal(p("Finance", "reconcileWorksheetRegister"), true); assert.equal(p("Operations", "reconcileWorksheetRegister"), false);
  assert.equal(p("Operations", "addTimesheet"), false); assert.equal(p("Technician", "addTimesheet"), false);
  assert.equal(p("Finance", "addTimesheet"), true); assert.equal(p("Admin", "addTimesheet"), true);
  assert.equal(p("Sales", "addTimesheet"), false);
  assert.equal(p("Client Viewer", "viewTimesheetsRateFree"), false);
  const db = makeDb([ws({ hourly_rate: 99, rate: 5 })]);
  const res = call(C.listTimesheetsRateFree, { db, user: "sales1" });
  assert.equal(res.statusCode, 200); assert.equal(JSON.stringify(res.body).includes("rate"), false);
  assert.throws(() => call(C.listTimesheetsRateFree, { db, user: "ca" }), /cannot perform/);
}));

test("step 4: authority records validate; delegate needs end date, cap, same client, named authoriser", withFlags(["TIMESHEET_AUTHORITY"], () => {
  const db = makeDb(); const base = { client_id: "c1", user_id: "ca", kind: "authoriser", start_date: "2026-03-01", evidence_reference: "email" };
  assert.deepEqual(W.validateAuthorityInput(db, base), []);
  assert.ok(W.validateAuthorityInput(db, { ...base, evidence_reference: "" }).length);
  assert.ok(W.validateAuthorityInput(db, { ...base, user_id: "t1" }).length);
  assert.ok(W.validateAuthorityInput(db, { ...base, user_id: "cx" }).length);
  db.timesheet_authorities.push(authority());
  const d = { ...base, user_id: "cb", kind: "delegate", delegate_for_authority_id: "a1", end_date: "2026-03-20" };
  assert.deepEqual(W.validateAuthorityInput(db, d), []);
  assert.ok(W.validateAuthorityInput(db, { ...d, end_date: "2026-05-01" }).length);
  assert.ok(W.validateAuthorityInput(db, { ...d, end_date: undefined }).length);
  assert.equal(call(C.createTimesheetAuthority, { db, user: "admin", body: base }).statusCode, 201);
  assert.throws(() => call(C.createTimesheetAuthority, { db, user: "sales1", body: base }), /cannot perform/);
}));

test("step 4: after cutover only an active authoriser confirms; snapshot makes it eligible; ordinary client is refused", withFlags(["TIMESHEET_AUTHORITY", "TIMESHEET_ELIGIBILITY_CUTOVER"], () => {
  const db = makeDb([ws()]); db.timesheet_authorities.push(authority());
  let res = call(acknowledgeWorksheet, { db, user: "cb", params: { id: "ws1" }, body: { signer_name: "S", signer_role: "R" } });
  assert.equal(res.statusCode, 403); assert.equal(res.body.code, "AUTHORITY_REQUIRED"); assert.equal(db.field_worksheets[0].status, "Submitted");
  res = call(acknowledgeWorksheet, { db, user: "ca", params: { id: "ws1" }, body: { signer_name: "S", signer_role: "R" } });
  assert.equal(res.statusCode, 200);
  const rec = db.field_worksheets[0];
  assert.equal(rec.client_acknowledgement.authority_snapshot.active, true);
  assert.match(rec.client_acknowledgement.confirmation_statement, /not approval of rates/);
  assert.equal(isEligibleForDb(db, rec), true);
  // revoked authority: no confirmation, but the stored one remains valid
  const db2 = makeDb([ws()]); db2.timesheet_authorities.push(authority({ status: "revoked", revoked_at: "2026-03-02" }));
  res = call(acknowledgeWorksheet, { db: db2, user: "ca", params: { id: "ws1" }, body: { signer_name: "S", signer_role: "R" } });
  assert.match(res.body.message, /Awaiting Client Authority/);
}));

test("step 4: revoke is immediate, cascades to delegates; cutover is one-way after confirmations", withFlags(["TIMESHEET_AUTHORITY"], () => {
  const db = makeDb(); db.timesheet_authorities.push(authority(), authority({ id: "a2", kind: "delegate", user_id: "cb", delegate_for_authority_id: "a1", end_date: "2026-12-31" }));
  call(C.revokeTimesheetAuthority, { db, user: "admin", params: { id: "a1" } });
  assert.equal(db.timesheet_authorities[1].status, "revoked");
  assert.equal(W.anyActiveAuthority(db, "c1", "2026-03-05"), false);
  const db2 = makeDb([ws({ status: "Client_Acknowledged", client_acknowledgement: { acknowledged_at: "2026-03-03T00:00:00Z", authority_snapshot: { active: true } } })]);
  assert.equal(call(C.setClientCutover, { db: db2, user: "admin", params: { id: "c1" }, body: { timesheet_cutover_date: "2026-04-01" } }).statusCode, 409);
  assert.equal(call(C.setClientCutover, { db: db2, user: "admin", params: { id: "c2" }, body: { timesheet_cutover_date: "2026-04-01" } }).statusCode, 200);
}));

const capture = (o = {}) => ({ dispatch_card_id: "d1", technician_id: "t1", work_date: "2026-03-04", hours: 8, hours_breakdown: { normal: 8, ot_15: 0, ot_20: 0 },
  reason_code: "client_not_on_portal", source_channel: "email_scan", client_paper_reference: "P-1", received_date: "2026-03-05", custodian_user_id: "sales1",
  custody_location: "Cabinet A", retention_category: "std", scan_hash: "abc123", legible_and_signed: true, ...o });
const cfg = (db) => { db.company_profile.timesheet_policy = { paper_channels: ["email_scan"], retention_categories: ["std"], paper_capture_user_ids: ["sales1"] }; };

test("step 5: capture is blocked by safe defaults until owner config exists", withFlags(["TIMESHEET_PAPER_CAPTURE"], () => {
  const db = makeDb(); const res = call(C.capturePaperTimesheet, { db, user: "sales1", body: capture() });
  assert.equal(res.statusCode, 409); assert.equal(res.body.code, "CAPTURE_BLOCKED"); assert.equal(db.field_worksheets.length, 0);
  assert.throws(() => call(C.capturePaperTimesheet, { db, user: "ops", body: capture() }), /cannot perform/);
}));

test("step 5: complete capture is eligible, records the Sales actor, never impersonates a client, creates zero stock movements", withFlags(["TIMESHEET_PAPER_CAPTURE", "TIMESHEET_ELIGIBILITY_CUTOVER"], () => {
  const db = makeDb(); cfg(db);
  const res = call(C.capturePaperTimesheet, { db, user: "sales1", body: capture() });
  assert.equal(res.statusCode, 201);
  const rec = db.field_worksheets[0];
  assert.equal(rec.status, "Captured_From_Signed_Paper"); assert.equal(rec.paper_capture.captured_by, "sales1"); assert.equal(rec.paper_capture.signatory_authenticated, false);
  assert.equal(rec.client_acknowledgement, undefined); assert.equal(isEligibleForDb(db, rec), true);
  assert.equal(db.stock_movements.length, 0); assert.equal(db.material_usage.length, 0);
  // duplicate refused
  assert.equal(call(C.capturePaperTimesheet, { db, user: "sales1", body: capture() }).body.code, "DUPLICATE_TIMESHEET");
  // incomplete -> ineligible Draft
  const bad = call(C.capturePaperTimesheet, { db, user: "sales1", body: capture({ work_date: "2026-03-05", legible_and_signed: false }) });
  assert.equal(db.field_worksheets.at(-1).status, "Draft"); assert.equal(isEligibleForDb(db, db.field_worksheets.at(-1)), false); assert.ok(bad.body.missing.includes("legible_and_signed"));
  // classes must sum; unlisted Sales user refused
  assert.equal(call(C.capturePaperTimesheet, { db, user: "sales1", body: capture({ work_date: "2026-03-06", hours: 9 }) }).statusCode, 400);
  assert.equal(call(C.capturePaperTimesheet, { db, user: "sales2", body: capture({ work_date: "2026-03-07" }) }).statusCode, 409);
}));

test("step 5: capture over an already client-confirmed record is blocked as duplicate", withFlags(["TIMESHEET_PAPER_CAPTURE"], () => {
  const db = makeDb([ws({ id: "x", work_date: "2026-03-04", status: "Client_Acknowledged" })]); cfg(db);
  assert.equal(call(C.capturePaperTimesheet, { db, user: "sales1", body: capture() }).body.code, "DUPLICATE_TIMESHEET");
}));

test("step 5: custody log is Sales/Ops/Admin only and Operations cannot capture", withFlags(["TIMESHEET_PAPER_CAPTURE"], () => {
  const db = makeDb(); const b = { from: "ops", to: "sales1", paper_reference: "P-1" };
  assert.equal(call(C.logPaperCustody, { db, user: "ops", body: b }).statusCode, 201);
  assert.throws(() => call(C.logPaperCustody, { db, user: "fin1", body: b }), /cannot perform/);
  assert.equal(hasPermission(u("o", "Operations"), "captureTimesheetPaper"), false);
}));

test("step 6: reviewer separation covers builder, submitter, roster and paper capturers; paused when nobody qualifies", withFlags(["TIMESHEET_SALES_ACCESS"], () => {
  const db = makeDb([ws({ id: "p1", paper_capture: { captured_by: "sales2" } })]);
  const rec = { built_by: "sales1", submitted_by: "sales1", roster: [], lines: [{ sources: [{ source_type: "timesheet", record_id: "p1" }] }] };
  assert.match(W.worksheetReviewerRefusal(db, rec, db.users.find((x) => x.id === "sales1")), /builder/);
  assert.match(W.worksheetReviewerRefusal(db, rec, db.users.find((x) => x.id === "sales2")), /captured paper/);
  assert.equal(W.eligibleWorksheetReviewers(db, rec).length, 0); assert.equal(W.reviewPaused(db, rec), true);
  db.users.push(u("sales3", "Sales")); assert.equal(W.reviewPaused(db, rec), false);
  // Admin only reviews when named as fallback
  const only = makeDb([], {}); only.users = [u("admin", "Admin"), u("s1", "Sales")];
  assert.equal(W.reviewPaused(only, { built_by: "s1", submitted_by: "s1", roster: [], lines: [] }), true);
  only.company_profile.timesheet_policy = { fallback_reviewer_user_ids: ["admin"] };
  assert.equal(W.reviewPaused(only, { built_by: "s1", submitted_by: "s1", roster: [], lines: [] }), false);
}));

const eligSheet = (id, h, bd) => ws({ id, status: "Supervisor_Approved", hours: h, hours_breakdown: bd || { normal: h, ot_15: 0, ot_20: 0 } });
const bill = (id, h, extra = {}) => ({ id, dispatch_card_id: "d1", hours_logged: h, hourly_rate: 10, created_by: "fin1", ...extra });

test("step 7: variance compares to two decimals; billed>eligible blocks, billed<eligible warns, no source blocks", withFlags(["TIMESHEET_INVOICE_VARIANCE"], () => {
  const db = makeDb([eligSheet("a", 8)]);
  db.timesheets = [bill("b1", 8)]; let v = W.computeVariance(db, "d1"); assert.equal(v.blocked, false); assert.equal(v.warnings.length, 0);
  db.timesheets = [bill("b1", 8.01)]; v = W.computeVariance(db, "d1"); assert.equal(v.blocked, true);
  db.timesheets = [bill("b1", 7.5)]; v = W.computeVariance(db, "d1"); assert.equal(v.blocked, false); assert.equal(v.warnings.length, 1);
  db.field_worksheets = []; db.timesheets = [bill("b1", 1)]; assert.equal(W.computeVariance(db, "d1").blocked, true);
  // class-level compare when every billing row is classed
  const db2 = makeDb([eligSheet("a", 8, { normal: 6, ot_15: 2, ot_20: 0 })]);
  db2.timesheets = [bill("b", 8, { hours_breakdown: { normal: 8, ot_15: 0, ot_20: 0 } })];
  v = W.computeVariance(db2, "d1"); assert.equal(v.blocked, true); assert.equal(v.blocks[0].class, "normal");
  // total-only row => total compare only
  db2.timesheets = [bill("b", 8)]; assert.equal(W.computeVariance(db2, "d1").blocked, false);
}));

test("step 7: invoice is blocked, an override needs a different second approver, and goes stale when hours change", withFlags(["TIMESHEET_INVOICE_VARIANCE"], () => {
  const db = makeDb([eligSheet("a", 8)]); db.timesheets = [bill("b1", 9)];
  db.company_profile.timesheet_policy = { override_user_ids: ["fin2", "fin3"] };
  assert.equal(W.invoiceVarianceGate(db, "d1").allow, false);
  const body = { reason_code: "client_agreed", reason_text: "Agreed extra hour", evidence_reference: "email-1" };
  assert.match(call(C.requestVarianceOverride, { db, user: "fin1", params: { id: "d1" }, body }).body.message, /created billing rows|named override/); // creator of rows
  assert.throws(() => call(C.requestVarianceOverride, { db, user: "sales1", params: { id: "d1" }, body }), /cannot perform/);
  const req = call(C.requestVarianceOverride, { db, user: "fin2", params: { id: "d1" }, body }); assert.equal(req.statusCode, 201);
  assert.equal(req.body.data.second_approval_required, true);
  assert.equal(W.invoiceVarianceGate(db, "d1").allow, false, "not allowed until second approval");
  assert.equal(call(C.approveVarianceOverride, { db, user: "fin2", params: { id: req.body.data.id } }).statusCode, 403);
  assert.equal(call(C.approveVarianceOverride, { db, user: "fin3", params: { id: req.body.data.id } }).statusCode, 200);
  assert.equal(W.invoiceVarianceGate(db, "d1").overridden, true);
  db.timesheets.push(bill("b2", 1)); // hours changed
  assert.equal(W.invoiceVarianceGate(db, "d1").allow, false);
}));

test("step 7: createInvoice is gated, locks included Timesheets, and is unchanged with the flag off", async () => {
  const attempt = (billed) => {
    const db = makeDb([eligSheet("a", 8)]); db.timesheets = [bill("b1", billed, { approved: true })];
    let err = null; try { issueLegacyInvoice(db, store(), "q1", db.users.find((x) => x.id === "fin1")); } catch (e) { err = e; }
    return { db, err };
  };
  await withFlags([], () => { const { db, err } = attempt(9); assert.equal(err, null, err?.message); assert.equal(db.invoices.length, 1); assert.equal(db.field_worksheets[0].invoice_locked, undefined); })();
  await withFlags(["TIMESHEET_INVOICE_VARIANCE"], () => { const { db, err } = attempt(9); assert.equal(err.code, "INVOICE_VARIANCE_BLOCK"); assert.equal(err.status, 409); assert.equal(db.invoices.length, 0); })();
  await withFlags(["TIMESHEET_INVOICE_VARIANCE"], () => { const { db, err } = attempt(8); assert.equal(err, null, err?.message); assert.equal(db.field_worksheets[0].invoice_locked.invoice_id, db.invoices[0].id); })();
});

test("step 8: batch confirm needs explicit ids, one dispatch, reports per-record results, sends warned records to individual open", withFlags(["TIMESHEET_BATCH_CONFIRM", "TIMESHEET_AUTHORITY"], () => {
  const db = makeDb([ws({ id: "w1" }), ws({ id: "w2", work_date: "2026-03-03", hours_breakdown: { normal: 6, ot_15: 2, ot_20: 0 } }), ws({ id: "w3", work_date: "2026-03-04", status: "Draft" })]);
  db.timesheet_authorities.push(authority());
  const body = { ids: ["w1", "w2", "w3", "nope"], signer_name: "S", signer_role: "R", acknowledgement: true };
  assert.equal(call(C.batchConfirmTimesheets, { db, user: "ca", body: { ...body, ids: [] } }).statusCode, 400);
  assert.equal(call(C.batchConfirmTimesheets, { db, user: "ca", body: { ...body, acknowledgement: false } }).statusCode, 400);
  const res = call(C.batchConfirmTimesheets, { db, user: "ca", body });
  const by = Object.fromEntries(res.body.results.map((r) => [r.id, r]));
  assert.equal(by.w1.ok, true); assert.equal(by.w2.code, "OPEN_INDIVIDUALLY"); assert.equal(by.w3.code, "NOT_AWAITING_CONFIRMATION"); assert.equal(by.nope.code, "NOT_FOUND_OR_OUT_OF_SCOPE");
  assert.equal(db.field_worksheets[0].client_acknowledgement.authority_snapshot.active, true);
  assert.equal(call(C.batchConfirmTimesheets, { db, user: "cb", body: { ...body, ids: ["w2"] } }).body.results[0].code, "OPEN_INDIVIDUALLY");
  assert.equal(call(C.batchConfirmTimesheets, { db, user: "cx", body: { ...body, ids: ["w3"] } }).body.results[0].code, "NOT_FOUND_OR_OUT_OF_SCOPE");
}));

test("step 8: reminders use business days, are idempotent per stage, never approve, and flag the paused case", withFlags(["TIMESHEET_REMINDERS"], () => {
  assert.equal(W.businessDaysBetween("2026-03-06", "2026-03-09"), 1); // Fri -> Mon
  assert.equal(W.businessDaysBetween("2026-03-06", "2026-03-09", ["2026-03-09"]), 0);
  assert.equal(W.reminderStage(1, [2, 5, 10]), 0); assert.equal(W.reminderStage(5, [2, 5, 10]), 2); assert.equal(W.reminderStage(30, [2, 5, 10]), 3);
  const db = makeDb([ws({ submitted_at: "2020-01-06T00:00:00Z" })]); const st = store();
  const first = call(C.runTimesheetReminders, { db, st, user: "admin" });
  assert.equal(first.body.emitted.length, 1); assert.equal(first.body.emitted[0].action, "TIMESHEET_AWAITING_AUTHORITY");
  assert.equal(call(C.runTimesheetReminders, { db, st, user: "admin" }).body.emitted.length, 0);
  assert.equal(db.field_worksheets[0].status, "Submitted");
  db.timesheet_authorities.push(authority()); db.field_worksheets[0].reminder_stage = 0;
  assert.equal(call(C.runTimesheetReminders, { db, st, user: "admin" }).body.emitted[0].action, "TIMESHEET_ESCALATION");
}));

test("step 9: kiosk restriction, PO validity gate and policy validation", withFlags(["TIMESHEET_OPS_RESTRICT", "TIMESHEET_PO_VALIDITY"], () => {
  const db = makeDb(); assert.equal(W.kioskBlocked(db), false);
  db.company_profile.timesheet_policy = { kiosk_mode: "hidden" }; assert.equal(W.kioskBlocked(db), true);
  assert.equal(W.workDateValidity(db, ws({ work_date: "2026-04-15" })).blocks, true);
  assert.equal(W.workDateValidity(db, ws({ work_date: "2026-03-10" })).valid, true);
  db.dispatch_cards[0].started_before_po = true; db.purchase_orders[0].date_received = "2026-03-20";
  assert.equal(W.workDateValidity(db, ws({ work_date: "2026-03-10" })).blocks, true, "retroactive PO not allowed by default");
  db.company_profile.timesheet_policy.allow_retroactive_po = true; assert.equal(W.workDateValidity(db, ws({ work_date: "2026-03-10" })).valid, true);
  assert.ok(W.validatePolicyPatch({ nope: 1 }).length); assert.ok(W.validatePolicyPatch({ delegate_max_days: 400 }).length); assert.deepEqual(W.validatePolicyPatch({ kiosk_mode: "restricted" }), []);
  const bad = call(C.updateTimesheetPolicy, { db, user: "admin", body: { kiosk_mode: "x" } }); assert.equal(bad.statusCode, 400);
  assert.throws(() => call(C.updateTimesheetPolicy, { db, user: "sales1", body: {} }), /cannot perform/);
}));

test("step 9: out-of-validity work date makes a confirmed record ineligible through the shared predicate", withFlags(["TIMESHEET_ELIGIBILITY_CUTOVER", "TIMESHEET_PO_VALIDITY"], () => {
  const db = makeDb([ws({ id: "o", work_date: "2026-05-01", status: "Supervisor_Approved" }), ws({ id: "i", status: "Supervisor_Approved" })]);
  assert.equal(isEligibleForDb(db, db.field_worksheets[0]), false); assert.equal(isEligibleForDb(db, db.field_worksheets[1]), true);
}));

test("revision swap: original stays eligible until the revision is eligible; invoice-locked original is not swapped", withFlags(["TIMESHEET_ELIGIBILITY_CUTOVER"], () => {
  const orig = ws({ id: "o", status: "Supervisor_Approved" });
  const rev = ws({ id: "r", status: "Supervisor_Approved", revises_worksheet_id: "o" });
  const db = makeDb([orig, rev]); const st = store();
  assert.equal(isEligibleForDb(db, orig), true);
  assert.equal(W.swapRevisionIfEligible(db, st, { id: "x" }, rev), true); assert.equal(orig.superseded_by, "r"); assert.equal(isEligibleForDb(db, orig), false);
  const o2 = ws({ id: "o2", status: "Supervisor_Approved", invoice_locked: { invoice_id: "i" } }); const r2 = ws({ id: "r2", status: "Supervisor_Approved", revises_worksheet_id: "o2", post_invoice: true });
  const db2 = makeDb([o2, r2]); assert.equal(W.swapRevisionIfEligible(db2, st, { id: "x" }, r2), false);
  assert.equal(call(C.resolvePostInvoiceRevision, { db: { ...db2 }, user: "fin1", params: { id: "r2" } }).statusCode, 409); // flag off -> FEATURE_DISABLED path
}));

// ---- Phase 2: Dual-Desk entry - Sales keys in signed paper under its OWN account -----------------
const paperBody = (o = {}) => ({
  activity: "Pump overhaul", work_date: "2026-03-04", technician_id: "t1", hours_breakdown: { normal: 8, ot_15: 0, ot_20: 0 },
  source: "paper_entry", client_paper_reference: "Booklet #104, Sheet 12", signatory_name_on_paper: "E. Moyo",
  signatures: { employee: { name: "W Worker", date: "2026-03-04", method: "paper_scan" } }, ...o });
const salesDb = () => { const db = makeDb(); db.quotes[0].sales_owner_id = "sales1"; return db; };
const enter = (db, user, body, id = "d1") => call(createWorksheet, { db, user, params: { id }, body });

test("Phase 2 permissions: Sales can create/submit Timesheets and Daily Time Sheets but still cannot review or confirm", withFlags([], () => {
  for (const p of ["createWorksheet", "submitWorksheet", "createDailyTimesheet", "submitDailyTimesheet"]) assert.equal(hasPermission(u("s", "Sales"), p), true, p);
  for (const p of ["reviewWorksheet", "reviewDailyTimesheet", "acknowledgeWorksheet", "addTimesheet", "addMaterials"]) assert.equal(hasPermission(u("s", "Sales"), p), false, p);
  for (const role of ["Finance", "Management", "Client Viewer"]) assert.equal(hasPermission(u("x", role), "createWorksheet"), false, role);
}));

test("Phase 2: Sales enters a Timesheet natively - created_by is Sales, capture_method and paper evidence recorded, never a client confirmation", withFlags([], () => {
  const db = salesDb();
  const res = enter(db, "sales1", paperBody({ scan_reference: "scans/b104-s12.pdf", scan_hash: "abc123", submit: true }));
  assert.equal(res.statusCode, 200);
  const rec = db.field_worksheets[0];
  assert.equal(rec.created_by, "sales1"); assert.equal(rec.submitted_by, "sales1"); assert.equal(rec.status, "Submitted");
  assert.equal(rec.technician_id, "t1"); assert.equal(rec.worker_name, "t1");
  assert.equal(rec.source, "paper_entry"); assert.equal(rec.capture_method, "paper_transcription");
  assert.deepEqual({ ...rec.paper_entry, entered_at: undefined }, { entered_by: "sales1", entered_by_name: "sales1", entered_by_role: "Sales", entered_at: undefined,
    client_paper_reference: "Booklet #104, Sheet 12", signatory_name_on_paper: "E. Moyo", signatory_authenticated: false, scan_reference: "scans/b104-s12.pdf", scan_hash: "abc123" });
  assert.equal(rec.signed_copy_image, "scans/b104-s12.pdf");
  // The worker's declaration stays the worker's: the client signatory is NOT written over it.
  assert.equal(rec.signatures.employee.name, "W Worker");
  assert.equal(rec.client_acknowledgement, undefined);
  assert.equal(isEligibleForDb(db, rec), false, "a Submitted paper entry still needs client confirmation and review");
  assert.equal(db.stock_movements.length, 0); assert.equal(db.material_usage.length, 0);
  assert.equal(stores.get(db).audits.at(-1).action, "WORKSHEET_SUBMITTED");
}));

test("Phase 2: the scan is optional for a Draft, but Sales cannot submit without a signed copy until the scan is added", withFlags([], () => {
  const db = salesDb();
  const draft = enter(db, "sales1", paperBody());
  assert.equal(draft.statusCode, 200); assert.equal(db.field_worksheets[0].status, "Draft");
  assert.equal(db.field_worksheets[0].paper_entry.scan_reference, null);
  const id = db.field_worksheets[0].id;
  const blocked = call(submitWorksheet, { db, user: "sales1", params: { id } });
  assert.equal(blocked.statusCode, 400); assert.equal(blocked.body.code, "SIGNOFF_INCOMPLETE");
  assert.equal(call(updateWorksheet, { db, user: "sales1", params: { id }, body: { scan_reference: "scans/b104-s12.pdf" } }).statusCode, 200);
  assert.equal(db.field_worksheets[0].signed_copy_image, "scans/b104-s12.pdf");
  assert.equal(call(submitWorksheet, { db, user: "sales1", params: { id } }).statusCode, 200);
  assert.equal(db.field_worksheets[0].submitted_by, "sales1");
}));

test("Phase 2: Sales may only enter paper, with its reference and signatory, for a named Technician or contractor", withFlags([], () => {
  const db = salesDb();
  const refused = (body) => { const r = enter(db, "sales1", body); assert.equal(r.statusCode, 400); return r; };
  assert.equal(refused(paperBody({ source: undefined })).body.code, "PAPER_ENTRY_INVALID");
  assert.equal(refused(paperBody({ client_paper_reference: " " })).body.code, "PAPER_ENTRY_INVALID");
  assert.equal(refused(paperBody({ signatory_name_on_paper: undefined })).body.code, "PAPER_ENTRY_INVALID");
  assert.equal(refused(paperBody({ hours_breakdown: undefined, hours: 8 })).body.code, "PAPER_ENTRY_INVALID");
  assert.match(refused(paperBody({ signatures: { employee: { name: "W", date: "2026-03-04", method: "on_device", attest: true } } })).body.message, /on-device/);
  refused(paperBody({ technician_id: undefined }));          // Sales is never the worker
  refused(paperBody({ technician_id: "sales2" }));           // and cannot name a non-Technician
  assert.equal(db.field_worksheets.length, 0);
  // contractor without an account is allowed, by name
  const c = enter(db, "sales1", paperBody({ technician_id: undefined, worker_type: "contractor", worker_name: "Contractor Joe" }));
  assert.equal(c.statusCode, 200); assert.equal(db.field_worksheets[0].technician_id, null); assert.equal(db.field_worksheets[0].worker_name, "Contractor Joe");
}));

test("Phase 2: Sales is limited to its own portfolio and to the paper entries it created", withFlags([], () => {
  const db = salesDb();
  assert.equal(enter(db, "sales2", paperBody()).statusCode, 403, "another Sales user's client");
  assert.equal(enter(db, "sales1", paperBody(), "missing").statusCode, 404);
  assert.equal(enter(db, "sales1", paperBody()).statusCode, 200);
  const mine = db.field_worksheets[0].id;
  assert.equal(call(updateWorksheet, { db, user: "sales2", params: { id: mine }, body: { activity: "x" } }).statusCode, 403);
  assert.equal(call(submitWorksheet, { db, user: "sales2", params: { id: mine } }).statusCode, 403);
  // a Technician's own Draft is not Sales' to edit, even inside the portfolio
  db.field_worksheets.push({ id: "tech-draft", dispatch_card_id: "d1", technician_id: "t1", status: "Draft", created_by: "t1", work_date: "2026-03-09", hours: 8, timesheet_version: 2, hours_breakdown: { normal: 8, ot_15: 0, ot_20: 0 } });
  assert.equal(call(updateWorksheet, { db, user: "sales1", params: { id: "tech-draft" }, body: { activity: "x" } }).statusCode, 403);
  assert.equal(call(submitWorksheet, { db, user: "sales1", params: { id: "tech-draft" } }).statusCode, 403);
  // an Admin may still correct a paper entry, and entered_by is never rewritten
  assert.equal(call(updateWorksheet, { db, user: "admin", params: { id: mine }, body: { client_paper_reference: "Booklet #104, Sheet 13" } }).statusCode, 200);
  assert.equal(db.field_worksheets[0].paper_entry.client_paper_reference, "Booklet #104, Sheet 13");
  assert.equal(db.field_worksheets[0].paper_entry.entered_by, "sales1");
}));

test("Phase 2: duplicates and offline replays behave as before for paper entries", withFlags([], () => {
  const db = salesDb();
  const body = paperBody({ client_request_id: "paper-req-0001" });
  assert.equal(enter(db, "sales1", body).statusCode, 200);
  const replay = enter(db, "sales1", body);
  assert.equal(replay.statusCode, 200); assert.equal(replay.body.replayed, true); assert.equal(db.field_worksheets.length, 1);
  assert.equal(enter(db, "sales1", { ...body, client_paper_reference: "Booklet #104, Sheet 99" }).statusCode, 409, "same reference, different paper evidence");
  assert.equal(enter(db, "sales1", paperBody()).body.code, "DUPLICATE_TIMESHEET", "one worker + date + dispatch = one Timesheet");
}));

test("Phase 2: non-Sales roles are unchanged (no paper stamp unless they send source paper_entry) and cannot send stray paper details", withFlags([], () => {
  const db = makeDb();
  const plain = call(createWorksheet, { db, user: "admin", params: { id: "d1" }, body: { activity: "Inspection", work_date: "2026-03-10", technician_id: "t1", hours_breakdown: { normal: 8, ot_15: 0, ot_20: 0 } } });
  assert.equal(plain.statusCode, 200);
  const rec = db.field_worksheets[0];
  assert.equal(rec.source, undefined); assert.equal(rec.capture_method, undefined); assert.equal(rec.paper_entry, undefined);
  const stray = call(createWorksheet, { db, user: "admin", params: { id: "d1" }, body: { activity: "x", work_date: "2026-03-11", technician_id: "t1", hours_breakdown: { normal: 8, ot_15: 0, ot_20: 0 }, scan_hash: "abc" } });
  assert.equal(stray.statusCode, 400);
}));

test("Phase 2: request schema accepts the paper metadata, and rejects stray paper fields or a client-supplied capture_method", () => {
  const base = { activity: "Pump overhaul", hours_breakdown: { normal: 8 }, technician_id: "t1" };
  const ok = CreateTimesheetSchemaV2.safeParse({ ...base, source: "paper_entry", client_paper_reference: "Booklet #104, Sheet 12", signatory_name_on_paper: "E. Moyo", scan_reference: "scans/x.pdf", scan_hash: "abc123" });
  assert.equal(ok.success, true);
  assert.equal(CreateTimesheetSchemaV2.safeParse({ ...base, source: "paper_entry", client_paper_reference: "R" }).success, false, "signatory required");
  assert.equal(CreateTimesheetSchemaV2.safeParse({ ...base, client_paper_reference: "R" }).success, false, "paper fields need source");
  assert.equal(CreateTimesheetSchemaV2.safeParse({ ...base, source: "kiosk" }).success, false);
  assert.equal(CreateTimesheetSchemaV2.safeParse({ ...base, source: "paper_entry", client_paper_reference: "R", signatory_name_on_paper: "S", capture_method: "typed" }).success, false, "capture_method is server-stamped");
  assert.equal(CreateTimesheetSchemaV2.safeParse(base).success, true, "ordinary Timesheet bodies are unchanged");
});

test("Phase 2: the existing PAPER_CAPTURE model stamps source and capture_method, and still keeps its owner-config gates", withFlags(["TIMESHEET_PAPER_CAPTURE"], () => {
  const db = makeDb(); cfg(db);
  const res = call(C.capturePaperTimesheet, { db, user: "sales1", body: capture({ scan_reference: "scans/p1.pdf" }) });
  assert.equal(res.statusCode, 201);
  const rec = db.field_worksheets[0];
  assert.equal(rec.created_by, "sales1"); assert.equal(rec.source, "paper_entry"); assert.equal(rec.capture_method, "paper_transcription");
  assert.equal(rec.paper_capture.capture_method, "paper_transcription"); assert.equal(rec.paper_capture.captured_by_role, "Sales");
  assert.equal(rec.paper_capture.scan_reference, "scans/p1.pdf"); assert.equal(rec.paper_capture.signatory_authenticated, false);
  assert.equal(rec.signed_copy_image, "scans/p1.pdf");
  // an unlisted Sales user is still blocked by owner confirmation #3
  assert.equal(call(C.capturePaperTimesheet, { db, user: "sales2", body: capture({ work_date: "2026-03-08" }) }).statusCode, 409);
}));

test("Phase 2: a Sales user who entered paper cannot review a Worksheet that includes it (segregation)", withFlags(["TIMESHEET_SALES_ACCESS"], () => {
  const db = makeDb([ws({ id: "e1", paper_entry: { entered_by: "sales2" } })]);
  db.users.push(u("sales3", "Sales"));
  const rec = { built_by: "fin1", submitted_by: "fin1", roster: [], lines: [{ sources: [{ source_type: "timesheet", record_id: "e1" }] }] };
  assert.match(W.worksheetReviewerRefusal(db, rec, db.users.find((x) => x.id === "sales2")), /entered paper/);
  assert.equal(W.worksheetReviewerRefusal(db, rec, db.users.find((x) => x.id === "sales3")), null);
  assert.deepEqual(W.eligibleWorksheetReviewers(db, rec).map((x) => x.id).sort(), ["sales1", "sales3"]);
}));
