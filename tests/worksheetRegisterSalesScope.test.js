import test from "node:test";
import assert from "node:assert/strict";
import {
  listWorksheetRegisters, listLegacyTimesheets, getWorksheetRegister, getWorksheetRegisterDocument,
  previewWorksheetRegister, createWorksheetRegister, updateWorksheetRegister, buildWorksheetRegister,
  acknowledgeRegisterExceptions, submitWorksheetRegister, cancelWorksheetRegister
} from "../src/controllers/worksheetRegisterController.js";
import { makeDb, makeRes, req, baseBody, addTimesheet, addDaily, row } from "./helpers/worksheetRegisterFixture.js";

function call(handler, db, actor, body = {}, params = {}) {
  const res = makeRes();
  handler(req(db, actor, body, params), res);
  return res;
}

test("Sales retains own monthly Worksheets but cannot read or mutate another portfolio", () => {
  const db = makeDb();
  db.users.push({ id: "u_sales2", role: "Sales", name: "Sales Two", is_active: true });
  db.clients.find((client) => client.id === "c_other").primary_sales_owner_id = "u_sales2";
  addTimesheet(db, { id: "ws_owned", dispatch: "d_1" });

  const own = call(createWorksheetRegister, db, "u_sales", baseBody());
  assert.equal(own.statusCode, 200, JSON.stringify(own.body));
  const otherBody = baseBody({
    title: "Other portfolio",
    scope: { client_id: "c_other", project_title: "Other portfolio", department_section: "" }
  });
  const other = call(createWorksheetRegister, db, "u_ops", otherBody);
  assert.equal(other.statusCode, 200, JSON.stringify(other.body));
  const otherId = other.body.data.id;

  const listed = call(listWorksheetRegisters, db, "u_sales");
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.body.data.map((item) => item.id), [own.body.data.id]);
  assert.equal(call(getWorksheetRegister, db, "u_sales", {}, { id: own.body.data.id }).statusCode, 200);

  for (const [handler, body] of [
    [getWorksheetRegister, {}], [getWorksheetRegisterDocument, {}],
    [updateWorksheetRegister, { title: "Cross-client edit" }], [buildWorksheetRegister, {}],
    [acknowledgeRegisterExceptions, { keys: [], note: "Attempt" }],
    [submitWorksheetRegister, {}], [cancelWorksheetRegister, { reason: "Attempt" }]
  ]) {
    assert.equal(call(handler, db, "u_sales", body, { id: otherId }).statusCode, 403, handler.name);
  }
  assert.equal(call(previewWorksheetRegister, db, "u_sales", otherBody).statusCode, 403);
  assert.equal(call(createWorksheetRegister, db, "u_sales", otherBody).statusCode, 403);
  assert.equal(call(getWorksheetRegister, db, "u_sales2", {}, { id: otherId }).statusCode, 200);
});

test("Sales legacy history includes only its own paper and assigned dispatch records", () => {
  const db = makeDb();
  addDaily(db, { id: "own_paper", entries: [row("2026-09-01", 8)] });
  db.daily_timesheets.at(-1).source = "paper_entry";
  db.daily_timesheets.at(-1).created_by = "u_sales";
  addDaily(db, { id: "other_paper", entries: [row("2026-09-02", 8)] });
  db.daily_timesheets.at(-1).source = "paper_entry";
  db.daily_timesheets.at(-1).created_by = "another_sales";
  const result = call(listLegacyTimesheets, db, "u_sales");
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body.data.map((item) => item.record_id), ["own_paper"]);
});
