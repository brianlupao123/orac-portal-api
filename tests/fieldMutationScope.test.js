import test from "node:test";
import assert from "node:assert/strict";
import { addTimesheet, createWorksheet, submitWorksheet, updateWorksheet, reviewWorksheet } from "../src/controllers/dispatchController.js";

function response() { return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }

function request(actor, id = "dispatch-unassigned") {
  const assigned = { id: "dispatch-assigned", assigned_technician_id: "tech-1", assigned_supervisor_id: "supervisor-1" };
  const unassigned = { id: "dispatch-unassigned", assigned_technician_id: "tech-2", assigned_supervisor_id: "supervisor-2" };
  const missing = { id: "dispatch-missing" };
  const worksheet = { id: "worksheet-unassigned", dispatch_card_id: "dispatch-unassigned", technician_id: "tech-2", status: "Draft" };
  return {
    user: { id: actor.id }, params: { id }, body: { activity: "Inspection", hours: 1, hours_logged: 1, hourly_rate: 1 },
    db: { users: [actor], dispatch_cards: [assigned, unassigned, missing], field_worksheets: [worksheet], timesheets: [], material_usage: [], audit_logs: [] },
    store: { id: () => "new-id", audit() {}, recalculateVariance() {} }
  };
}

test("Technician cannot create a worksheet or add time against an unassigned dispatch", () => {
  const actor = { id: "tech-1", role: "Technician", is_active: true };
  for (const handler of [createWorksheet, addTimesheet]) { const req = request(actor); const res = response(); handler(req, res); assert.equal(res.statusCode, 403); }
});

test("Technician can create a worksheet only for an assigned dispatch", () => {
  const actor = { id: "tech-1", role: "Technician", is_active: true };
  const req = request(actor, "dispatch-assigned"); const res = response(); createWorksheet(req, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.data.technician_id, actor.id);
});

test("missing dispatch ownership fails closed for field roles", () => {
  const actor = { id: "tech-1", role: "Technician", is_active: true };
  const req = request(actor, "dispatch-missing"); const res = response(); addTimesheet(req, res);
  assert.equal(res.statusCode, 403);
});

test("Technician cannot edit or submit another technician's worksheet", () => {
  const actor = { id: "tech-1", role: "Technician", is_active: true };
  for (const handler of [updateWorksheet, submitWorksheet]) { const req = request(actor, "worksheet-unassigned"); const res = response(); handler(req, res); assert.equal(res.statusCode, 403); }
});

test("Supervisor cannot review an unassigned worksheet", () => {
  const actor = { id: "supervisor-1", role: "Supervisor", is_active: true };
  const req = request(actor, "worksheet-unassigned"); req.db.field_worksheets[0].status = "Submitted"; req.body = { decision: "return", comment: "Reassign before review." };
  const res = response(); reviewWorksheet(req, res); assert.equal(res.statusCode, 403);
});
