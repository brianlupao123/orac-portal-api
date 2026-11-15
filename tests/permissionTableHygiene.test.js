import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { roles, permissions, hasPermission } from "../src/permissions.js";
import { voidInvoice } from "../src/controllers/coreController.js";
import { assignCommercialOwnership } from "../src/controllers/adminController.js";

// Lane 8 / Batch 4 - behavior-preserving permission-table hygiene. In-memory fixtures, fictional data.
const ALL = Object.values(roles);
const makeRes = () => ({ statusCode: 200, body: undefined,
  status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const usersFor = () => ALL.map((role, i) => ({ id: `u_${i}`, role, is_active: true, email: `r${i}@fx.test` }));
const dbFor = () => ({ users: usersFor(), invoices: [{ id: "inv_1", status: "issued" }, { id: "inv_paid", status: "paid" }] });

test("permissions object has no duplicate keys", () => {
  const src = readFileSync(new URL("../src/permissions.js", import.meta.url), "utf8").replace(/\r/g, "");
  const start = src.indexOf("export const permissions = {");
  assert.ok(start >= 0, "permissions object found");
  const end = src.indexOf("\n};", start);
  const keys = [...src.slice(start, end).matchAll(/^ {2}([A-Za-z0-9_]+):/gm)].map((m) => m[1]);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  assert.deepEqual([...new Set(dupes)], [], "duplicate permission keys");
  assert.ok(keys.length > 40, "sanity: parsed the real table");
});

test("settlement-detail and technician-profile lists are unchanged", () => {
  assert.deepEqual(permissions.viewTechnicianSettlementDetails, [roles.ADMIN, roles.FINANCE]);
  assert.deepEqual(permissions.viewTechnicianProfiles,
    [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.SUPERVISOR, roles.SALES]);
});

test("voidInvoice permission matches the previous hard-coded rule (Admin, Finance)", () => {
  assert.deepEqual(permissions.voidInvoice, [roles.ADMIN, roles.FINANCE]);
  for (const role of ALL) {
    const db = dbFor(); const actor = db.users.find((u) => u.role === role);
    const res = makeRes();
    voidInvoice({ db, store: { audit() {} }, user: { id: actor.id }, params: { id: "inv_1" }, body: { reason: "fixture" } }, res);
    if (role === roles.ADMIN || role === roles.FINANCE) {
      assert.equal(res.statusCode, 200, role); assert.equal(db.invoices[0].status, "voided");
    } else {
      assert.equal(res.statusCode, 403, role);
      assert.equal(res.body.message, "Only Admin or Finance can void invoices.");
      assert.equal(db.invoices[0].status, "issued", `${role} must not change the invoice`);
    }
  }
});

test("voidInvoice keeps its other rules (reason required, paid refused) and refuses an inactive Admin", () => {
  const db = dbFor(); const admin = db.users.find((u) => u.role === roles.ADMIN);
  const noReason = makeRes();
  voidInvoice({ db, store: { audit() {} }, user: { id: admin.id }, params: { id: "inv_1" }, body: {} }, noReason);
  assert.equal(noReason.statusCode, 400);
  const paid = makeRes();
  voidInvoice({ db, store: { audit() {} }, user: { id: admin.id }, params: { id: "inv_paid" }, body: { reason: "fixture" } }, paid);
  assert.equal(paid.statusCode, 409);
  admin.is_active = false;
  const inactive = makeRes();
  voidInvoice({ db, store: { audit() {} }, user: { id: admin.id }, params: { id: "inv_1" }, body: { reason: "fixture" } }, inactive);
  assert.equal(inactive.statusCode, 403);
  assert.equal(hasPermission(admin, "voidInvoice"), false);
});

test("commercial-ownership gate uses the manageCommercialOwnership permission (Admin, Management)", () => {
  assert.deepEqual(permissions.manageCommercialOwnership, [roles.ADMIN, roles.MANAGEMENT]);
  for (const role of ALL) {
    const db = dbFor(); const actor = db.users.find((u) => u.role === role);
    const res = makeRes();
    assignCommercialOwnership({ db, store: { audit() {} }, user: { id: actor.id }, body: {} }, res);
    if (role === roles.ADMIN || role === roles.MANAGEMENT) {
      assert.equal(res.statusCode, 400, `${role} passes the gate and is stopped by payload validation`);
    } else {
      assert.equal(res.statusCode, 403, role);
      assert.equal(res.body.message, "Only Admin or Management can assign commercial ownership.");
    }
  }
});
