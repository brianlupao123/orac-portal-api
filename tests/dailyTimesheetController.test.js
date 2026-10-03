import test from "node:test";
import assert from "node:assert/strict";
import {
  createDailyTimesheet, updateDailyTimesheet, submitDailyTimesheet, reviewDailyTimesheet
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
      { id: "u_sales", role: "Sales", name: "Sales One", is_active: true }
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
  assert.throws(() => createDailyTimesheet(req(db, "u_sales", { name_on_form: "x", entries: validEntries }), makeRes()), /cannot perform/);
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
