import test from "node:test";
import assert from "node:assert/strict";
import { addTimesheet } from "../src/controllers/dispatchController.js";

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function baseDb(worksheetStatus = "Supervisor_Approved") {
  const technician = { id: "tech-1", role: "Technician", is_active: true };
  const supervisor = { id: "sup-1", role: "Supervisor", is_active: true };
  const dispatch = { id: "dispatch-1", assigned_technician_ids: ["tech-1"], assigned_supervisor_id: "sup-1" };
  const worksheet = {
    id: "ws-1",
    dispatch_card_id: "dispatch-1",
    technician_id: "tech-1",
    hours: 8,
    status: worksheetStatus
  };
  return {
    users: [technician, supervisor],
    dispatch_cards: [dispatch],
    field_worksheets: [worksheet],
    timesheets: [],
    audit_logs: []
  };
}

function req(db, body, actorId = "tech-1", dispatchId = "dispatch-1") {
  return {
    user: { id: actorId },
    params: { id: dispatchId },
    body,
    db,
    store: { id: (p) => `${p}-new`, audit() {}, recalculateVariance() {} }
  };
}

test("a Technician cannot log billable time with no worksheet reference at all", () => {
  const db = baseDb();
  const res = response();
  addTimesheet(req(db, { hours_logged: 8, hourly_rate: 45 }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(db.timesheets.length, 0);
});

test("a Technician cannot log billable time against a worksheet that isn't Supervisor-approved yet", () => {
  const db = baseDb("Submitted");
  const res = response();
  addTimesheet(req(db, { hours_logged: 8, hourly_rate: 45, source_worksheet_id: "ws-1" }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(db.timesheets.length, 0);
});

test("a Technician cannot reference another technician's worksheet", () => {
  const db = baseDb();
  db.field_worksheets[0].technician_id = "someone-else";
  const res = response();
  addTimesheet(req(db, { hours_logged: 8, hourly_rate: 45, source_worksheet_id: "ws-1" }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(db.timesheets.length, 0);
});

test("a Technician can log billable time once it references their own Supervisor-approved worksheet", () => {
  const db = baseDb("Supervisor_Approved");
  const res = response();
  addTimesheet(req(db, { hours_logged: 8, hourly_rate: 45, source_worksheet_id: "ws-1" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(db.timesheets.length, 1);
  assert.equal(db.timesheets[0].source_worksheet_id, "ws-1");
});

test("billable hours cannot exceed the hours the Supervisor approved on the worksheet", () => {
  const db = baseDb();
  db.field_worksheets[0].hours = 2;
  const res = response();
  addTimesheet(req(db, { hours_logged: 8, hourly_rate: 45, source_worksheet_id: "ws-1" }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(db.timesheets.length, 0);
});

test("approved hours are a cumulative cap across entries that cite the same worksheet", () => {
  const db = baseDb();
  db.field_worksheets[0].hours = 8;
  const first = response();
  addTimesheet(req(db, { hours_logged: 5, hourly_rate: 45, source_worksheet_id: "ws-1" }), first);
  assert.equal(first.statusCode, 200);
  const second = response();
  addTimesheet(req(db, { hours_logged: 4, hourly_rate: 45, source_worksheet_id: "ws-1" }), second);
  assert.equal(second.statusCode, 409);
  assert.equal(db.timesheets.length, 1);
});
