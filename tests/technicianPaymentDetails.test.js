import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import apiRouter from "../src/router.js";
import { persistenceMiddleware } from "../src/persistenceMiddleware.js";
import { createStore } from "../src/store.js";
import { generateToken } from "../src/middleware/auth.js";

// HTTP[real router] with a JSON store on a TEMP file. Fictional data only: the account and phone
// numbers below belong to nobody.
const ROLE_USERS = {
  Admin: "u_admin", Management: "u_management", Sales: "u_sales", Finance: "u_finance",
  Operations: "u_ops", Technician: "u_tech", Supervisor: "u_supervisor", "Client Viewer": "u_client"
};
const ACCOUNT = "9990001112223";
const ECOCASH = "0770000000";
const KEY = crypto.randomBytes(32).toString("base64");

function buildApp(store) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", persistenceMiddleware(store));
  app.use("/api", apiRouter);
  app.use((err, req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
  return app;
}
async function withServer(app, run) {
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try { await run(`http://127.0.0.1:${server.address().port}/api`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}
function world() {
  const dir = mkdtempSync(join(tmpdir(), "orac-pay-http-"));
  const file = join(dir, "db.json");
  return { store: createStore(file), disk: () => readFileSync(file, "utf8"), file };
}
const tokenFor = (role) => generateToken({ id: ROLE_USERS[role], email: `${role}@fx.test`, role, is_active: true });
const call = (base, role, path, { method = "GET", body } = {}) => fetch(`${base}${path}`, {
  method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(role)}` },
  body: body === undefined ? undefined : JSON.stringify(body)
});
const json = async (r) => ({ status: r.status, body: await r.json() });
const pay = { payment_method: "bank", bank_name: "Fictional Bank", bank_account: ACCOUNT, bank_branch: "123", ecocash_number: ECOCASH };

async function withKey(run) {
  const prior = process.env.ORAC_PAYMENT_ENCRYPTION_KEY;
  process.env.ORAC_PAYMENT_ENCRYPTION_KEY = KEY;
  try { await run(); } finally { if (prior === undefined) delete process.env.ORAC_PAYMENT_ENCRYPTION_KEY; else process.env.ORAC_PAYMENT_ENCRYPTION_KEY = prior; }
}

test("payment details are refused, not stored, when no encryption key is configured", async () => {
  delete process.env.ORAC_PAYMENT_ENCRYPTION_KEY;
  const w = world();
  await withServer(buildApp(w.store), async (base) => {
    const r = await json(await call(base, "Admin", "/admin/users/u_tech", { method: "PATCH", body: pay }));
    assert.equal(r.status, 503);
    assert.ok(!w.disk().includes(ACCOUNT), "nothing was written");
  });
});

test("Admin saves payment details; they are encrypted on disk and never echoed by any user response", async () => {
  await withKey(async () => {
    const w = world();
    await withServer(buildApp(w.store), async (base) => {
      const r = await json(await call(base, "Admin", "/admin/users/u_tech", { method: "PATCH", body: pay }));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(JSON.stringify(r.body).includes(ACCOUNT), false, "update response");
      assert.equal(w.disk().includes(ACCOUNT), false, "account number is not plain text on disk");
      assert.equal(w.disk().includes(ECOCASH), false, "EcoCash number is not plain text on disk");
      assert.match(w.disk(), /"payment_details"/);
      for (const path of ["/collections/users", "/technician-profiles", "/auth/me"]) {
        const text = await (await call(base, "Admin", path)).text();
        assert.equal(text.includes(ACCOUNT) || text.includes(ECOCASH) || text.includes("payment_details"), false, path);
      }
      // A later partial update keeps the other stored fields.
      assert.equal((await call(base, "Admin", "/admin/users/u_tech", { method: "PATCH", body: { bank_branch: "999" } })).status, 200);
      const got = await json(await call(base, "Finance", "/technicians/u_tech/settlement-details/access", { method: "POST" }));
      assert.equal(got.body.data.bank_branch, "999");
      assert.equal(got.body.data.bank_account, ACCOUNT);
    });
  });
});

test("only Admin can write payment details", async () => {
  await withKey(async () => {
    const w = world();
    await withServer(buildApp(w.store), async (base) => {
      for (const role of ["Management", "Finance", "Operations", "Supervisor", "Technician", "Sales", "Client Viewer"]) {
        const r = await call(base, role, "/admin/users/u_tech", { method: "PATCH", body: pay });
        assert.equal(r.status, 403, role);
      }
      assert.equal(w.disk().includes("payment_details"), false);
    });
  });
});

test("settlement details: Admin and Finance read them, every other role gets 403, every read is audited without values", async () => {
  await withKey(async () => {
    const w = world();
    await withServer(buildApp(w.store), async (base) => {
      assert.equal((await call(base, "Admin", "/admin/users/u_tech", { method: "PATCH", body: { ...pay, employee_code: "AC24" } })).status, 200);
      for (const role of ["Management", "Operations", "Supervisor", "Technician", "Sales", "Client Viewer"]) {
        const r = await call(base, role, "/technicians/u_tech/settlement-details/access", { method: "POST" });
        assert.equal(r.status, 403, role);
        assert.equal((await r.text()).includes(ACCOUNT), false, `${role} body`);
      }
      for (const role of ["Admin", "Finance"]) {
        const r = await json(await call(base, role, "/technicians/u_tech/settlement-details/access", { method: "POST" }));
        assert.equal(r.status, 200, role);
        assert.equal(r.body.data.bank_account, ACCOUNT);
        assert.equal(r.body.data.ecocash_number, ECOCASH);
        assert.equal(r.body.data.employee_code, "AC24");
      }
      const disk = JSON.parse(w.disk());
      const views = disk.audit_logs.filter((a) => a.action === "TECHNICIAN_SETTLEMENT_DETAILS_VIEWED");
      assert.equal(views.length, 2, "one audit row per successful read");
      assert.deepEqual(views.map((v) => v.actor_id).sort(), ["u_admin", "u_finance"]);
      assert.ok(disk.audit_logs.some((a) => a.action === "ADMIN_USER_PAYMENT_DETAILS_CHANGED"));
      const auditText = JSON.stringify(disk.audit_logs);
      assert.equal(auditText.includes(ACCOUNT) || auditText.includes(ECOCASH), false, "no values in any audit payload");
      assert.equal((await call(base, "Finance", "/technicians/u_admin/settlement-details/access", { method: "POST" })).status, 404, "non-technician target");
    });
  });
});

test("the technician dropdown never carries payment details to Sales, Supervisor, Operations or Management", async () => {
  await withKey(async () => {
    const w = world();
    await withServer(buildApp(w.store), async (base) => {
      await call(base, "Admin", "/admin/users/u_tech", { method: "PATCH", body: pay });
      for (const role of ["Sales", "Supervisor", "Operations", "Management"]) {
        const text = await (await call(base, role, "/technician-profiles")).text();
        assert.equal(/bank|ecocash|payment/i.test(text), false, role);
      }
    });
  });
});
