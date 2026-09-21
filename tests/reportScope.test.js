import assert from "node:assert/strict";
import test from "node:test";
import { getDispatchReport, getWorksheetReport } from "../src/controllers/reportsController.js";

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function database() {
  return {
    users: [
      { id: "supervisor-a", role: "Supervisor", is_active: true },
      { id: "supervisor-b", role: "Supervisor", is_active: true },
      { id: "operations-1", role: "Operations", is_active: true }
    ],
    dispatch_cards: [
      { id: "dispatch-a", dispatch_number: "D-A", status: "Open", assigned_supervisor_id: "supervisor-a" },
      { id: "dispatch-b", dispatch_number: "D-B", status: "Open", assigned_supervisor_id: "supervisor-b" }
    ],
    field_worksheets: [
      { id: "worksheet-a", dispatch_card_id: "dispatch-a", supervisor_id: "supervisor-a", status: "Submitted", work_date: "2026-09-21", hours: 1 },
      { id: "worksheet-b", dispatch_card_id: "dispatch-b", supervisor_id: "supervisor-b", status: "Submitted", work_date: "2026-09-21", hours: 1 }
    ]
  };
}

test("Supervisor reports contain only the Supervisor's assigned dispatch and worksheet data", () => {
  const db = database();
  const dispatchResponse = response();
  getDispatchReport({ user: { id: "supervisor-a" }, db }, dispatchResponse);

  assert.equal(dispatchResponse.statusCode, 200);
  assert.deepEqual(dispatchResponse.body.data.map((item) => item.id), ["dispatch-a"]);
  assert.equal(dispatchResponse.body.data[0].worksheet_count, 1);

  const worksheetResponse = response();
  getWorksheetReport({ user: { id: "supervisor-a" }, db }, worksheetResponse);
  assert.deepEqual(worksheetResponse.body.data.pending_review.map((item) => item.id), ["worksheet-a"]);
  assert.equal(worksheetResponse.body.data.approved_count, 0);
});

test("Operations retains its permitted full dispatch report scope", () => {
  const db = database();
  const reportResponse = response();
  getDispatchReport({ user: { id: "operations-1" }, db }, reportResponse);

  assert.equal(reportResponse.statusCode, 200);
  assert.deepEqual(reportResponse.body.data.map((item) => item.id), ["dispatch-a", "dispatch-b"]);
});
