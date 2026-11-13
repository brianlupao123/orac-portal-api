import assert from "node:assert/strict";
import test from "node:test";
import { createUser, updateUser } from "../src/controllers/adminController.js";
import { roles } from "../src/permissions.js";

const res = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const store = () => ({ id: () => "new-tech", audits: [], audit(...entry) { this.audits.push(entry); } });
function db() { return { users: [
  { id: "admin", role: roles.ADMIN, is_active: true },
  { id: "finance", role: roles.FINANCE, is_active: true },
  { id: "management", role: roles.MANAGEMENT, is_active: true },
  { id: "sales", role: roles.SALES, is_active: true },
  { id: "tech", role: roles.TECHNICIAN, is_active: true }
], clients: [] }; }
const payment = { payment_method: "bank", bank_name: "Fictional Bank", bank_account: "001234", bank_branch: "001", employee_code: "PAY-001" };
test("Admin creates a Technician with settlement details but audit and response omit values", () => {
  const database = db(); const backing = store(); const response = res();
  createUser({ user: { id: "admin" }, db: database, store: backing, body: { name: "T", email: "t@fixture.invalid", password: "longenough-password", role: roles.TECHNICIAN, ...payment } }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(database.users.at(-1).bank_account, "001234");
  assert.equal(response.body.data.bank_account, undefined);
  assert.equal(JSON.stringify(backing.audits[0].at(-1)).includes("001234"), false);
});
test("only Admin can create or update payment details", () => {
  for (const actor of ["finance", "management", "sales", "tech"]) {
    assert.throws(() => updateUser({ user: { id: actor }, db: db(), store: store(), params: { id: "tech" }, body: payment }, res()), /cannot perform manageUsers/, actor);
  }
});
test("Admin update stores bank details and refuses them for a non-Technician", () => {
  const database = db(); const backing = store(); const response = res();
  updateUser({ user: { id: "admin" }, db: database, store: backing, params: { id: "tech" }, body: payment }, response);
  assert.equal(response.statusCode, 200); assert.equal(database.users.find((u) => u.id === "tech").bank_account, "001234");
  const refused = res();
  updateUser({ user: { id: "admin" }, db: database, store: backing, params: { id: "sales" }, body: payment }, refused);
  assert.equal(refused.statusCode, 400);
});
