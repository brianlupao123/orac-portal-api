import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { accessTechnicianSettlementDetails } from "../src/controllers/technicianSettlementController.js";
import { encryptPaymentDetails } from "../src/paymentDetails.js";

const KEY = crypto.randomBytes(32).toString("base64");

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
function request(role) {
  process.env.ORAC_PAYMENT_ENCRYPTION_KEY = KEY;
  const paymentDetails = encryptPaymentDetails({
    payment_method: "bank",
    bank_name: "Test Bank",
    bank_account: "123",
    bank_branch: "001",
    ecocash_number: "0770000000"
  });

  const db = { users: [
    { id: "admin", role: "Admin", is_active: true },
    { id: "finance", role: "Finance", is_active: true },
    { id: "sales", role: "Sales", is_active: true },
    { id: "tech", role: "Technician", is_active: true, employee_code: "EMP-001", payment_details: paymentDetails }
  ], audit_logs: [] };
  return { db, user: { id: role.toLowerCase() }, params: { id: "tech" }, store: { audit(db0, actor, type, id, action, before, after) { db0.audit_logs.push({ actor_id: actor.id, type, id, action, before, after }); } } };
}

test("Finance receives settlement details and the access is audited without values", () => {
  const req = request("Finance"); const res = response();
  accessTechnicianSettlementDetails(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.bank_account, "123");
  assert.equal(res.body.data.employee_code, "EMP-001");
  assert.equal(req.db.audit_logs[0].action, "TECHNICIAN_SETTLEMENT_DETAILS_VIEWED");
  assert.deepEqual(req.db.audit_logs[0].after.fields_returned.sort(), ["bank_account", "bank_branch", "bank_name", "ecocash_number", "payment_method"]);
  assert.equal(JSON.stringify(req.db.audit_logs[0]).includes("123"), false);
});

test("Sales cannot read technician settlement details", () => {
  assert.throws(() => accessTechnicianSettlementDetails(request("Sales"), response()), /cannot perform/);
});
