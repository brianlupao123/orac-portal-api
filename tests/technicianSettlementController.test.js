import assert from "node:assert/strict";
import test from "node:test";
import { getTechnicianSettlementDetails } from "../src/controllers/technicianSettlementController.js";

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
function request(role) {
  const db = { users: [
    { id: "admin", role: "Admin", is_active: true },
    { id: "finance", role: "Finance", is_active: true },
    { id: "sales", role: "Sales", is_active: true },
    { id: "tech", role: "Technician", is_active: true, employee_code: "EMP-001", bank_name: "Test Bank", bank_account: "123", bank_branch: "001", ecocash_number: "0770000000" }
  ], audit_logs: [] };
  return { db, user: { id: role.toLowerCase() }, params: { id: "tech" }, store: { audit(db0, actor, type, id, action, before, after) { db0.audit_logs.push({ actor_id: actor.id, type, id, action, before, after }); } } };
}
test("Finance receives settlement details and the access is audited without values", () => {
  const req = request("Finance"); const res = response();
  getTechnicianSettlementDetails(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.bank_account, "123");
  assert.deepEqual(req.db.audit_logs[0].after.fields.sort(), ["bank_account", "bank_branch", "bank_name", "ecocash_number", "employee_code"]);
  assert.equal(JSON.stringify(req.db.audit_logs[0]).includes("123"), false);
});
test("Sales cannot read technician settlement details", () => {
  assert.throws(() => getTechnicianSettlementDetails(request("Sales"), response()), /cannot perform/);
});
