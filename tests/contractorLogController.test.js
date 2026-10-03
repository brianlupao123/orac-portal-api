import test from "node:test";
import assert from "node:assert/strict";
import {
  createContractorLog, updateContractorLog, submitContractorLog, reviewContractorLog, getContractorLogDocument
} from "../src/controllers/contractorLogController.js";

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
      { id: "u_ops", role: "Operations", name: "Ops One", is_active: true },
      { id: "u_supervisor", role: "Supervisor", name: "Supervisor One", is_active: true },
      { id: "u_tech", role: "Technician", name: "Tech One", is_active: true }
    ],
    contractor_log_sheets: [],
    audit_logs: [],
    company_profile: { company_name: "Orac Systems" }
  };
}

function makeStore() {
  let counter = 0;
  return {
    id(prefix) { counter += 1; return `${prefix}_${counter}`; },
    audit(db, actor, entityType, entityId, action) { db.audit_logs.push({ actor_id: actor?.id, entity_type: entityType, entity_id: entityId, action }); }
  };
}

function req(db, userId, body = {}, params = {}) {
  return { db, store: makeStore(), user: { id: userId }, body, params };
}

const validRows = [{ worker_name: "Employee A", grade: "Artisan", normal: 8, ot_15: 1, ot_20: 0 }];

test("Operations/Supervisor can create a contractor log; a Technician cannot", () => {
  const db = makeDb();
  const res = makeRes();
  createContractorLog(req(db, "u_supervisor", { contractor_name: "Sample Contractor", rows: validRows }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.status, "Draft");

  assert.throws(() => createContractorLog(req(db, "u_tech", { contractor_name: "x", rows: validRows }), makeRes()), /cannot perform/);
});

test("creating with an invalid row (missing name but hours present) is rejected", () => {
  const db = makeDb();
  const res = makeRes();
  createContractorLog(req(db, "u_ops", { contractor_name: "Sample Contractor", rows: [{ normal: 8 }] }), res);
  assert.equal(res.statusCode, 400);
});

test("submit requires at least one named worker row", () => {
  const db = makeDb();
  const createRes = makeRes();
  createContractorLog(req(db, "u_ops", { contractor_name: "Sample Contractor", rows: [] }), createRes);
  const id = createRes.body.data.id;

  const submitRes = makeRes();
  submitContractorLog(req(db, "u_ops", {}, { id }), submitRes);
  assert.equal(submitRes.statusCode, 400);
});

test("full lifecycle: create -> submit -> independent review approves", () => {
  const db = makeDb();
  const createRes = makeRes();
  createContractorLog(req(db, "u_ops", { contractor_name: "Sample Contractor", rows: validRows }), createRes);
  const id = createRes.body.data.id;

  const submitRes = makeRes();
  submitContractorLog(req(db, "u_ops", {}, { id }), submitRes);
  assert.equal(submitRes.statusCode, 200);

  const reviewRes = makeRes();
  reviewContractorLog(req(db, "u_supervisor", { decision: "approve" }, { id }), reviewRes);
  assert.equal(reviewRes.statusCode, 200);
  assert.equal(reviewRes.body.data.status, "Supervisor_Approved");
});

test("the submitter cannot approve their own contractor log", () => {
  const db = makeDb();
  const createRes = makeRes();
  createContractorLog(req(db, "u_ops", { contractor_name: "Sample Contractor", rows: validRows, submit: true }), createRes);
  const id = createRes.body.data.id;

  const reviewRes = makeRes();
  reviewContractorLog(req(db, "u_ops", { decision: "approve" }, { id }), reviewRes);
  assert.equal(reviewRes.statusCode, 403);
});

test("a Technician cannot view the contractor log document-data endpoint", () => {
  const db = makeDb();
  const createRes = makeRes();
  createContractorLog(req(db, "u_ops", { contractor_name: "Sample Contractor", rows: validRows }), createRes);
  const id = createRes.body.data.id;

  const res = makeRes();
  getContractorLogDocument(req(db, "u_tech", {}, { id }), res);
  assert.equal(res.statusCode, 403);
});

test("the document-data endpoint returns server-computed totals matching the formula", () => {
  const db = makeDb();
  const createRes = makeRes();
  createContractorLog(req(db, "u_ops", {
    contractor_name: "Sample Contractor",
    rows: [
      { worker_name: "Employee A", grade: "Artisan", normal: 8, ot_15: 1, ot_20: 0 },
      { worker_name: "Employee B", grade: "Assistant", normal: 8, ot_15: 0, ot_20: 2 }
    ]
  }), createRes);
  const id = createRes.body.data.id;

  const res = makeRes();
  getContractorLogDocument(req(db, "u_ops", {}, { id }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data.totals, {
    normal: 16, ot_15: 1, ot_20: 2, total_hours: 19, total_ot_hours: 3, total_payable_hours: 21.5
  });
});
