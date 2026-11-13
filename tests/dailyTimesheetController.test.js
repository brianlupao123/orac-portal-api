import test from "node:test";
import assert from "node:assert/strict";
import {
  createDailyTimesheet, updateDailyTimesheet, submitDailyTimesheet, reviewDailyTimesheet, getDailyTimesheetDocument
} from "../src/controllers/dailyTimesheetController.js";

function makeRes() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function makeDb() {
  return {
    users: [
      { id: "u_tech", role: "Technician", name: "Tech One", is_active: true },
      { id: "u_tech2", role: "Technician", name: "Tech Two", is_active: true },
      { id: "u_supervisor", role: "Supervisor", name: "Supervisor One", is_active: true },
      { id: "u_sales", role: "Sales", name: "Sales One", is_active: true },
      { id: "u_sales2", role: "Sales", name: "Sales Two", is_active: true },
      { id: "u_finance", role: "Finance", name: "Finance One", is_active: true }
    ],
    daily_timesheets: [],
    audit_logs: []
  };
}

function makeStore() {
  let counter = 0;
  return {
    id(prefix) { counter += 1; return `${prefix}_${counter}`; },
    audit(db, actor, entityType, entityId, action, oldValues, newValues) {
      db.audit_logs.push({ actor_id: actor?.id, entity_type: entityType, entity_id: entityId, action });
    }
  };
}

function req(db, userId, body = {}, params = {}) {
  return { db, store: makeStore(), user: { id: userId }, body, params };
}

const validEntries = [
  { date: "2026-04-27", start_time: "08:00", end_time: "17:00", normal_hours: 8, ot_15: "X", ot_20: "X", description: "Housekeeping" }
];

test("a Technician can create their own daily time sheet as a Draft", () => {
  const db = makeDb();
  const res = makeRes();
  createDailyTimesheet(req(db, "u_tech", { name_on_form: "Tech One", entries: validEntries }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.technician_id, "u_tech");
  assert.equal(res.body.data.status, "Draft");
});

test("a Technician cannot create a sheet on behalf of someone else (technician_id is forced to their own id)", () => {
  const db = makeDb();
  const res = makeRes();
  createDailyTimesheet(req(db, "u_tech", { name_on_form: "Tech Two", technician_id: "u_tech2", entries: validEntries }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.technician_id, "u_tech"); // forced, not the spoofed u_tech2
});

test("a role without createDailyTimesheet permission is rejected", () => {
  const db = makeDb();
  assert.throws(() => createDailyTimesheet(req(db, "u_finance", { name_on_form: "x", entries: validEntries }), makeRes()), /cannot perform/);
});

test("creating with invalid entries (end before start) is rejected with 400", () => {
  const db = makeDb();
  const res = makeRes();
  createDailyTimesheet(req(db, "u_tech", { name_on_form: "Tech One", entries: [{ date: "2026-04-27", start_time: "17:00", end_time: "08:00" }] }), res);
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.errors.length > 0);
});

test("submit requires at least one real entry row", () => {
  const db = makeDb();
  const createRes = makeRes();
  createDailyTimesheet(req(db, "u_tech", { name_on_form: "Tech One", entries: [] }), createRes);
  const id = createRes.body.data.id;

  const submitRes = makeRes();
  submitDailyTimesheet(req(db, "u_tech", {}, { id }), submitRes);
  assert.equal(submitRes.statusCode, 400);
});

test("full lifecycle: create -> submit -> independent review approves", () => {
  const db = makeDb();
  const createRes = makeRes();
  createDailyTimesheet(req(db, "u_tech", { name_on_form: "Tech One", entries: validEntries }), createRes);
  const id = createRes.body.data.id;

  const submitRes = makeRes();
  submitDailyTimesheet(req(db, "u_tech", {}, { id }), submitRes);
  assert.equal(submitRes.statusCode, 200);
  assert.equal(submitRes.body.data.status, "Submitted");

  const reviewRes = makeRes();
  reviewDailyTimesheet(req(db, "u_supervisor", { decision: "approve" }, { id }), reviewRes);
  assert.equal(reviewRes.statusCode, 200);
  assert.equal(reviewRes.body.data.status, "Supervisor_Approved");
  assert.equal(reviewRes.body.data.approved_by, "u_supervisor");
});

test("the submitter cannot approve their own sheet (independent-reviewer rule)", () => {
  const db = makeDb();
  const createRes = makeRes();
  createDailyTimesheet(req(db, "u_supervisor", { name_on_form: "Supervisor filling in", technician_id: "u_tech", entries: validEntries, submit: true }), createRes);
  const id = createRes.body.data.id;

  const reviewRes = makeRes();
  reviewDailyTimesheet(req(db, "u_supervisor", { decision: "approve" }, { id }), reviewRes);
  assert.equal(reviewRes.statusCode, 403);
});

test("returning a sheet for correction requires a comment", () => {
  const db = makeDb();
  const createRes = makeRes();
  createDailyTimesheet(req(db, "u_tech", { name_on_form: "Tech One", entries: validEntries, submit: true }), createRes);
  const id = createRes.body.data.id;

  const reviewRes = makeRes();
  reviewDailyTimesheet(req(db, "u_supervisor", { decision: "return" }, { id }), reviewRes);
  assert.equal(reviewRes.statusCode, 400);
});

test("a Technician cannot edit another Technician's sheet", () => {
  const db = makeDb();
  const createRes = makeRes();
  createDailyTimesheet(req(db, "u_tech", { name_on_form: "Tech One", entries: validEntries }), createRes);
  const id = createRes.body.data.id;

  const updateRes = makeRes();
  updateDailyTimesheet(req(db, "u_tech2", { category: "Welder" }, { id }), updateRes);
  assert.equal(updateRes.statusCode, 403);
});

test("a sheet cannot be edited once Submitted", () => {
  const db = makeDb();
  const createRes = makeRes();
  createDailyTimesheet(req(db, "u_tech", { name_on_form: "Tech One", entries: validEntries, submit: true }), createRes);
  const id = createRes.body.data.id;

  const updateRes = makeRes();
  updateDailyTimesheet(req(db, "u_tech", { category: "Welder" }, { id }), updateRes);
  assert.equal(updateRes.statusCode, 400);
});

// ---- Sales Desk paper entry (Phase 2: Sales enters signed paper under its OWN account) ----
const paperBody = (o = {}) => ({
  name_on_form: "Tech One", technician_id: "u_tech", entries: validEntries,
  source: "paper_entry", client_paper_reference: "Booklet #104, Sheet 12", signatory_name_on_paper: "E. Moyo", ...o
});

test("Sales creates a paper entry natively: created_by is Sales, capture_method and paper evidence are stamped", () => {
  const db = makeDb();
  const res = makeRes();
  createDailyTimesheet(req(db, "u_sales", paperBody({ scan_reference: "scans/booklet-104-sheet-12.pdf", scan_hash: "abc123" })), res);
  assert.equal(res.statusCode, 200);
  const r = res.body.data;
  assert.equal(r.created_by, "u_sales");
  assert.equal(r.technician_id, "u_tech");
  assert.equal(r.status, "Draft");
  assert.equal(r.source, "paper_entry");
  assert.equal(r.capture_method, "paper_transcription");
  assert.equal(r.paper_entry.entered_by, "u_sales");
  assert.equal(r.paper_entry.entered_by_role, "Sales");
  assert.equal(r.paper_entry.client_paper_reference, "Booklet #104, Sheet 12");
  assert.equal(r.paper_entry.signatory_name_on_paper, "E. Moyo");
  assert.equal(r.paper_entry.signatory_authenticated, false, "the signatory is recorded as written, never authenticated");
  assert.equal(r.paper_entry.scan_hash, "abc123");
  assert.equal(r.signed_copy_image, "scans/booklet-104-sheet-12.pdf", "the scan doubles as the signed copy");
  assert.equal(db.audit_logs.at(-1).actor_id, "u_sales");
});

test("Sales can print only its own paper entry without receiving private user fields", () => {
  const db = makeDb();
  db.users.find((user) => user.id === "u_tech").password_hash = "private-hash";
  db.users.find((user) => user.id === "u_tech").bank_account_number = "private-bank";
  db.company_profile = { company_name: "Fictional ORAC", address: "Test Address", tax_approval_reference: "private-tax-config" };
  const created = makeRes();
  createDailyTimesheet(req(db, "u_sales", paperBody()), created);
  const id = created.body.data.id;

  const own = makeRes();
  getDailyTimesheetDocument(req(db, "u_sales", {}, { id }), own);
  assert.equal(own.statusCode, 200);
  assert.equal(own.body.data.record.id, id);
  assert.deepEqual(own.body.data.technician, { id: "u_tech", name: "Tech One", trade: undefined });
  assert.deepEqual(own.body.data.company_profile, { company_name: "Fictional ORAC", address: "Test Address" });

  const colleague = makeRes();
  getDailyTimesheetDocument(req(db, "u_sales2", {}, { id }), colleague);
  assert.equal(colleague.statusCode, 403);
  const nonPaper = makeRes();
  db.daily_timesheets[0].source = undefined;
  getDailyTimesheetDocument(req(db, "u_sales", {}, { id }), nonPaper);
  assert.equal(nonPaper.statusCode, 403);
});

test("the scan is optional on a paper entry", () => {
  const db = makeDb();
  const res = makeRes();
  createDailyTimesheet(req(db, "u_sales", paperBody()), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.paper_entry.scan_reference, null);
  assert.equal(res.body.data.paper_entry.scan_hash, null);
  assert.equal(res.body.data.signed_copy_image, null);
});

test("Sales may only enter paper: no source, no paper reference or no signatory is refused", () => {
  for (const body of [
    paperBody({ source: undefined }),
    paperBody({ client_paper_reference: "  " }),
    paperBody({ signatory_name_on_paper: undefined })
  ]) {
    const db = makeDb();
    const res = makeRes();
    createDailyTimesheet(req(db, "u_sales", body), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "PAPER_ENTRY_INVALID");
    assert.equal(db.daily_timesheets.length, 0);
  }
});

test("paper details are refused (not silently dropped) when source is not paper_entry", () => {
  const db = makeDb();
  const res = makeRes();
  createDailyTimesheet(req(db, "u_supervisor", { name_on_form: "x", technician_id: "u_tech", entries: validEntries, client_paper_reference: "P-1" }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(db.daily_timesheets.length, 0);
});

test("a Supervisor-created sheet is unchanged: no source, no capture_method, no paper evidence", () => {
  const db = makeDb();
  const res = makeRes();
  createDailyTimesheet(req(db, "u_supervisor", { name_on_form: "x", technician_id: "u_tech", entries: validEntries }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.source, undefined);
  assert.equal(res.body.data.capture_method, undefined);
  assert.equal(res.body.data.paper_entry, undefined);
});

test("Sales technician_id must be an active Technician, and Sales never becomes the worker", () => {
  const db = makeDb();
  const res = makeRes();
  createDailyTimesheet(req(db, "u_sales", paperBody({ technician_id: "u_supervisor" })), res);
  assert.equal(res.statusCode, 400);
  const ok = makeRes();
  createDailyTimesheet(req(db, "u_sales", paperBody({ technician_id: undefined })), ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.data.technician_id, null);
});

test("Sales can edit and submit its own paper entry; an independent Supervisor approves it; Sales cannot review", () => {
  const db = makeDb();
  const created = makeRes();
  createDailyTimesheet(req(db, "u_sales", paperBody()), created);
  const id = created.body.data.id;

  const upd = makeRes();
  updateDailyTimesheet(req(db, "u_sales", { client_paper_reference: "Booklet #104, Sheet 13", scan_reference: "scans/s13.pdf" }, { id }), upd);
  assert.equal(upd.statusCode, 200);
  assert.equal(upd.body.data.paper_entry.client_paper_reference, "Booklet #104, Sheet 13");
  assert.equal(upd.body.data.signed_copy_image, "scans/s13.pdf");
  assert.equal(upd.body.data.paper_entry.entered_by, "u_sales", "entered_by is never rewritten");

  const sub = makeRes();
  submitDailyTimesheet(req(db, "u_sales", {}, { id }), sub);
  assert.equal(sub.statusCode, 200);
  assert.equal(sub.body.data.status, "Submitted");
  assert.equal(sub.body.data.submitted_by, "u_sales");

  assert.throws(() => reviewDailyTimesheet(req(db, "u_sales", { decision: "approve" }, { id }), makeRes()), /cannot perform/);
  const rev = makeRes();
  reviewDailyTimesheet(req(db, "u_supervisor", { decision: "approve" }, { id }), rev);
  assert.equal(rev.statusCode, 200);
  assert.equal(rev.body.data.status, "Supervisor_Approved");
  assert.equal(rev.body.data.created_by, "u_sales", "the audit trail still shows who transcribed it");
});

// One store per test so ids stay unique when a test creates several records.
const sharedReq = (store) => (db, userId, body = {}, params = {}) => ({ db, store, user: { id: userId }, body, params });

test("Sales cannot touch a colleague's paper entry or a sheet it did not create", () => {
  const db = makeDb();
  const req = sharedReq(makeStore());
  const mine = makeRes();
  createDailyTimesheet(req(db, "u_sales", paperBody()), mine);
  const techSheet = makeRes();
  createDailyTimesheet(req(db, "u_tech", { name_on_form: "Tech One", entries: validEntries }), techSheet);

  for (const id of [mine.body.data.id, techSheet.body.data.id]) {
    const upd = makeRes();
    updateDailyTimesheet(req(db, "u_sales2", { category: "x" }, { id }), upd);
    assert.equal(upd.statusCode, 403);
  }
  const upd = makeRes();
  updateDailyTimesheet(req(db, "u_sales", { category: "x" }, { id: techSheet.body.data.id }), upd);
  assert.equal(upd.statusCode, 403);
  const sub = makeRes();
  submitDailyTimesheet(req(db, "u_sales", {}, { id: techSheet.body.data.id }), sub);
  assert.equal(sub.statusCode, 403);
});

test("paper details cannot be added to a non-paper sheet or blanked on a paper entry", () => {
  const db = makeDb();
  const req = sharedReq(makeStore());
  const plain = makeRes();
  createDailyTimesheet(req(db, "u_tech", { name_on_form: "Tech One", entries: validEntries }), plain);
  const a = makeRes();
  updateDailyTimesheet(req(db, "u_tech", { client_paper_reference: "P-1" }, { id: plain.body.data.id }), a);
  assert.equal(a.statusCode, 400);

  const paper = makeRes();
  createDailyTimesheet(req(db, "u_sales", paperBody()), paper);
  const b = makeRes();
  updateDailyTimesheet(req(db, "u_sales", { signatory_name_on_paper: " " }, { id: paper.body.data.id }), b);
  assert.equal(b.statusCode, 400);
  assert.equal(db.daily_timesheets.find((s) => s.id === paper.body.data.id).paper_entry.signatory_name_on_paper, "E. Moyo");
});
